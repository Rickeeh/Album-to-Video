const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { cleanupJob } = require('../../src/main/cleanup');

const projectRoot = path.join(__dirname, '..', '..');
const mainJsPath = path.join(projectRoot, 'main.js');
const indexHtmlPath = path.join(projectRoot, 'index.html');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function createJsonlLogger(filePath) {
  const write = (level, msg, data) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data && typeof data === 'object' ? data : {}),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  };
  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}

function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

async function waitUntil(checkFn, { timeoutMs = 5000, intervalMs = 50, timeoutMessage = 'timeout' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (checkFn()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(timeoutMessage);
}

function runProgressTruthPolicyTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  const findRenderProgressEventWithPhaseAfter = (phase, startIdx) => {
    const marker = 'sendRenderProgress(event.sender, {';
    let cursor = Math.max(0, Number(startIdx) || 0);
    while (cursor >= 0) {
      const eventIdx = source.indexOf(marker, cursor);
      if (eventIdx < 0) return -1;
      const endMatch = source.slice(eventIdx).match(/\}\);\s*/);
      const blockEnd = endMatch
        ? eventIdx + endMatch.index + endMatch[0].length
        : (eventIdx + marker.length);
      const block = source.slice(eventIdx, blockEnd);
      if (block.includes(`phase: '${phase}'`)) return eventIdx;
      cursor = eventIdx + marker.length;
    }
    return -1;
  };

  // Guard 1: run-time payload builder always caps pre-success total to < 100.
  assertOk(
    source.includes('Math.max(0, Math.min(99.9, rawProgress * 100))'),
    'Progress truth: expected percentTotal cap to 99.9 in run-time payload builder.'
  );

  // Guard 2: explicit finalizing payload is capped to 99.9.
  assertOk(
    source.includes("phase: 'FINALIZING'") && source.includes('percentTotal: 99.9'),
    'Progress truth: expected FINALIZING payload to set percentTotal=99.9.'
  );
  assertOk(
    source.includes('progressSignal: getJobProgressSignal()'),
    'Progress truth: expected FINALIZING payload to include progressSignal.'
  );
  assertOk(
    source.includes('Math.min(0.999, jobDoneMs / jobTotalMs)'),
    'Progress truth: expected FINALIZING rawProgress cap below 1.0 before success.'
  );

  // Guard 3: success status happens only after explicit FINALIZING progress emission.
  const idxFinalizingStatus = source.indexOf("sendRenderStatus(event.sender, { phase: 'finalizing' });");
  const idxFinalizingProgress = findRenderProgressEventWithPhaseAfter('FINALIZING', idxFinalizingStatus);
  const idxSuccessStatus = source.indexOf("sendRenderStatus(event.sender, { phase: 'success' });");
  const idxFinalizeStart = source.indexOf("emitFinalizeStep(jobId, 'finalize.start'");
  const idxFinalizeRenameStart = source.indexOf("emitFinalizeStep(jobId, 'finalize.rename_outputs.start'");
  const idxFinalizeRenameMethod = source.indexOf("emitFinalizeStep(jobId, 'finalize.rename_outputs.method'");
  const idxFinalizeRenameEnd = source.indexOf("emitFinalizeStep(jobId, 'finalize.rename_outputs.end'");
  const idxFinalizeReportStart = source.indexOf("emitFinalizeStep(jobId, 'finalize.write_report.start'");
  const idxFinalizeReportEnd = source.indexOf("emitFinalizeStep(jobId, 'finalize.write_report.end'");
  const idxFinalizeCleanupStart = source.indexOf("emitFinalizeStep(jobId, 'finalize.cleanup.start'");
  const idxFinalizeCleanupEnd = source.indexOf("emitFinalizeStep(jobId, 'finalize.cleanup.end'");
  const idxFinalizeSummary = source.indexOf("emitFinalizeStep(jobId, 'finalize.summary'");
  const idxFinalizeEnd = source.indexOf("emitFinalizeStep(jobId, 'finalize.end'");
  const idxRenderSuccessLog = source.indexOf("sessionLogger?.info('render.success'");
  const idxStartupPartialScan = source.indexOf("sessionLogger?.info?.('startup.partial_scan'");
  const idxStartupFoundCount = source.indexOf('foundCount: matches.length');
  assertOk(idxFinalizingStatus >= 0, 'Progress truth: missing finalizing status emission.');
  assertOk(idxFinalizingProgress >= 0, 'Progress truth: missing finalizing progress emission.');
  assertOk(idxSuccessStatus >= 0, 'Progress truth: missing success status emission.');
  assertOk(
    idxFinalizingStatus < idxFinalizingProgress && idxFinalizingProgress < idxSuccessStatus,
    'Progress truth: expected order finalizing status -> finalizing progress -> success status.'
  );
  [
    idxFinalizeStart,
    idxFinalizeRenameStart,
    idxFinalizeRenameMethod,
    idxFinalizeRenameEnd,
    idxFinalizeReportStart,
    idxFinalizeReportEnd,
    idxFinalizeCleanupStart,
    idxFinalizeCleanupEnd,
    idxFinalizeSummary,
    idxFinalizeEnd,
    idxRenderSuccessLog,
    idxStartupPartialScan,
    idxStartupFoundCount,
  ].forEach((idx) => assertOk(idx >= 0, 'Progress truth: missing finalize structured marks or render.success log.'));
  assertOk(
    idxFinalizeStart < idxFinalizeRenameStart
    && idxFinalizeRenameStart < idxFinalizeRenameMethod
    && idxFinalizeRenameMethod < idxFinalizeRenameEnd
    && idxFinalizeRenameEnd < idxFinalizeReportStart
    && idxFinalizeReportStart < idxFinalizeReportEnd
    && idxFinalizeReportEnd < idxFinalizeCleanupStart
    && idxFinalizeCleanupStart < idxFinalizeCleanupEnd
    && idxFinalizeCleanupEnd < idxFinalizeSummary
    && idxFinalizeSummary < idxFinalizeEnd
    && idxFinalizeEnd < idxRenderSuccessLog
    && idxRenderSuccessLog < idxSuccessStatus,
    'Progress truth: expected finalize.* sequence before render.success and success status.'
  );

  console.log('OK: progress truth policy keeps pre-success progress below 100 and finalizes before success');
}

function runPerfSnapshotContractTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  assertOk(
    source.includes('encodeMsTotal') && source.includes('ffmpegSpawnMs'),
    'Perf snapshot: expected encodeMsTotal/ffmpegSpawnMs metrics in main render pipeline.'
  );
  assertOk(
    source.includes('trackReport.encodeMs') && source.includes('trackReport.ffmpegSpawnMs'),
    'Perf snapshot: expected per-track encodeMs/ffmpegSpawnMs fields in report.'
  );
  assertOk(
    source.includes('progressStatusTail: getRenderSignalsTail(MAX_LOG_EVENTS)'),
    'Perf snapshot: expected diagnostics export to include progress/status tail.'
  );
  console.log('OK: perf snapshot contract present in render report + diagnostics export');
}

function runRendererExportContractTest() {
  const source = fs.readFileSync(indexHtmlPath, 'utf8');
  assertOk(
    !source.includes('window.api.invoke('),
    'Renderer export contract: legacy window.api.invoke must not be used.'
  );
  assertOk(
    source.includes('ui.export_click'),
    'Renderer export contract: expected ui.export_click log.'
  );
  assertOk(
    source.includes('ui.export_invoke'),
    'Renderer export contract: expected ui.export_invoke log before IPC.'
  );
  assertOk(
    source.includes('ui.export_failed'),
    'Renderer export contract: expected ui.export_failed log for never-silent failures.'
  );
  assertOk(
    source.includes('window.api.renderAlbum(payload)'),
    'Renderer export contract: export path must invoke window.api.renderAlbum(payload).'
  );
  console.log('OK: renderer export contract uses explicit renderAlbum path with never-silent logs');
}

async function runCancelFinalizingCleanupTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-cancel-finalizing-e2e-'));
  const baseExportFolder = path.join(root, 'exports');
  const outputFolder = path.join(baseExportFolder, 'Release');
  const logsFolder = path.join(outputFolder, 'Logs');
  const auditLogPath = path.join(root, 'cleanup-audit.jsonl');

  fs.mkdirSync(logsFolder, { recursive: true });

  const plannedFinalOutputs = [
    path.join(outputFolder, '01. Completed.mp4'),
    path.join(outputFolder, '02. InProgress.mp4'),
    path.join(outputFolder, '03. Planned.mp4'),
  ];
  const currentTrackPartialPath = `${plannedFinalOutputs[1]}.partial`;
  const reportPath = path.join(logsFolder, 'render-report.json');

  // Simulate "cancel at finalizing": completed + in-progress + report present.
  fs.writeFileSync(plannedFinalOutputs[0], 'completed');
  fs.writeFileSync(plannedFinalOutputs[1], 'partial');
  fs.writeFileSync(currentTrackPartialPath, 'tmp');
  fs.writeFileSync(reportPath, '{}');

  const ctx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => null,
    killProcessTree: () => {},
    killWaitTimeoutMs: 300,
    currentTrackPartialPath,
    partialPaths: new Set([currentTrackPartialPath]),
    currentTrackTmpPath: currentTrackPartialPath,
    tmpPaths: new Set([currentTrackPartialPath]),
    plannedFinalOutputs: new Set(plannedFinalOutputs),
    completedFinalOutputs: new Set([plannedFinalOutputs[0]]),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder,
    baseExportFolder,
    createAlbumFolder: true,
    safeRmdirIfEmpty: () => {},
    logger: createJsonlLogger(auditLogPath),
  };

  await cleanupJob('cancel-finalizing-e2e', 'CANCELLED', ctx);

  // Deterministic wait by log signal (no fixed sleep).
  await waitUntil(
    () => fs.existsSync(auditLogPath) && readJsonl(auditLogPath).some((e) => e.msg === 'cleanup.end'),
    {
      timeoutMs: 5000,
      intervalMs: 50,
      timeoutMessage: 'Cancel finalizing: timed out waiting for cleanup.end in JSONL log.',
    }
  );

  // Filesystem end-state must be clean.
  assertOk(!fs.existsSync(plannedFinalOutputs[0]), 'Cancel finalizing: expected completed output removed.');
  assertOk(!fs.existsSync(plannedFinalOutputs[1]), 'Cancel finalizing: expected in-progress output removed.');
  assertOk(!fs.existsSync(plannedFinalOutputs[2]), 'Cancel finalizing: expected planned output absent.');
  assertOk(!fs.existsSync(currentTrackPartialPath), 'Cancel finalizing: expected partial output removed.');
  assertOk(!fs.existsSync(reportPath), 'Cancel finalizing: expected render report removed.');
  assertOk(!fs.existsSync(outputFolder), 'Cancel finalizing: expected release folder removed.');

  // Structured JSONL evidence.
  const entries = readJsonl(auditLogPath);
  const start = entries.find((e) => e.msg === 'cleanup.start');
  const end = entries.find((e) => e.msg === 'cleanup.end');
  assertOk(Boolean(start), 'Cancel finalizing: expected cleanup.start in JSONL log.');
  assertOk(Boolean(end), 'Cancel finalizing: expected cleanup.end in JSONL log.');
  assertOk(end.reason === 'CANCELLED', 'Cancel finalizing: cleanup.end reason must be CANCELLED.');
  assertOk(end.cleanupRemovedEmptyFolder === true, 'Cancel finalizing: expected cleanupRemovedEmptyFolder=true.');
  assertOk(
    Object.prototype.hasOwnProperty.call(end, 'cleanupDeletedTmpCount'),
    'Cancel finalizing: expected cleanupDeletedTmpCount field in cleanup.end.'
  );
  assertOk(
    Number(end.cleanupDeletedFinalCount || 0) >= 2,
    'Cancel finalizing: expected deleted final outputs count to include completed/in-progress files.'
  );

  console.log('OK: cancel at finalizing cleans outputs, report, and removes empty release folder');
}

