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

function safeRmdirIfEmpty(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    const removable = new Set(['.DS_Store', 'Thumbs.db']);
    entries
      .filter((name) => removable.has(name) || name.startsWith('._'))
      .forEach((name) => {
        try { fs.unlinkSync(path.join(dirPath, name)); } catch {}
      });
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  } catch {}
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
    const markers = [
      'sendRenderProgress(event.sender, {',
      'emitRenderProgressSafe({',
    ];
    let cursor = Math.max(0, Number(startIdx) || 0);
    while (cursor >= 0) {
      const hits = markers
        .map((marker) => ({ marker, idx: source.indexOf(marker, cursor) }))
        .filter((h) => h.idx >= 0)
        .sort((a, b) => a.idx - b.idx);
      if (!hits.length) return -1;
      const { marker, idx: eventIdx } = hits[0];
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
    source.includes('Math.min(0.999') && source.includes('jobExpectedWorkMs'),
    'Progress truth: expected pre-success rawProgress cap and expected-work payload.'
  );
  assertOk(
    source.includes("const mode = String(audioMode || '').toLowerCase() === 'copy' ? 'WALLCLOCK' : 'MEDIA';"),
    'Progress truth: expected deterministic WALLCLOCK/MEDIA model switch by audioMode.'
  );
  assertOk(
    source.includes('Math.max(2500, Math.min(20000, Math.max(7000, Math.floor(planned * 0.01))))'),
    'Progress truth: expected WALLCLOCK expected-work clamp policy.'
  );
  assertOk(
    source.includes('const PROGRESS_EMIT_THROTTLE_MS = 500;'),
    'Progress truth: expected regular progress throttle at 500ms.'
  );
  assertOk(
    source.includes('progressModel: finalProgressModel') && source.includes('progressModel,'),
    'Progress truth: expected progressModel in render-progress payloads.'
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
    source.includes('encodeMsTotal')
      && source.includes('ffmpegSpawnMs')
      && source.includes('firstWriteMs')
      && source.includes('firstProgressMs'),
    'Perf snapshot: expected encodeMsTotal/ffmpegSpawnMs/firstWriteMs/firstProgressMs metrics in main render pipeline.'
  );
  assertOk(
    source.includes('finalizeMs: null') && source.includes('finalizeMsTotal'),
    'Perf snapshot: expected finalizeMs fields in report snapshot and perf summary log.'
  );
  assertOk(
    source.includes('trackReport.encodeMs')
      && source.includes('trackReport.ffmpegSpawnMs')
      && source.includes('trackReport.firstWriteMs')
      && source.includes('trackReport.firstProgressMs'),
    'Perf snapshot: expected per-track encodeMs/ffmpegSpawnMs/firstWriteMs/firstProgressMs fields in report.'
  );
  assertOk(
    source.includes("sessionLogger?.info?.('ffmpeg.warmup.done'")
      && source.includes("sessionLogger?.info?.('ffmpeg.first_write'")
      && source.includes("sessionLogger?.info?.('ffmpeg.first_progress'"),
    'Perf snapshot: expected structured logs ffmpeg.warmup.done/ffmpeg.first_write/ffmpeg.first_progress.'
  );
  assertOk(
    source.includes('createEngineFsm') && source.includes('engineFinalState'),
    'Perf snapshot: expected explicit engine FSM and engineFinalState snapshot.'
  );
  assertOk(
    source.includes('assertCanEmitProgress()') && source.includes('assertCanMutateMetrics'),
    'Perf snapshot: expected FSM guards for post-terminal progress and metrics mutation.'
  );
  assertOk(
    source.includes('Math.max(0, firstWriteAtMs - ffmpegSpawnedAtMs)')
      && source.includes('Math.max(0, firstProgressAtMs - ffmpegSpawnedAtMs)'),
    'Perf snapshot: expected firstWriteMs/firstProgressMs to be clamped to sane non-negative ranges.'
  );
  assertOk(
    source.includes('progressStatusTail: getRenderSignalsTail(MAX_LOG_EVENTS)'),
    'Perf snapshot: expected diagnostics export to include progress/status tail.'
  );
  assertOk(
    source.includes('FFMPEG_SHA256') && source.includes('FFPROBE_SHA256'),
    'Perf snapshot: expected engine snapshot to include ffmpeg/ffprobe sha256 fields.'
  );
  assertOk(
    source.includes('ffmpegSha256') && source.includes('ffprobeSha256'),
    'Perf snapshot: expected render report to include ffmpegSha256/ffprobeSha256.'
  );
  assertOk(
    source.includes('binaryIntegrityBypassUsed'),
    'Perf snapshot: expected render report/perf snapshot to include binaryIntegrityBypassUsed stamp.'
  );
  assertOk(
    source.includes('ensureBinaryIntegrityContract({ strictPackaged: app.isPackaged })')
      && source.includes('bin.integrity.fail'),
    'Perf snapshot: expected packaged binary integrity enforcement + structured failure log.'
  );
  assertOk(
    source.includes('bin.integrity.bypassed') && source.includes('BIN_INTEGRITY_BYPASS'),
    'Perf snapshot: expected explicit integrity bypass logging + diagnostics-only render block.'
  );
  assertOk(
    source.includes('createJobLedger(')
      && source.includes('completeJobLedger(')
      && source.includes('runStartupJobRecovery()')
      && source.includes('startupRecoveryPromise'),
    'Perf snapshot: expected crash-safe job ledger lifecycle + startup recovery wiring.'
  );
  assertOk(
    source.includes('schemaFamily: RENDER_REPORT_SCHEMA_FAMILY')
      && source.includes('schemaVersion: RENDER_REPORT_SCHEMA_VERSION'),
    'Perf snapshot: expected render report schemaFamily/schemaVersion stamping.'
  );
  assertOk(
    source.includes('schema.missing') && source.includes('schema.unsupported'),
    'Perf snapshot: expected schema.missing/schema.unsupported structured logs in main flow.'
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
  assertOk(
    !source.includes("overallPercent.textContent = '--'"),
    'Renderer export contract: progress must never show -- placeholder.'
  );
  assertOk(
    !source.includes('INDETERMINATE'),
    'Renderer export contract: indeterminate progress mode should be removed.'
  );
  assertOk(
    /const\s+PROGRESS_CAP_FINISHING\s*=\s*0\.995\s*;/.test(source)
      && /progressTarget\s*=\s*Math\.max\(\s*progressTarget\s*,\s*PROGRESS_CAP_FINISHING\s*,\s*progressDisplay\s*\)\s*;/.test(source),
    'Renderer export contract: finalizing should force target to >= 99% and cap to 99.5%.'
  );
  [
    'id="btn-add"',
    'id="btn-clear"',
    'id="btn-art"',
    'id="btn-folder"',
    'id="btn-export"',
    'id="btn-cancel"',
    'id="btn-new"',
    'id="select-preset"',
    'id="chk-folder"',
    'id="input-folder-name"',
    'id="track-list"',
    'id="tracks-body"',
    'id="cover-img"',
    'id="folder-path"',
    'id="progress-wrap"',
    'id="prog-fill"',
    'id="prog-pct"',
    'id="st-txt"',
    'id="btn-open-folder"',
    'id="btn-open-logs"',
  ].forEach((selectorMarker) => {
    assertOk(
      source.includes(selectorMarker),
      `Renderer export contract: expected renderer selector ${selectorMarker}.`
    );
  });
  assertOk(
    source.includes('window.__frenderTestHooks'),
    'Renderer export contract: expected renderer test hooks for runtime layout assertions.'
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
    safeRmdirIfEmpty,
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

function createMemoryLogger(events) {
  return {
    info: (msg, payload) => events.push({ level: 'info', msg, payload }),
    warn: (msg, payload) => events.push({ level: 'warn', msg, payload }),
    error: (msg, payload) => events.push({ level: 'error', msg, payload }),
  };
}

async function runCleanupNoOutputFolderGuardTest() {
  const events = [];
  const ctx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => null,
    killProcessTree: () => {},
    killWaitTimeoutMs: 300,
    currentTrackPartialPath: null,
    partialPaths: new Set(),
    currentTrackTmpPath: null,
    tmpPaths: new Set(),
    plannedFinalOutputs: new Set(),
    completedFinalOutputs: new Set(),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder: undefined,
    createAlbumFolder: true,
    safeRmdirIfEmpty: () => {
      throw new Error('cleanup no-outputFolder guard failed: safeRmdirIfEmpty should not be called');
    },
    logger: createMemoryLogger(events),
  };

  const stats = await cleanupJob('cleanup-no-outputfolder-e2e', 'CANCELLED', ctx);
  assertOk(Boolean(stats), 'Cleanup guard: expected cleanupJob to return stats when outputFolder is undefined.');
  assertOk(ctx.cleanedUp === true, 'Cleanup guard: expected cleanedUp=true even when outputFolder is undefined.');
  assertOk(
    events.some((e) => e.msg === 'cleanup.skipped_no_outputFolder'),
    'Cleanup guard: expected cleanup.skipped_no_outputFolder log event.'
  );

  console.log('OK: cleanupJob skips folder removal safely when outputFolder is undefined');
}

async function runCleanupDeleteFailureObservabilityTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-cleanup-delete-fail-e2e-'));
  const stuckTmp = path.join(root, 'stuck.partial');
  fs.writeFileSync(stuckTmp, 'locked');

  const originalUnlinkSync = fs.unlinkSync;
  const events = [];
  fs.unlinkSync = (targetPath) => {
    if (path.resolve(String(targetPath || '')) === path.resolve(stuckTmp)) {
      const err = new Error('resource busy');
      err.code = 'EBUSY';
      throw err;
    }
    return originalUnlinkSync(targetPath);
  };

  try {
    const ctx = {
      cleanedUp: false,
      cleanupStats: null,
      cleanupPromise: null,
      getActiveProcess: () => null,
      killProcessTree: () => {},
      killWaitTimeoutMs: 300,
      currentTrackPartialPath: stuckTmp,
      partialPaths: new Set([stuckTmp]),
      currentTrackTmpPath: stuckTmp,
      tmpPaths: new Set([stuckTmp]),
      plannedFinalOutputs: new Set(),
      completedFinalOutputs: new Set(),
      stagingPaths: new Set(),
      stagingClosers: new Set(),
      outputFolder: root,
      createAlbumFolder: false,
      safeRmdirIfEmpty,
      logger: createMemoryLogger(events),
    };

    const stats = await cleanupJob('cleanup-delete-fail-e2e', 'CANCELLED', ctx);
    assertOk(stats.cleanupDeleteFailedCount >= 1, 'Cleanup observability: expected delete failure count >= 1.');
    assertOk(stats.cleanupDeleteFailedExamples.length >= 1, 'Cleanup observability: expected failed delete examples to be recorded.');
    assertOk(
      events.some((e) => e.msg === 'cleanup.delete_failed'),
      'Cleanup observability: expected cleanup.delete_failed warning log.'
    );
    assertOk(
      fs.existsSync(stuckTmp),
      'Cleanup observability: expected failed delete path to remain when unlink throws.'
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  console.log('OK: cleanupJob reports delete failures with count and examples');
}

async function runCleanupPromiseNeverRejectsTest() {
  const events = [];
  const ctx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => {
      throw new Error('simulated cleanup internal failure');
    },
    killProcessTree: () => {},
    killWaitTimeoutMs: 300,
    currentTrackPartialPath: null,
    partialPaths: new Set(),
    currentTrackTmpPath: null,
    tmpPaths: new Set(),
    plannedFinalOutputs: new Set(),
    completedFinalOutputs: new Set(),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder: undefined,
    createAlbumFolder: false,
    safeRmdirIfEmpty,
    logger: createMemoryLogger(events),
  };

  let didReject = false;
  let stats = null;
  try {
    stats = await cleanupJob('cleanup-no-reject-e2e', 'FAILED', ctx);
  } catch {
    didReject = true;
  }

  assertOk(didReject === false, 'Cleanup no-reject: cleanupJob promise must never reject.');
  assertOk(Boolean(stats), 'Cleanup no-reject: expected stats object returned on internal failure.');
  assertOk(
    events.some((e) => e.msg === 'cleanup.unhandled_error'),
    'Cleanup no-reject: expected cleanup.unhandled_error log on caught internal failure.'
  );
  assertOk(
    events.some((e) => e.msg === 'cleanup.end' && e.payload?.cleanupUnhandledError === true),
    'Cleanup no-reject: expected cleanup.end with cleanupUnhandledError=true.'
  );

  console.log('OK: cleanupJob catches internal errors and never rejects');
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

function runReliabilityFreezeGuardTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');

  assertOk(
    source.includes('function safeSendToRenderer(')
      && source.includes("safeSendToRenderer(sender, 'render-status', payload);")
      && source.includes("safeSendToRenderer(sender, 'render-progress', payload);"),
    'Reliability freeze: expected sender-destroyed guard for render IPC sends.'
  );

  assertOk(
    source.includes("mainWindow.webContents.setWindowOpenHandler")
      && source.includes('security.window_open_blocked')
      && source.includes("mainWindow.webContents.on('will-navigate'")
      && source.includes('security.navigation_blocked'),
    'Reliability freeze: expected window.open + navigation hard-block guards.'
  );

  assertOk(
    source.includes('function assertOutputPathNotExists(')
      && source.includes('assertOutputPathNotExists(outputFinalPath);'),
    'Reliability freeze: expected explicit no-overwrite guard before partial->final move.'
  );

  assertOk(
    source.includes('finalizing.rename_outputs')
      && source.includes('finalizing.post_rename')
      && source.includes('finalizing.pre_success'),
    'Reliability freeze: expected finalizing cancel checkpoints.'
  );
  assertOk(
    source.includes('phase === JOB_PHASES.FINALIZING')
      && source.includes('deferredCleanup: true')
      && source.includes('waitForCurrentJobToSettle'),
    'Reliability freeze: expected deferred finalizing cleanup + lifecycle settle wait.'
  );

  assertOk(
    source.includes('const reasonCode = currentJob.cancelled')
      && source.includes('currentJob.cancelReason || reasonCodeFromError(err)'),
    'Reliability freeze: expected cancel reason precedence during failure classification.'
  );

  assertOk(
    source.includes("cleaned.normalize('NFC')"),
    'Reliability freeze: expected unicode normalization for output base names.'
  );

  console.log('OK: reliability freeze guards enforce sender safety, nav blocking, no-overwrite, and cancel checkpoints');
}

function runIpcSenderGuardRuntimeTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  const isSenderAliveSnippet = extractFunctionSnippet(source, 'isIpcSenderAlive');
  const safeSendSnippet = extractFunctionSnippet(source, 'safeSendToRenderer');
  if (!isSenderAliveSnippet || !safeSendSnippet) {
    fail('IPC sender guard runtime: failed to load sender guard functions from main.js.');
  }

  const script = `
${isSenderAliveSnippet}
function logIpcSendWarning() {}
${safeSendSnippet}
module.exports = { isIpcSenderAlive, safeSendToRenderer };
`;
  const context = {
    module: { exports: {} },
    exports: {},
    String,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main-ipc-sender-guards.vm.js' });
  const { isIpcSenderAlive, safeSendToRenderer } = context.module.exports;

  assertOk(isIpcSenderAlive(null) === false, 'IPC sender guard runtime: null sender must be rejected.');
  assertOk(
    isIpcSenderAlive({ send: () => {}, isDestroyed: () => true }) === false,
    'IPC sender guard runtime: destroyed sender must be rejected.'
  );
  assertOk(
    isIpcSenderAlive({ send: () => {}, isDestroyed: () => false }) === true,
    'IPC sender guard runtime: live sender should be accepted.'
  );

  const seen = [];
  const liveSender = {
    isDestroyed: () => false,
    send: (channel, payload) => seen.push({ channel, payload }),
  };
  assertOk(
    safeSendToRenderer(liveSender, 'render-status', { phase: 'rendering' }) === true,
    'IPC sender guard runtime: safeSendToRenderer should return true for live sender.'
  );
  assertOk(seen.length === 1 && seen[0].channel === 'render-status', 'IPC sender guard runtime: expected forwarded payload.');
  assertOk(
    safeSendToRenderer({ isDestroyed: () => true, send: () => { throw new Error('should not send'); } }, 'render-progress', {}) === false,
    'IPC sender guard runtime: destroyed sender must return false and avoid throw.'
  );
  assertOk(
    safeSendToRenderer({ send: () => { throw new Error('boom'); }, isDestroyed: () => false }, 'render-progress', {}) === false,
    'IPC sender guard runtime: send failures must be swallowed and reported as false.'
  );

  console.log('OK: IPC sender guard runtime prevents throw on destroyed/failing sender');
}

function runOutputNoOverwriteRuntimeTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  const assertNoOverwriteSnippet = extractFunctionSnippet(source, 'assertOutputPathNotExists');
  const moveSnippet = extractFunctionSnippet(source, 'movePartialToFinalOutput');
  if (!assertNoOverwriteSnippet || !moveSnippet) {
    fail('Output no-overwrite runtime: failed to load finalize helpers from main.js.');
  }

  const script = `
${assertNoOverwriteSnippet}
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}
const REASON_CODES = { UNCAUGHT: 'UNCAUGHT' };
${moveSnippet}
module.exports = { movePartialToFinalOutput };
`;
  const context = {
    module: { exports: {} },
    exports: {},
    fs,
    process,
    Date,
    String,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main-output-no-overwrite.vm.js' });
  const { movePartialToFinalOutput } = context.module.exports;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-no-overwrite-e2e-'));
  const partialPath = path.join(root, 'out.mp4.partial');
  const outputFinalPath = path.join(root, 'out.mp4');
  fs.writeFileSync(partialPath, 'partial-bytes');
  fs.writeFileSync(outputFinalPath, 'existing-final');

  let threw = false;
  try {
    movePartialToFinalOutput(partialPath, outputFinalPath);
  } catch (err) {
    threw = true;
    assertOk(
      String(err?.message || '').includes('Final output already exists'),
      'Output no-overwrite runtime: expected explicit no-overwrite error message.'
    );
  }
  assertOk(threw, 'Output no-overwrite runtime: expected move to fail when final file exists.');
  assertOk(fs.existsSync(outputFinalPath), 'Output no-overwrite runtime: existing final file must remain untouched.');
  assertOk(fs.existsSync(partialPath), 'Output no-overwrite runtime: partial file must remain for explicit cleanup path.');

  console.log('OK: output finalize helper blocks overwrite when final file already exists');
}

function runPresetEngineVideoGuardTest() {
  const source = fs.readFileSync(mainJsPath, 'utf8');
  const buildFfmpegArgsBaseSnippet = extractFunctionSnippet(source, 'buildFfmpegArgsBase');
  if (!buildFfmpegArgsBaseSnippet) {
    fail('Preset guard runtime: failed to load buildFfmpegArgsBase from main.js.');
  }

  const script = `
${buildFfmpegArgsBaseSnippet}
module.exports = { buildFfmpegArgsBase };
`;
  const events = [];
  const context = {
    module: { exports: {} },
    exports: {},
    getPreset: () => ({
      key: 'broken_preset',
      engine: {
        video: ['-c:v', 'libx264'],
        vf: null,
      },
    }),
    GLOBAL_FPS: 1,
    REASON_CODES: { UNCAUGHT: 'UNCAUGHT' },
    sessionLogger: {
      error: (msg, payload) => events.push({ msg, payload }),
    },
    String,
    Error,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main-preset-video-guard.vm.js' });
  const { buildFfmpegArgsBase } = context.module.exports;

  let threw = false;
  try {
    buildFfmpegArgsBase({
      imagePath: '/tmp/cover.jpg',
      audioPath: '/tmp/audio.mp3',
      presetKey: 'broken_preset',
      audioMode: 'copy',
    });
  } catch (err) {
    threw = true;
    assertOk(err?.code === 'UNCAUGHT', 'Preset guard runtime: expected UNCAUGHT code for invalid preset.engine.video.');
    assertOk(
      String(err?.message || '').includes('preset.engine.video must be a function'),
      'Preset guard runtime: expected explicit preset.engine.video function requirement message.'
    );
  }
  assertOk(threw, 'Preset guard runtime: expected buildFfmpegArgsBase to throw when preset.engine.video is not a function.');
  assertOk(
    events.some((e) => e.msg === 'preset.engine.video.invalid'),
    'Preset guard runtime: expected preset.engine.video.invalid structured log.'
  );

  console.log('OK: preset engine.video guard rejects non-function values deterministically');
}

(async () => {
  runProgressTruthPolicyTest();
  runPerfSnapshotContractTest();
  runRendererExportContractTest();
  await runCancelFinalizingCleanupTest();
  await runCleanupNoOutputFolderGuardTest();
  await runCleanupDeleteFailureObservabilityTest();
  await runCleanupPromiseNeverRejectsTest();
  runIpcPathHardeningTest();
  runReliabilityFreezeGuardTest();
  runIpcSenderGuardRuntimeTest();
  runOutputNoOverwriteRuntimeTest();
  runPresetEngineVideoGuardTest();
  console.log('E2E hardening tests completed successfully');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
