const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { cleanupJob } = require('../../src/main/cleanup');

const projectRoot = path.join(__dirname, '..', '..');
const mainJsPath = path.join(projectRoot, 'main.js');
const mainSource = fs.readFileSync(mainJsPath, 'utf8');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function extractFunctionSnippet(source, name) {
  const startMarker = `function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const nextFunction = source.indexOf('\nfunction ', start + startMarker.length);
  return nextFunction >= 0 ? source.slice(start, nextFunction) : source.slice(start);
}

function createMockFfmpegProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr.setEncoding = () => {};
  proc.killed = false;
  return proc;
}

async function runWatchdogContract() {
  const snippets = [
    extractFunctionSnippet(mainSource, 'tailLines'),
    extractFunctionSnippet(mainSource, 'isPartialPath'),
    extractFunctionSnippet(mainSource, 'computeJobExpectedWorkMs'),
    extractFunctionSnippet(mainSource, 'runFfmpegStillImage'),
  ];
  if (snippets.some((x) => !x)) {
    fail('Watchdog contract: failed to load required render helpers from main.js.');
  }

  const script = `${snippets.join('\n')}\nmodule.exports = { runFfmpegStillImage };`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-watchdog-e2e-'));
  const audioPath = path.join(root, 'input.mp3');
  const outputPath = path.join(root, 'output.mp4.partial');
  const cleanupPartialPath = path.join(root, 'cleanup.partial');
  fs.writeFileSync(audioPath, 'audio-bytes');
  fs.writeFileSync(cleanupPartialPath, 'cleanup-bytes');

  const events = [];
  let killCalls = 0;
  let lastSpawnedProc = null;
  const context = {
    module: { exports: {} },
    exports: {},
    fs,
    FFMPEG_BIN: '/mock/ffmpeg',
    spawn: () => {
      lastSpawnedProc = createMockFfmpegProcess();
      return lastSpawnedProc;
    },
    killProcessTree: (proc) => {
      killCalls += 1;
      setTimeout(() => {
        if (proc) proc.emit('exit', 1);
      }, 0);
      return Promise.resolve();
    },
    sendRenderProgress: () => {},
    currentJob: {
      ffmpeg: null,
      cancelled: false,
      cancelReason: null,
      cleanupContext: { activeProcess: null },
    },
    REASON_CODES: {
      CANCELLED: 'CANCELLED',
      TIMEOUT: 'TIMEOUT',
      WATCHDOG_TIMEOUT: 'WATCHDOG_TIMEOUT',
      FFMPEG_EXIT_NONZERO: 'FFMPEG_EXIT_NONZERO',
      PROBE_FAILED: 'PROBE_FAILED',
      BIN_INTEGRITY_BYPASS: 'BIN_INTEGRITY_BYPASS',
      UNCAUGHT: 'UNCAUGHT',
    },
    sessionLogger: {
      info: (msg, payload) => events.push({ level: 'info', msg, payload }),
      warn: (msg, payload) => events.push({ level: 'warn', msg, payload }),
      error: (msg, payload) => events.push({ level: 'error', msg, payload }),
    },
    Date,
    Math,
    Number,
    String,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main-watchdog-contract.vm.js' });
  const { runFfmpegStillImage } = context.module.exports;

  let capturedError = null;
  try {
    await runFfmpegStillImage({
      event: { sender: { send: () => {} } },
      emitProgress: () => {},
      audioPath,
      outputPath,
      progressOutputPath: path.join(root, 'output.mp4'),
      ffmpegArgsBase: ['-i', audioPath],
      logLevel: 'error',
      trackIndex: 0,
      trackCount: 1,
      timeoutMs: 120000,
      debugLog: null,
      durationSec: 10,
      jobTotalMs: 10000,
      jobDoneMsBeforeTrack: 0,
      getHasRealSignal: () => false,
      markHasRealSignal: () => {},
      audioMode: 'copy',
      jobId: 'watchdog-job',
      jobStartedAtMs: Date.now(),
      watchdogNoProgressMs: 1100,
    });
  } catch (err) {
    capturedError = err;
  }

  assertOk(Boolean(lastSpawnedProc), 'Watchdog contract: expected ffmpeg process to be spawned.');
  assertOk(Boolean(capturedError), 'Watchdog contract: expected render helper to reject on watchdog timeout.');
  assertOk(
    capturedError.code === 'WATCHDOG_TIMEOUT',
    `Watchdog contract: expected reason code WATCHDOG_TIMEOUT, got ${capturedError?.code || '<none>'}.`
  );
  assertOk(killCalls >= 1, 'Watchdog contract: expected killProcessTree to run when watchdog fires.');

  const timeoutLog = events.find((e) => e.msg === 'render.watchdog.timeout');
  assertOk(Boolean(timeoutLog), 'Watchdog contract: expected render.watchdog.timeout structured log.');
  assertOk(timeoutLog.payload?.jobId === 'watchdog-job', 'Watchdog contract: timeout log must include jobId.');
  assertOk(timeoutLog.payload?.trackIndex === 0, 'Watchdog contract: timeout log must include trackIndex.');
  assertOk(
    Number.isFinite(timeoutLog.payload?.elapsedMs) && timeoutLog.payload.elapsedMs >= 1000,
    'Watchdog contract: timeout log must include elapsedMs.'
  );
  assertOk(
    ['none', 'time', 'size', 'both'].includes(String(timeoutLog.payload?.progressSignal || '')),
    'Watchdog contract: timeout log must include normalized progressSignal.'
  );
  assertOk(
    Object.prototype.hasOwnProperty.call(timeoutLog.payload || {}, 'lastProgressAtMs'),
    'Watchdog contract: timeout log must include lastProgressAtMs.'
  );

  const cleanupCtx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => null,
    killProcessTree: () => {},
    killWaitTimeoutMs: 250,
    currentTrackPartialPath: cleanupPartialPath,
    partialPaths: new Set([cleanupPartialPath]),
    currentTrackTmpPath: cleanupPartialPath,
    tmpPaths: new Set([cleanupPartialPath]),
    plannedFinalOutputs: new Set(),
    completedFinalOutputs: new Set(),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder: root,
    createAlbumFolder: false,
    safeRmdirIfEmpty: () => {},
    logger: null,
  };
  const cleanupStats = await cleanupJob('watchdog-job', 'WATCHDOG_TIMEOUT', cleanupCtx);
  assertOk(Boolean(cleanupStats), 'Watchdog contract: expected cleanup stats object.');
  assertOk(cleanupCtx.cleanedUp === true, 'Watchdog contract: expected cleanup to complete deterministically.');
  assertOk(!fs.existsSync(cleanupPartialPath), 'Watchdog contract: expected cleanup to remove partial artifacts.');

  assertOk(
    mainSource.includes('reasonCode === REASON_CODES.TIMEOUT || reasonCode === REASON_CODES.WATCHDOG_TIMEOUT'),
    'Watchdog contract: expected WATCHDOG_TIMEOUT to map to TIMEOUT status in main flow.'
  );
  const deterministicStatus = capturedError.code === 'CANCELLED'
    ? 'CANCELLED'
    : (capturedError.code === 'TIMEOUT' || capturedError.code === 'WATCHDOG_TIMEOUT' ? 'TIMEOUT' : 'FAILED');
  assertOk(deterministicStatus === 'TIMEOUT', 'Watchdog contract: expected deterministic TIMEOUT status mapping.');
}

(async () => {
  await runWatchdogContract();
  console.log('OK: watchdog timeout triggers deterministic cancel + cleanup on no-progress encode stall');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
