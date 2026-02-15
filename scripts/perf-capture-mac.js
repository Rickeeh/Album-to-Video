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

function findLastEvent(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (predicate(events[i])) return events[i];
  }
  return null;
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
  const sessionLogPath = diagnostics?.logs?.sessionLogPath || report?.logs?.sessionLogPath || null;
  const sessionEvents = readJsonl(sessionLogPath);
  const jobId = report?.job?.id || null;

  const warmupEvent = findLastEvent(sessionEvents, (e) => e?.msg === 'ffmpeg.warmup.done');
  const firstWriteEvent = findLastEvent(sessionEvents, (e) => e?.msg === 'ffmpeg.first_write' && e?.jobId === jobId);
  const firstProgressEvent = findLastEvent(sessionEvents, (e) => e?.msg === 'ffmpeg.first_progress' && e?.jobId === jobId);

  return {
    name,
    elapsedMs,
    exportFolder,
    reportPath: renderResult.reportPath,
    diagnosticsPath: diagnosticsResult.diagnosticsPath,
    sessionLogPath,
    perf: report?.perf || null,
    warmupEvent: warmupEvent || null,
    firstWriteEvent: firstWriteEvent || null,
    firstProgressEvent: firstProgressEvent || null,
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

  console.log(`[perf-capture] summary: ${summaryPath}`);
  const warmupMs = cold?.warmupEvent?.durationMs ?? warm?.warmupEvent?.durationMs ?? null;
  const coldFirstWrite = cold?.firstWriteEvent?.firstWriteMs ?? null;
  const coldFirstProgress = cold?.firstProgressEvent?.firstProgressMs ?? null;
  console.log(`[perf-capture] ffmpeg.warmup.done durationMs=${warmupMs}`);
  console.log(`[perf-capture] ffmpeg.first_write firstWriteMs=${coldFirstWrite}`);
  console.log(`[perf-capture] ffmpeg.first_progress firstProgressMs=${coldFirstProgress}`);
  console.log(`[perf-capture] report.perf.avg ffmpegSpawnMs=${summary.averages.ffmpegSpawnMsAvg} firstWriteMs=${summary.averages.firstWriteMsAvg} firstProgressMs=${summary.averages.firstProgressMsAvg}`);

  await delay(150);
  app.quit();
}

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
