#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { renderOneTrack } = require('../engine/renderAlbum');

const PERF_RUN_SCHEMA_FAMILY = 'perfRunResult';
const PERF_RUN_SCHEMA_VERSION = 1;
const BASELINE_SCHEMA_FAMILY = 'perfBaseline';
const BASELINE_SCHEMA_VERSION = 1;

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function asInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .map((v) => Number(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function safeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function loadBaselineCase(projectRoot, baselinePath, caseId) {
  const resolvedBaselinePath = path.resolve(projectRoot, baselinePath || 'perf-baseline.json');
  if (!fs.existsSync(resolvedBaselinePath)) {
    throw new Error(`Perf baseline not found: ${resolvedBaselinePath}`);
  }

  const baseline = readJson(resolvedBaselinePath);
  if (baseline?.schemaFamily !== BASELINE_SCHEMA_FAMILY || Number(baseline?.schemaVersion) !== BASELINE_SCHEMA_VERSION) {
    throw new Error(`Unsupported perf baseline schema in ${resolvedBaselinePath}`);
  }

  const id = String(caseId || baseline?.cases?.[0]?.id || '').trim();
  if (!id) throw new Error('Missing perf case id. Use --case <id> or define at least one case in perf-baseline.json');

  const selected = (baseline.cases || []).find((entry) => String(entry?.id || '') === id);
  if (!selected) {
    const available = (baseline.cases || []).map((c) => c.id).filter(Boolean).join(', ');
    throw new Error(`Perf case not found: ${id}. Available: ${available || '(none)'}`);
  }

  const fixtureAudio = path.resolve(projectRoot, String(selected.fixture || ''));
  const fixtureImage = path.resolve(projectRoot, String(selected.image || 'fixtures/test.jpg'));

  if (!fs.existsSync(fixtureAudio)) throw new Error(`Perf fixture audio not found: ${fixtureAudio}`);
  if (!fs.existsSync(fixtureImage)) throw new Error(`Perf fixture image not found: ${fixtureImage}`);

  return {
    baselinePath: resolvedBaselinePath,
    id,
    fixtureAudio,
    fixtureImage,
    presetKey: String(selected.presetKey || 'album_ep'),
    tracks: asInt(selected.tracks, 1),
  };
}

function extractRunMetrics(report) {
  const perf = (report && typeof report === 'object') ? report.perf || {} : {};

  const finalizeSummaryTotal = safeMs(perf?.finalizeSummary?.totalMs);
  const finalizeMs = safeMs(perf?.finalizeMs);

  return {
    ffmpegWarmupMs: safeMs(perf?.ffmpegWarmupMs),
    ffmpegSpawnMs: safeMs(perf?.ffmpegSpawnMs?.avg),
    firstWriteMs: safeMs(perf?.firstWriteMs?.avg),
    firstProgressMs: safeMs(perf?.firstProgressMs?.avg),
    encodeMsTotal: safeMs(perf?.encodeMsTotal),
    finalizeMsTotal: finalizeSummaryTotal !== null ? finalizeSummaryTotal : finalizeMs,
  };
}

function aggregateMedianMetrics(runs) {
  const metricNames = [
    'ffmpegWarmupMs',
    'ffmpegSpawnMs',
    'firstWriteMs',
    'firstProgressMs',
    'encodeMsTotal',
    'finalizeMsTotal',
  ];

  const medians = {};
  metricNames.forEach((metricName) => {
    medians[metricName] = median(runs.map((run) => run?.metrics?.[metricName]));
  });
  return medians;
}

function makeSyntheticReport({ caseId, runIndex, startedAtMs, endedAtMs, encodeMsTotal }) {
  return {
    schemaFamily: 'renderReport',
    schemaVersion: 1,
    appVersion: null,
    electronVersion: null,
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    ffmpegPath: null,
    ffprobePath: null,
    ffmpegSource: 'dependency',
    ffprobeSource: null,
    ffmpegSha256: null,
    ffprobeSha256: null,
    binaryContractVersion: null,
    binaryContractKey: null,
    binaryIntegrityOk: null,
    binaryIntegrityBypassUsed: false,
    presetKey: null,
    plan: null,
    tracks: [],
    logs: {
      sessionLogPath: null,
      jobLedgerPath: null,
    },
    job: {
      id: `perf-${caseId}-run-${runIndex + 1}`,
      status: 'DONE',
      reasonCode: 'SUCCESS',
      humanMessage: '',
      startTs: new Date(startedAtMs).toISOString(),
      endTs: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    },
    cleanup: {
      cleanupDeletedTmpCount: 0,
      cleanupDeletedFinalCount: 0,
      cleanupRemovedEmptyFolder: false,
    },
    perf: {
      jobTotalMs: null,
      jobDoneMs: null,
      hasRealSignal: null,
      encodeMsTotal,
      finalizeMs: 0,
      engineFinalState: 'DONE',
      binaryIntegrityBypassUsed: false,
      ffmpegSpawnMs: { count: 0, min: null, max: null, avg: null },
      firstWriteMs: { count: 0, min: null, max: null, avg: null },
      firstProgressMs: { count: 0, min: null, max: null, avg: null },
      ffmpegWarmupMs: null,
      finalizeSummary: { renameMs: 0, writeReportMs: 0, cleanupMs: 0, totalMs: 0 },
    },
  };
}

async function runCaseEngine({
  exportBase,
  caseId,
  runIndex,
  fixtureAudio,
  fixtureImage,
  tracks,
}) {
  const exportFolder = path.join(exportBase, `${caseId}-run-${runIndex + 1}`);
  const logsDir = path.join(exportFolder, 'Logs');
  ensureDir(exportFolder);
  ensureDir(logsDir);

  let encodeMsTotal = 0;
  const startedAt = Date.now();

  for (let i = 0; i < tracks; i += 1) {
    const outputPath = path.join(exportFolder, `${String(i + 1).padStart(2, '0')}. ${caseId} run ${runIndex + 1}.mp4`);
    const trackStartedAt = Date.now();
    await renderOneTrack({
      audioPath: fixtureAudio,
      imagePath: fixtureImage,
      outputPath,
    });
    encodeMsTotal += Math.max(0, Date.now() - trackStartedAt);

    if (!fs.existsSync(outputPath)) throw new Error(`Missing output file: ${outputPath}`);
    if (fs.existsSync(`${outputPath}.partial`)) throw new Error(`Unexpected partial file left behind: ${outputPath}.partial`);
  }

  const endedAt = Date.now();
  const report = makeSyntheticReport({
    caseId,
    runIndex,
    startedAtMs: startedAt,
    endedAtMs: endedAt,
    encodeMsTotal: safeMs(encodeMsTotal),
  });
  const reportPath = path.join(logsDir, 'render-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    runIndex: runIndex + 1,
    elapsedMs: Math.max(0, endedAt - startedAt),
    reportPath,
    exportFolder,
    jobId: String(report?.job?.id || ''),
    ffmpegSha256: report?.ffmpegSha256 || null,
    ffprobeSha256: report?.ffprobeSha256 || null,
    binaryContractKey: report?.binaryContractKey || null,
    binaryIntegrityOk: report?.binaryIntegrityOk ?? null,
    metrics: extractRunMetrics(report),
  };
}

async function spawnElectronRunnerIpcMode({ baselinePath, caseId, runs, outPath }) {
  const projectRoot = path.resolve(__dirname, '..');
  const electronBinary = require('electron');
  const args = [
    __filename,
    '--runner',
    '--mode', 'ipc',
    '--baseline', baselinePath,
    '--runs', String(runs),
    '--out', outPath,
  ];
  if (caseId) args.push('--case', caseId);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
  };

  const child = spawn(electronBinary, args, { stdio: 'inherit', env, cwd: projectRoot });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[perf-run] electron exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

async function waitForWindowLoaded(BrowserWindow, timeoutMs = 20000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (!win.webContents.isLoadingMainFrame()) return win;
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      return win;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for app window to load.');
}

async function invokeRendererApi(win, methodName, payload) {
  const payloadJson = JSON.stringify(payload ?? null);
  const js = `
    (async () => {
      if (!window.api || typeof window.api.${methodName} !== 'function') {
        throw new Error('window.api.${methodName} is unavailable');
      }
      return await window.api.${methodName}(${payloadJson});
    })();
  `;
  return win.webContents.executeJavaScript(js, true);
}

async function runCaseIpc(win, {
  exportBase,
  caseId,
  runIndex,
  fixtureAudio,
  fixtureImage,
  presetKey,
  tracks,
}) {
  const exportFolder = path.join(exportBase, `${caseId}-run-${runIndex + 1}`);
  ensureDir(exportFolder);

  const trackList = [];
  for (let i = 0; i < tracks; i += 1) {
    trackList.push({
      audioPath: fixtureAudio,
      outputBase: `${String(i + 1).padStart(2, '0')}. ${caseId} run ${runIndex + 1}`,
      trackNo: i + 1,
      hasTrackNo: true,
    });
  }

  const payload = {
    imagePath: fixtureImage,
    exportFolder,
    presetKey,
    createAlbumFolder: false,
    tracks: trackList,
  };

  const startedAt = Date.now();
  const renderResult = await invokeRendererApi(win, 'renderAlbum', payload);
  if (!renderResult || renderResult.ok !== true || !renderResult.reportPath) {
    throw new Error(`renderAlbum failed on run ${runIndex + 1}: ${JSON.stringify(renderResult)}`);
  }

  const reportPath = path.resolve(renderResult.reportPath);
  if (!fs.existsSync(reportPath)) throw new Error(`Missing render report for run ${runIndex + 1}: ${reportPath}`);

  const report = readJson(reportPath);
  const metrics = extractRunMetrics(report);

  return {
    runIndex: runIndex + 1,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    reportPath,
    exportFolder,
    jobId: String(report?.job?.id || ''),
    ffmpegSha256: report?.ffmpegSha256 || null,
    ffprobeSha256: report?.ffprobeSha256 || null,
    binaryContractKey: report?.binaryContractKey || null,
    binaryIntegrityOk: report?.binaryIntegrityOk ?? null,
    metrics,
  };
}

async function runIpcInElectron({ baselinePath, caseId, runs, outPath }) {
  const { app, BrowserWindow } = require('electron');
  const projectRoot = path.resolve(__dirname, '..');

  const selectedCase = loadBaselineCase(projectRoot, baselinePath, caseId);
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-perf-run-ipc-'));
  const exportBase = path.join(runRoot, 'exports');
  ensureDir(exportBase);

  process.env.ALBUM_TO_VIDEO_EXPORT_BASE = exportBase;
  process.chdir(projectRoot);
  require(path.join(projectRoot, 'main.js'));

  await app.whenReady();
  const win = await waitForWindowLoaded(BrowserWindow);

  const allRuns = [];
  for (let i = 0; i < runs; i += 1) {
    const runResult = await runCaseIpc(win, {
      exportBase,
      caseId: selectedCase.id,
      runIndex: i,
      fixtureAudio: selectedCase.fixtureAudio,
      fixtureImage: selectedCase.fixtureImage,
      presetKey: selectedCase.presetKey,
      tracks: selectedCase.tracks,
    });
    allRuns.push(runResult);
  }

  const runtime = {
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  };

  const result = {
    schemaFamily: PERF_RUN_SCHEMA_FAMILY,
    schemaVersion: PERF_RUN_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'ipc',
    baselinePath: selectedCase.baselinePath,
    runtime,
    case: {
      id: selectedCase.id,
      fixtureAudio: selectedCase.fixtureAudio,
      fixtureImage: selectedCase.fixtureImage,
      presetKey: selectedCase.presetKey,
      tracks: selectedCase.tracks,
      runs,
    },
    metricsMedian: aggregateMedianMetrics(allRuns),
    runs: allRuns,
    runRoot,
  };

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`[perf-run] mode=ipc case=${selectedCase.id} runs=${runs}`);
  console.log(`[perf-run] runtime=${runtime.platform}-${runtime.arch} packaged=${runtime.isPackaged}`);
  console.log(`[perf-run] output=${outPath}`);

  await delay(100);
  app.quit();
}

async function runEngineMode({ baselinePath, caseId, runs, outPath }) {
  const projectRoot = path.resolve(__dirname, '..');
  const selectedCase = loadBaselineCase(projectRoot, baselinePath, caseId);

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-perf-run-engine-'));
  const exportBase = path.join(runRoot, 'exports');
  ensureDir(exportBase);

  const allRuns = [];
  for (let i = 0; i < runs; i += 1) {
    const runResult = await runCaseEngine({
      exportBase,
      caseId: selectedCase.id,
      runIndex: i,
      fixtureAudio: selectedCase.fixtureAudio,
      fixtureImage: selectedCase.fixtureImage,
      tracks: selectedCase.tracks,
    });
    allRuns.push(runResult);
  }

  const runtime = {
    platform: process.platform,
    arch: process.arch,
    isPackaged: false,
    appVersion: null,
    electronVersion: null,
  };

  const result = {
    schemaFamily: PERF_RUN_SCHEMA_FAMILY,
    schemaVersion: PERF_RUN_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'engine',
    baselinePath: selectedCase.baselinePath,
    runtime,
    case: {
      id: selectedCase.id,
      fixtureAudio: selectedCase.fixtureAudio,
      fixtureImage: selectedCase.fixtureImage,
      presetKey: selectedCase.presetKey,
      tracks: selectedCase.tracks,
      runs,
    },
    metricsMedian: aggregateMedianMetrics(allRuns),
    runs: allRuns,
    runRoot,
  };

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`[perf-run] mode=engine case=${selectedCase.id} runs=${runs}`);
  console.log(`[perf-run] runtime=${runtime.platform}-${runtime.arch}`);
  console.log(`[perf-run] output=${outPath}`);
  console.log(`[perf-run] median encodeMsTotal=${result.metricsMedian.encodeMsTotal} finalizeMsTotal=${result.metricsMedian.finalizeMsTotal}`);
  console.log(`[perf-run] median spawn=${result.metricsMedian.ffmpegSpawnMs} firstWrite=${result.metricsMedian.firstWriteMs} firstProgress=${result.metricsMedian.firstProgressMs} warmup=${result.metricsMedian.ffmpegWarmupMs}`);
}

