#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function safeAvg(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

function parseLogEvent(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const payload = (entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload))
    ? entry.payload
    : {};
  const data = { ...payload };
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'ts' || key === 'level' || key === 'msg' || key === 'payload' || key === 'kind') continue;
    data[key] = value;
  }
  return {
    ts: entry.ts || null,
    level: entry.level || null,
    msg: entry.msg || null,
    data,
  };
}

function parseLogEvents(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => parseLogEvent(entry))
    .filter(Boolean);
}

function findLastWarmupEvent(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.msg !== 'ffmpeg.warmup.done') continue;
    return e;
  }
  return null;
}

function findFirstJobEvent(events, { msg, jobId }) {
  const targetMsg = String(msg || '');
  const targetJobId = String(jobId || '');
  if (!targetMsg || !targetJobId) return null;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e?.msg !== targetMsg) continue;
    if (String(e?.data?.jobId || '') === targetJobId) return e;
  }
  return null;
}

function resolveSessionLogPath(report, diagnostics) {
  const candidates = [
    report?.logs?.sessionLogPath,
    diagnostics?.logs?.sessionLogPath,
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || null;
}

function extractCaseSignals(events, jobId) {
  const warmupEvent = findLastWarmupEvent(events);
  const firstWriteEvent = findFirstJobEvent(events, { msg: 'ffmpeg.first_write', jobId });
  const firstProgressEvent = findFirstJobEvent(events, { msg: 'ffmpeg.first_progress', jobId });
  const missing = [];
  if (!warmupEvent) missing.push('missing event ffmpeg.warmup.done');
  if (!firstWriteEvent) missing.push(`missing event ffmpeg.first_write for jobId=${jobId}`);
  if (!firstProgressEvent) missing.push(`missing event ffmpeg.first_progress for jobId=${jobId}`);
  return { warmupEvent, firstWriteEvent, firstProgressEvent, missing };
}

function metricText(value, missingReason) {
  if (Number.isFinite(value)) return String(value);
  if (missingReason) return `missing (${missingReason})`;
  return 'missing';
}

async function spawnElectronRunner() {
  const electronBinary = require('electron');
  const args = [
    __filename,
    '--runner',
  ];

  const forwardKeys = ['--audio', '--image', '--preset'];
  forwardKeys.forEach((key) => {
    const value = getArg(key, null);
    if (value) args.push(key, value);
  });

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
  };

  const child = spawn(electronBinary, args, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[perf-capture] electron exited with signal ${signal}`);
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

async function runCase(win, {
  name,
  exportBase,
  audioPath,
  imagePath,
  presetKey,
}) {
  const exportFolder = path.join(exportBase, name);
  fs.mkdirSync(exportFolder, { recursive: true });

  const payload = {
    imagePath,
    exportFolder,
    presetKey,
    createAlbumFolder: false,
    tracks: [
      {
        audioPath,
        outputBase: `01. ${name}`,
        trackNo: 1,
        hasTrackNo: true,
      },
    ],
  };

  const startedAt = Date.now();
  const renderResult = await invokeRendererApi(win, 'renderAlbum', payload);
  if (!renderResult || renderResult.ok !== true) {
    throw new Error(`renderAlbum failed for ${name}: ${JSON.stringify(renderResult)}`);
  }
  const elapsedMs = Date.now() - startedAt;

  const diagnosticsResult = await invokeRendererApi(win, 'exportDiagnostics', { exportFolder });
  if (!diagnosticsResult?.ok || !diagnosticsResult?.diagnosticsPath) {
    throw new Error(`exportDiagnostics failed for ${name}`);
  }

  const report = readJson(renderResult.reportPath);
  const diagnostics = readJson(diagnosticsResult.diagnosticsPath);
  const jobId = String(report?.job?.id || '');
  const sessionLogPath = resolveSessionLogPath(report, diagnostics);

  const rawEvents = parseLogEvents(readJsonl(sessionLogPath));
  const diagnosticsEvents = parseLogEvents(diagnostics?.logs?.events || []);
  const events = rawEvents.length > 0 ? rawEvents : diagnosticsEvents;

  const signals = extractCaseSignals(events, jobId);

  return {
    name,
    elapsedMs,
    exportFolder,
    reportPath: renderResult.reportPath,
    diagnosticsPath: diagnosticsResult.diagnosticsPath,
    sessionLogPath,
    jobId,
    eventCount: events.length,
    perf: report?.perf || null,
    warmupEvent: signals.warmupEvent,
    firstWriteEvent: signals.firstWriteEvent,
    firstProgressEvent: signals.firstProgressEvent,
    missing: signals.missing,
  };
}

async function runInElectron() {
  const { app, BrowserWindow } = require('electron');
  const projectRoot = path.resolve(__dirname, '..');

  const audioPath = path.resolve(getArg('--audio', path.join(projectRoot, 'fixtures', 'test.mp3')));
  const imagePath = path.resolve(getArg('--image', path.join(projectRoot, 'fixtures', 'test.jpg')));
  const presetKey = String(getArg('--preset', 'album_ep') || 'album_ep');

  if (!fs.existsSync(audioPath)) throw new Error(`Audio fixture not found: ${audioPath}`);
  if (!fs.existsSync(imagePath)) throw new Error(`Image fixture not found: ${imagePath}`);

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-perf-capture-'));
  const exportBase = path.join(runRoot, 'exports');
  const artifactsDir = path.join(runRoot, 'artifacts');
  fs.mkdirSync(exportBase, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  process.env.ALBUM_TO_VIDEO_EXPORT_BASE = exportBase;
  process.chdir(projectRoot);

  require(path.join(projectRoot, 'main.js'));

  await app.whenReady();
  const win = await waitForWindowLoaded(BrowserWindow);

  const cold = await runCase(win, {
    name: 'cold',
    exportBase,
    audioPath,
    imagePath,
    presetKey,
  });
  const warm = await runCase(win, {
    name: 'warm',
    exportBase,
    audioPath,
    imagePath,
    presetKey,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    runRoot,
    exportBase,
    audioPath,
    imagePath,
    presetKey,
    cold,
    warm,
    averages: {
      ffmpegSpawnMsAvg: safeAvg([cold?.perf?.ffmpegSpawnMs?.avg, warm?.perf?.ffmpegSpawnMs?.avg]),
      firstWriteMsAvg: safeAvg([cold?.perf?.firstWriteMs?.avg, warm?.perf?.firstWriteMs?.avg]),
      firstProgressMsAvg: safeAvg([cold?.perf?.firstProgressMs?.avg, warm?.perf?.firstProgressMs?.avg]),
    },
  };

  const summaryPath = path.join(artifactsDir, 'perf-capture-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const warmupMs = cold?.warmupEvent?.data?.durationMs ?? warm?.warmupEvent?.data?.durationMs ?? null;
  const warmupMissingReason = [
    ...(cold?.missing || []),
    ...(warm?.missing || []),
  ].find((m) => m.includes('ffmpeg.warmup.done')) || null;

  const coldFirstWrite = cold?.firstWriteEvent?.data?.firstWriteMs ?? null;
  const coldFirstProgress = cold?.firstProgressEvent?.data?.firstProgressMs ?? null;
  const coldFirstWriteMissing = (cold?.missing || []).find((m) => m.includes('ffmpeg.first_write')) || null;
  const coldFirstProgressMissing = (cold?.missing || []).find((m) => m.includes('ffmpeg.first_progress')) || null;

  console.log(`[perf-capture] summary: ${summaryPath}`);
  console.log(`[perf-capture] ffmpeg.warmup.done durationMs=${metricText(warmupMs, warmupMissingReason)}`);
  console.log(`[perf-capture] ffmpeg.first_write firstWriteMs=${metricText(coldFirstWrite, coldFirstWriteMissing)}`);
  console.log(`[perf-capture] ffmpeg.first_progress firstProgressMs=${metricText(coldFirstProgress, coldFirstProgressMissing)}`);
  console.log(`[perf-capture] report.perf.avg ffmpegSpawnMs=${summary.averages.ffmpegSpawnMsAvg} firstWriteMs=${summary.averages.firstWriteMsAvg} firstProgressMs=${summary.averages.firstProgressMsAvg}`);

  await delay(150);
  app.quit();
}

if (require.main === module) {
  if (process.argv.includes('--runner')) {
    runInElectron().catch((err) => {
      console.error('[perf-capture] failed:', err?.stack || err);
      process.exit(1);
    });
  } else {
    spawnElectronRunner().catch((err) => {
      console.error('[perf-capture] failed to launch electron:', err?.stack || err);
      process.exit(1);
    });
  }
}

module.exports = {
  parseLogEvent,
  parseLogEvents,
  findLastWarmupEvent,
  findFirstJobEvent,
  extractCaseSignals,
  resolveSessionLogPath,
  metricText,
};