function extractFunctionSnippet(source, name) {
  const startMarker = `function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const nextFunction = source.indexOf('\nfunction ', start + startMarker.length);
  return nextFunction >= 0 ? source.slice(start, nextFunction) : source.slice(start);
}

function runIpcPathHardeningTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  const snippets = [
    extractFunctionSnippet(source, 'isBlockedWindowsPath'),
    extractFunctionSnippet(source, 'isBlockedUnixPath'),
    extractFunctionSnippet(source, 'assertAbsolutePath'),
    extractFunctionSnippet(source, 'isPathWithinBase'),
    extractFunctionSnippet(source, 'assertPathWithinBase'),
  ];
  if (snippets.some((x) => !x)) {
    fail('IPC path hardening: failed to load path helper functions from main.js.');
  }

  const script = `${snippets.join('\n')}\nmodule.exports = { assertAbsolutePath, assertPathWithinBase };`;
  const compile = (platform, pathModule) => {
    const context = {
      module: { exports: {} },
      exports: {},
      process: { platform },
      path: pathModule,
      String,
    };
    vm.createContext(context);
    vm.runInContext(script, context, { filename: 'main-path-helpers.vm.js' });
    return context.module.exports;
  };

  const winApi = compile('win32', path.win32);
  const unixApi = compile('linux', path.posix);
  const assertAbsolutePathWin = winApi.assertAbsolutePath;
  const assertPathWithinBaseWin = winApi.assertPathWithinBase;
  const assertAbsolutePathUnix = unixApi.assertAbsolutePath;

  const rejectWin = [
    '\\\\?\\C:\\Temp\\track.mp3',
    '\\\\.\\C:\\Temp\\track.mp3',
    '\\\\server\\share\\track.mp3',
    '..\\..',
  ];
  rejectWin.forEach((candidate) => {
    let threw = false;
    try {
      assertAbsolutePathWin(candidate, 'Audio file');
    } catch {
      threw = true;
    }
    assertOk(threw, `IPC path hardening: expected Windows path to be rejected (${candidate}).`);
  });

  // Even absolute root must fail boundary checks when handler anchors to selected export folder.
  let rootBoundaryRejected = false;
  try {
    assertPathWithinBaseWin('C:\\Exports', 'C:\\', 'Export folder');
  } catch {
    rootBoundaryRejected = true;
  }
  assertOk(rootBoundaryRejected, 'IPC path hardening: expected C:\\ root to fail boundary check.');

  const rejectUnix = ['/dev/null', '/proc/cpuinfo', '/sys/kernel'];
  rejectUnix.forEach((candidate) => {
    let threw = false;
    try {
      assertAbsolutePathUnix(candidate, 'Audio file');
    } catch {
      threw = true;
    }
    assertOk(threw, `IPC path hardening: expected Unix system path to be rejected (${candidate}).`);
  });

  const safeUnix = assertAbsolutePathUnix('/tmp/album-to-video-safe', 'Audio file');
  assertOk(
    String(safeUnix).includes('/tmp/album-to-video-safe'),
    'IPC path hardening: expected safe absolute Unix path to pass.'
  );

  console.log('OK: IPC path hardening rejects device/UNC/system paths');
}

(async () => {
  runProgressTruthPolicyTest();
  runPerfSnapshotContractTest();
  runRendererExportContractTest();
  await runCancelFinalizingCleanupTest();
  runIpcPathHardeningTest();
  console.log('E2E hardening tests completed successfully');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