async function main() {
  const baselinePath = getArg('--baseline', process.env.PERF_BASELINE_PATH || 'perf-baseline.json');
  const caseId = getArg('--case', process.env.PERF_CASE_ID || null);
  const runs = asInt(getArg('--runs', process.env.PERF_RUNS || '3'), 3);
  const outPathArg = getArg('--out', process.env.PERF_RESULT_PATH || path.join('dist', 'perf', 'perf-run-result.json'));
  const outPath = path.resolve(path.join(__dirname, '..'), outPathArg);
  const mode = String(getArg('--mode', process.env.PERF_MODE || 'engine') || 'engine').toLowerCase();

  if (process.argv.includes('--runner')) {
    if (mode !== 'ipc') {
      throw new Error(`--runner mode supports only --mode ipc (received ${mode})`);
    }
    await runIpcInElectron({ baselinePath, caseId, runs, outPath });
    return;
  }

  if (mode === 'ipc') {
    await spawnElectronRunnerIpcMode({ baselinePath, caseId, runs, outPath });
    return;
  }

  if (mode === 'engine') {
    await runEngineMode({ baselinePath, caseId, runs, outPath });
    return;
  }

  throw new Error(`Unsupported perf run mode: ${mode}. Use --mode engine or --mode ipc.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[perf-run] ERROR:', err?.stack || err);
    process.exit(1);
  });
}

module.exports = {
  PERF_RUN_SCHEMA_FAMILY,
  PERF_RUN_SCHEMA_VERSION,
  loadBaselineCase,
  extractRunMetrics,
  aggregateMedianMetrics,
  median,
  makeSyntheticReport,
};
