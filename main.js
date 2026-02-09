// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const mm = require('music-metadata');
const { cleanupJob } = require('./src/main/cleanup');
const { createSessionLogger } = require('./src/main/logger');

// ✅ Bundled FFmpeg/FFprobe (no PATH dependency)
let FFMPEG_BIN = null;
let FFPROBE_BIN = null;
let FFMPEG_SOURCE = null;
let FFPROBE_SOURCE = null;
try {
  // ffmpeg-static exports an absolute path to the platform binary
  // eslint-disable-next-line global-require
  const ffmpegStatic = require('ffmpeg-static');
  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length) {
    FFMPEG_BIN = ffmpegStatic;
    FFMPEG_SOURCE = 'bundled';
  }
} catch {}

try {
  // eslint-disable-next-line global-require
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  if (ffprobeInstaller?.path) {
    FFPROBE_BIN = ffprobeInstaller.path;
    FFPROBE_SOURCE = 'bundled';
  }
} catch {}

let mainWindow = null;
let sessionLogger = null;

const IS_MAC = process.platform === 'darwin';

// 🎯 Performance principle:
// - This app is a static-image publisher tool. We hard-lock 1fps globally.
// - 1fps is the fastest, most stable choice for still-cover audio videos.
const GLOBAL_FPS = 1;

const sharedPresetEngine = {
  // cap huge cover art to a sane size to avoid slow encodes on high-res JPEGs
  vf: "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
  // Use VideoToolbox on macOS for extra speed; fallback to libx264 elsewhere.
  video: () => {
    if (IS_MAC) {
      return [
        '-c:v', 'h264_videotoolbox',
        '-b:v', '6000k',
        '-pix_fmt', 'yuv420p',
      ];
    }
    return [
      '-c:v', 'libx264',
      // internally fast preset, but we hide this from UI naming
      '-preset', 'veryfast',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      // 1fps: keep GOP minimal
      '-g', '1',
      '-keyint_min', '1',
      '-sc_threshold', '0',
    ];
  },
  audio: ['-c:a', 'aac', '-b:a', '256k'],
};

const PRESETS = {
  // All presets use the same engine; only the intent label changes.
  album_ep: {
    label: 'Album / EP — Recommended',
    ...sharedPresetEngine,
  },

  single_track: {
    label: 'Single / Track',
    ...sharedPresetEngine,
  },

  long_form: {
    label: 'Long-form Audio',
    ...sharedPresetEngine,
  },
};

const currentJob = {
  id: null,
  ffmpeg: null,
  cancelled: false,
  cancelReason: null,
  active: false,
  cleanupContext: null,
};

const REASON_CODES = Object.freeze({
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  FFMPEG_EXIT_NONZERO: 'FFMPEG_EXIT_NONZERO',
  PROBE_FAILED: 'PROBE_FAILED',
  UNCAUGHT: 'UNCAUGHT',
});

function ensureBundledBinaries() {
  if (!FFMPEG_BIN || !path.isAbsolute(FFMPEG_BIN)) {
    const e = new Error('Bundled ffmpeg is required but not available.');
    e.code = REASON_CODES.UNCAUGHT;
    throw e;
  }
  if (!FFPROBE_BIN || !path.isAbsolute(FFPROBE_BIN)) {
    const e = new Error('Bundled ffprobe is required but not available.');
    e.code = REASON_CODES.UNCAUGHT;
    throw e;
  }
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory "${dirPath}": ${err.message}`);
  }
}

function assertFileReadable(filePath, label) {
  if (!filePath) throw new Error(`Missing ${label}`);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`${label} not readable: ${filePath}. ${err.message}`);
  }
}

function ensureWritableDir(dirPath) {
  ensureDir(dirPath);
  const testPath = path.join(dirPath, `.write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(testPath, '');
    fs.unlinkSync(testPath);
  } catch (err) {
    throw new Error(`Export folder not writable: ${dirPath}. ${err.message}`);
  }
}

function sanitizeFileBaseName(name) {
  let cleaned = String(name || '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[\/\\:\*\?"<>\|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) cleaned = 'Untitled';

  // Windows: reserved names and trailing dots/spaces are invalid.
  if (process.platform === 'win32') {
    cleaned = cleaned.replace(/[\. ]+$/g, '');
    const upper = cleaned.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(upper)) {
      cleaned = `${cleaned}_`;
    }
  }

  return cleaned || 'Untitled';
}

function formatTimestampForFile(d = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  const min = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}${m}${day}-${h}${min}${s}`;
}

function createDebugLogger(exportFolder) {
  const base = `export-debug-${formatTimestampForFile()}`;
  const logPath = uniqueOutputPath(exportFolder, base, '.log');
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  let streamErrored = false;

  const log = (line) => {
    if (!stream.writable || streamErrored) return;
    const safe = String(line ?? '').replace(/\s*$/g, '');
    stream.write(`${safe}\n`);
  };

  stream.on('error', () => {
    streamErrored = true;
  });

  log(`Album to Video export log`);
  log(`Started: ${new Date().toISOString()}`);
  log(`FFMPEG_BIN: ${FFMPEG_BIN}`);
  log(`FFPROBE_BIN: ${FFPROBE_BIN}`);
  log(``);

  return {
    log,
    path: logPath,
    close: () => {
      if (!streamErrored) stream.end();
    },
  };
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      return;
    }

    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    try { proc.kill('SIGTERM'); } catch {}

    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
    }, 800);
  } catch {}
}

function runFfprobeJson(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE_BIN, args, { windowsHide: true });
    let out = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch {}
    }, Math.max(1000, timeoutMs || 0));

    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => {
      clearTimeout(timeout);
      if (timedOut) return resolve(null);
      try { return resolve(JSON.parse(out || '{}')); } catch { return resolve(null); }
    });
    p.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

async function probeAudioInfo(audioPath, timeoutMs) {
  const data = await runFfprobeJson([
    '-v', 'error',
    '-show_entries', 'stream=codec_type,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    audioPath,
  ], timeoutMs || 5000);

  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const hasAudio = streams.some((s) => s.codec_type === 'audio');

  const streamDur = streams.find((s) => s.codec_type === 'audio')?.duration;
  const formatDur = data?.format?.duration;
  const durationSec = parseFloat(String(streamDur || formatDur || '0'));
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;

  return { ok: hasAudio, durationSec: safeDuration };
}

function uniqueOutputPath(dir, baseName, ext) {
  const safeBase = sanitizeFileBaseName(baseName);
  let candidate = path.join(dir, `${safeBase}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;

  for (let i = 2; i < 10000; i++) {
    candidate = path.join(dir, `${safeBase} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  return path.join(dir, `${safeBase}-${Date.now()}${ext}`);
}

function uniquePlannedOutputPath(dir, baseName, ext, reserved) {
  const safeBase = sanitizeFileBaseName(baseName);
  let candidate = path.join(dir, `${safeBase}${ext}`);
  if (!fs.existsSync(candidate) && !reserved.has(candidate)) {
    reserved.add(candidate);
    return candidate;
  }

  for (let i = 2; i < 10000; i++) {
    candidate = path.join(dir, `${safeBase} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }

  const fallback = path.join(dir, `${safeBase}-${Date.now()}${ext}`);
  reserved.add(fallback);
  return fallback;
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function safeRmdirIfEmpty(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    const removable = new Set(['.DS_Store', 'Thumbs.db']);
    const toDelete = entries.filter((e) => removable.has(e) || e.startsWith('._'));
    toDelete.forEach((e) => safeUnlink(path.join(dirPath, e)));
    const remaining = fs.readdirSync(dirPath);
    if (remaining.length === 0) fs.rmdirSync(dirPath);
  } catch {}
}

function tailLines(text, lineCount) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, lineCount || 1)).join('\n');
}

function resolveSystemVersion() {
  if (typeof app.getSystemVersion === 'function') {
    try {
      const v = app.getSystemVersion();
      if (v) return String(v);
    } catch {}
  }
  return os.release();
}

function buildOsDescriptor() {
  return `${process.platform} ${resolveSystemVersion()}`.trim();
}

function buildFfmpegArgsBase({
  imagePath,
  audioPath,
  presetKey,
  audioMode,
}) {
  const preset = PRESETS[presetKey] || PRESETS.album_ep;
  const fps = GLOBAL_FPS;
  const videoArgs = typeof preset.video === 'function' ? preset.video() : preset.video;
  const vf = preset.vf;
  const audioArgs = audioMode === 'copy'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '320k'];

  return [
    '-y',
    '-nostdin',
    '-loglevel', 'error',
    '-loop', '1',
    '-framerate', String(fps),
    '-i', imagePath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...(vf ? ['-vf', vf] : []),
    '-r', String(fps),
    '-vsync', 'cfr',
    ...videoArgs,
    ...audioArgs,
    '-movflags', '+faststart',
    '-shortest',
  ];
}

async function buildRenderPlan(payload) {
  const {
    tracks,
    imagePath,
    exportFolder,
    presetKey,
  } = payload || {};

  ensureBundledBinaries();

  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('No tracks to export');
  if (!imagePath) throw new Error('Missing cover art');
  if (!exportFolder) throw new Error('Missing export folder');

  assertFileReadable(imagePath, 'Cover art');
  ensureWritableDir(exportFolder);

  const resolvedPresetKey = PRESETS[presetKey] ? presetKey : 'album_ep';
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reservedOutputs = new Set();
  const plannedTracks = [];

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t?.audioPath || typeof t.audioPath !== 'string') {
      throw new Error(`Invalid audio path for track ${i + 1}`);
    }
    assertFileReadable(t.audioPath, `Audio file ${i + 1}`);

    const outputBase = sanitizeFileBaseName(t.outputBase || `Track ${i + 1}`);
    const outputFinalPath = uniquePlannedOutputPath(exportFolder, outputBase, '.mp4', reservedOutputs);
    const tmpPath = buildTmpPath(outputFinalPath);
    const probe = await probeAudioInfo(t.audioPath, 5000);
    const durationSec = Number(probe?.durationSec || 0);
    if (!probe?.ok || !Number.isFinite(durationSec) || durationSec <= 0) {
      const e = new Error(`Probe failed for track ${i + 1}: ${t.audioPath}`);
      e.code = REASON_CODES.PROBE_FAILED;
      throw e;
    }

    plannedTracks.push({
      audioPath: t.audioPath,
      durationSec,
      outputBase,
      outputFinalPath,
      tmpPath,
      ffmpegArgsBase: buildFfmpegArgsBase({
        imagePath,
        audioPath: t.audioPath,
        presetKey: resolvedPresetKey,
        audioMode: 'copy',
      }),
    });
  }

  const totalDurationSec = plannedTracks.reduce((sum, t) => sum + t.durationSec, 0);
  return {
    jobId,
    exportFolder,
    presetKey: resolvedPresetKey,
    imagePath,
    totalDurationSec,
    tracks: plannedTracks,
  };
}

function buildTmpPath(finalPath) {
  if (String(finalPath).toLowerCase().endsWith('.mp4')) {
    return `${finalPath.slice(0, -4)}.tmp.mp4`;
  }
  return `${finalPath}.tmp.mp4`;
}

function validateTmpOutput(tmpPath) {
  const stat = fs.statSync(tmpPath);
  if (!stat.isFile() || stat.size <= 0) {
    const e = new Error(`Temporary output invalid: ${tmpPath}`);
    e.code = REASON_CODES.FFMPEG_EXIT_NONZERO;
    throw e;
  }
}

function humanMessageForReason(code, err) {
  if (code === REASON_CODES.CANCELLED) return 'Render cancelled by user.';
  if (code === REASON_CODES.TIMEOUT) return 'Render timed out before completion.';
  if (code === REASON_CODES.PROBE_FAILED) return 'Input audio probe failed.';
  if (code === REASON_CODES.FFMPEG_EXIT_NONZERO) return 'FFmpeg failed to encode one or more tracks.';
  return String(err?.message || 'Unexpected render failure.');
}

function reasonCodeFromError(err) {
  if (!err?.code) return REASON_CODES.UNCAUGHT;
  if (Object.values(REASON_CODES).includes(err.code)) return err.code;
  if (err.code === 'CANCELLED') return REASON_CODES.CANCELLED;
  if (err.code === 'TIMEOUT') return REASON_CODES.TIMEOUT;
  if (err.code === 'UNSUPPORTED_AUDIO') return REASON_CODES.PROBE_FAILED;
  if (err.code === 'FFMPEG_FAILED') return REASON_CODES.FFMPEG_EXIT_NONZERO;
  return REASON_CODES.UNCAUGHT;
}

function sanitizePayload(payload) {
  const tracks = Array.isArray(payload?.tracks)
    ? payload.tracks.map((t) => ({
      audioPath: t?.audioPath || '',
      outputBase: t?.outputBase || '',
    }))
    : [];

  return {
    imagePath: payload?.imagePath || '',
    exportFolder: payload?.exportFolder || '',
    presetKey: payload?.presetKey || '',
    timeoutPerTrackMs: payload?.timeoutPerTrackMs || null,
    createAlbumFolder: Boolean(payload?.createAlbumFolder),
    trackCount: tracks.length,
    tracks,
    redactedPaths: false,
  };
}

function writeRenderReport(exportFolder, report) {
  if (!exportFolder) return null;
  const logsDir = path.join(exportFolder, 'Logs');
  ensureDir(logsDir);
  const reportPath = path.join(logsDir, 'render-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

function isAudioCopyCompatibilityError(stderr) {
  const lower = String(stderr || '').toLowerCase();
  const markers = [
    'could not find tag for codec',
    'codec not currently supported in container',
    'error initializing output stream',
    'could not write header',
    'tag mp4a',
    'invalid argument',
  ];
  return markers.some((m) => lower.includes(m));
}

function extractFallbackReason(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).filter(Boolean);
  const hit = lines.find((line) => /codec|container|tag|header|unsupported|invalid/i.test(line));
  return (hit || tailLines(stderr, 1) || 'audio copy compatibility failure').slice(0, 240);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 1100,
    minHeight: 760,
    maxWidth: 1100,
    maxHeight: 760,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0c0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  sessionLogger = createSessionLogger(app, { appFolderName: 'Album-to-Video', keepLatest: 20 });
  sessionLogger.info('app.ready', {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (sessionLogger?.info) sessionLogger.info('app.before_quit');
  if (sessionLogger?.close) sessionLogger.close();
});

// ---------------- Dialogs ----------------
ipcMain.handle('select-audios', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'aif', 'aiff', 'flac', 'm4a', 'aac', 'ogg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : (result.filePaths || []);
});

ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : (result.filePaths?.[0] || null);
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : (result.filePaths?.[0] || null);
});

ipcMain.handle('ensure-dir', async (_event, dirPath) => {
  ensureDir(dirPath);
  return true;
});

ipcMain.handle('open-folder', async (_event, folderPath) => {
  await shell.openPath(folderPath);
  return true;
});

// ---------------- Metadata ----------------
ipcMain.handle('read-metadata', async (_event, filePath) => {
  try {
    const meta = await mm.parseFile(filePath, { duration: false });
    const artist = (meta.common.artist || meta.common?.artists?.[0] || '').trim();
    const title = (meta.common.title || '').trim();
    const album = (meta.common.album || '').trim();
    const tn = meta.common?.track?.no;
    const trackNo = Number.isFinite(Number(tn)) ? Number(tn) : null;

    return { artist, title, album, trackNo };
  } catch {
    return { artist: '', title: '', album: '', trackNo: null };
  }
});

ipcMain.handle('probe-audio', async (_event, filePath) => {
  try {
    return await probeAudioInfo(filePath, 5000);
  } catch {
    return { ok: false, durationSec: 0 };
  }
});

// ---------------- Render job (album-level) ----------------
ipcMain.handle('cancel-render', async () => {
  if (!currentJob.active) return true;
  currentJob.cancelled = true;
  currentJob.cancelReason = REASON_CODES.CANCELLED;
  cleanupJob(currentJob.id, REASON_CODES.CANCELLED, currentJob.cleanupContext);
  return true;
});

function runFfmpegStillImage({
  event,
  audioPath,
  outputPath,
  progressOutputPath,
  ffmpegArgsBase,
  logLevel,
  trackIndex,
  trackCount,
  timeoutMs,
  debugLog,
  durationSec,
  totalDurationSec,
  elapsedBeforeSec,
  totalDurationKnown,
  audioMode,
  jobId,
}) {
  const log = typeof debugLog === 'function' ? debugLog : null;
  const outputForProgress = progressOutputPath || outputPath;
  const baseArgs = Array.isArray(ffmpegArgsBase) ? ffmpegArgsBase.slice() : [];

  return new Promise(async (resolve, reject) => {
    const dSec = Number(durationSec || 0);
    if (!Number.isFinite(dSec) || dSec <= 0) {
      const e = new Error(`Invalid planned duration for track ${trackIndex + 1}`);
      e.code = REASON_CODES.PROBE_FAILED;
      reject(e);
      return;
    }
    const durationKnown = Number.isFinite(dSec) && dSec > 0.25;
    const durationMs = durationKnown ? Math.floor(dSec * 1000) : 0;

    let stderr = '';
    const STDERR_MAX = 64 * 1024;
    let killedByTimeout = false;

    const effectiveLogLevel = log ? 'info' : (logLevel || 'error');
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let lastOutTimeMs = 0;
    let speedEwma = 0;
    const speedAlpha = 0.25;

    const computePercentTrack = () => {
      if (!durationKnown || !lastOutTimeMs) return null;
      const elapsedMs = Date.now() - startedAtMs;
      let pct = (lastOutTimeMs / durationMs) * 100;
      if (speedEwma > 0.05) {
        const remainingMs = Math.max(0, (durationMs - lastOutTimeMs) / speedEwma);
        const totalMs = elapsedMs + remainingMs;
        if (totalMs > 0) pct = (elapsedMs / totalMs) * 100;
      }
      return Math.min(99.9, Math.max(0, pct));
    };
    const args = [
      ...baseArgs,
      '-loglevel', effectiveLogLevel,

      // 7) Robust progress
      '-progress', 'pipe:1',
      '-nostats',

      outputPath,
    ];

    if (log) {
      const fmt = (a) => (/[ \t]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
      log(`--- Track ${trackIndex + 1}/${trackCount} ---`);
      log(`audioPath: ${audioPath}`);
      log(`outputPath: ${outputPath}`);
      log(`jobId: ${jobId || ''}`);
      log(`audioMode: ${audioMode || 'copy'}`);
      log(`durationSec: ${dSec || 0}`);
      log(`args: ${args.map(fmt).join(' ')}`);
      log(``);
    }

    const ff = spawn(FFMPEG_BIN, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    currentJob.ffmpeg = ff;

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      currentJob.cancelled = true;
      currentJob.cancelReason = REASON_CODES.TIMEOUT;
      killProcessTree(ff);
    }, Math.max(10_000, timeoutMs || 0));

    ff.stdout.setEncoding('utf8');
    let buf = '';

    ff.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);

        if (line.startsWith('speed=')) {
          const raw = line.split('=')[1] || '';
          const v = parseFloat(String(raw).replace(/x/i, '').trim());
          if (Number.isFinite(v) && v > 0) {
            speedEwma = speedEwma ? (speedEwma * (1 - speedAlpha) + v * speedAlpha) : v;
          }
        } else if (line.startsWith('out_time_ms=')) {
          const v = parseInt(line.split('=')[1], 10);
          if (Number.isFinite(v)) {
            lastOutTimeMs = v;
            if (durationKnown) {
              const pctTrack = computePercentTrack();
              let pctTotal = ((trackIndex + (pctTrack || 0) / 100) / Math.max(1, trackCount)) * 100;
              if (totalDurationKnown && totalDurationSec > 0) {
                const progressSec = (elapsedBeforeSec || 0) + ((pctTrack || 0) / 100) * dSec;
                pctTotal = (progressSec / totalDurationSec) * 100;
              }

              event.sender.send('render-progress', {
                trackIndex,
                trackCount,
                audioPath,
                outputPath: outputForProgress,
                percentTrack: pctTrack || 0,
                percentTotal: Math.min(100, pctTotal),
                indeterminate: false,
                isFinal: false,
              });
            } else {
              event.sender.send('render-progress', {
                trackIndex,
                trackCount,
                audioPath,
                outputPath: outputForProgress,
                percentTrack: 0,
                percentTotal: totalDurationKnown && totalDurationSec > 0
                  ? ((elapsedBeforeSec || 0) / totalDurationSec) * 100
                  : (trackIndex / Math.max(1, trackCount)) * 100,
                indeterminate: true,
                isFinal: false,
              });
            }
          }
        } else if (line === 'progress=end') {
          let pctTotal = ((trackIndex + 1) / Math.max(1, trackCount)) * 100;
          if (totalDurationKnown && totalDurationSec > 0) {
            pctTotal = ((elapsedBeforeSec || 0) + dSec) / totalDurationSec * 100;
          }
          event.sender.send('render-progress', {
            trackIndex,
            trackCount,
            audioPath,
            outputPath: outputForProgress,
            percentTrack: 100,
            percentTotal: Math.min(100, pctTotal),
            indeterminate: false,
            isFinal: true,
          });
        }
      }
    });

    ff.stderr.setEncoding('utf8');
    ff.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > STDERR_MAX) {
        stderr = stderr.slice(-STDERR_MAX);
      }
      if (log) log(chunk);
    });

    const finalize = (ok, codeOrErr) => {
      clearTimeout(timeout);
      currentJob.ffmpeg = null;

      const endedAtMs = Date.now();
      const endedAt = new Date(endedAtMs).toISOString();
      if (currentJob.cancelled) {
        const reason = currentJob.cancelReason || (killedByTimeout ? REASON_CODES.TIMEOUT : REASON_CODES.CANCELLED);
        const e = new Error(reason);
        e.code = reason;
        e.exitCode = typeof codeOrErr === 'number' ? codeOrErr : null;
        e.stderr = stderr;
        e.stderrTail = tailLines(stderr, 50);
        e.ffmpegArgs = args;
        e.audioMode = audioMode;
        e.startTs = startedAt;
        e.endTs = endedAt;
        e.durationMs = endedAtMs - startedAtMs;
        reject(e);
        return;
      }

      if (ok) {
        if (log) log(`ffmpeg exited successfully`);
        resolve({
          ok: true,
          ffmpegArgs: args,
          exitCode: 0,
          stderr,
          stderrTail: tailLines(stderr, 50),
          audioMode,
          startTs: startedAt,
          endTs: endedAt,
          durationMs: endedAtMs - startedAtMs,
          durationSec: dSec,
        });
        return;
      }

      const msg =
        typeof codeOrErr === 'number'
          ? `ffmpeg exited with code ${codeOrErr}\n${stderr || ''}`.trim()
          : String(codeOrErr?.message || 'ffmpeg failed');

      if (log) log(`ffmpeg error: ${msg}`);
      const e = new Error(msg);
      e.code = REASON_CODES.FFMPEG_EXIT_NONZERO;
      e.exitCode = typeof codeOrErr === 'number' ? codeOrErr : null;
      e.stderr = stderr;
      e.stderrTail = tailLines(stderr, 50);
      e.ffmpegArgs = args;
      e.audioMode = audioMode;
      e.startTs = startedAt;
      e.endTs = endedAt;
      e.durationMs = endedAtMs - startedAtMs;
      reject(e);
    };

    ff.on('error', (err) => finalize(false, err));
    ff.on('exit', (code) => finalize(code === 0, code));
  });
}

ipcMain.handle('render-album', async (event, payload) => {
  const { timeoutPerTrackMs, debug, createAlbumFolder } = payload || {};

  event.sender.send('render-status', { phase: 'planning' });
  const plan = await buildRenderPlan(payload);

  const jobId = plan.jobId;
  const exportFolder = plan.exportFolder;
  currentJob.cancelled = false;
  currentJob.cancelReason = null;
  currentJob.active = true;
  currentJob.id = jobId;
  currentJob.cleanupContext = {
    cleanedUp: false,
    getActiveProcess: () => currentJob.ffmpeg,
    killProcessTree,
    currentTrackTmpPath: null,
    tmpPaths: new Set(),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder: exportFolder,
    createAlbumFolder: Boolean(createAlbumFolder),
    safeRmdirIfEmpty,
    logger: sessionLogger,
  };

  const rendered = [];
  const tracks = plan.tracks;
  let debugLogger = null;
  const totalDurationSec = plan.totalDurationSec;
  const totalDurationKnown = totalDurationSec > 0;
  const jobStartedAtMs = Date.now();
  const report = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    os: buildOsDescriptor(),
    arch: process.arch,
    ffmpegPath: FFMPEG_BIN,
    ffprobePath: FFPROBE_BIN,
    ffmpegSource: FFMPEG_SOURCE,
    ffprobeSource: FFPROBE_SOURCE,
    payload: sanitizePayload(payload),
    plan,
    tracks: [],
    logs: {
      sessionLogPath: sessionLogger?.filePath || null,
    },
    job: {
      id: jobId,
      status: 'FAILED',
      reasonCode: REASON_CODES.UNCAUGHT,
      humanMessage: '',
      startTs: new Date(jobStartedAtMs).toISOString(),
      endTs: null,
      durationMs: null,
    },
  };
  let reportPath = null;

  try {
    if (debug) {
      debugLogger = createDebugLogger(exportFolder);
      currentJob.cleanupContext.stagingPaths.add(debugLogger.path);
      currentJob.cleanupContext.stagingClosers.add(() => debugLogger.close());
    }
    sessionLogger?.info('render.start', { jobId, trackCount: tracks.length, exportFolder });
    event.sender.send('render-status', { phase: 'rendering' });

    if (debugLogger) {
      debugLogger.log(`[probe] tracks=${tracks.length} totalDurationSec=${totalDurationSec.toFixed(3)} known=${totalDurationKnown}`);
    }

    for (let i = 0; i < tracks.length; i++) {
      if (currentJob.cancelled) {
        const e = new Error(currentJob.cancelReason || REASON_CODES.CANCELLED);
        e.code = currentJob.cancelReason || REASON_CODES.CANCELLED;
        throw e;
      }

      const trackPlan = tracks[i];
      const audioPath = trackPlan.audioPath;
      const outputFinalPath = trackPlan.outputFinalPath;
      const tmpPath = trackPlan.tmpPath;
      safeUnlink(tmpPath);
      currentJob.cleanupContext.currentTrackTmpPath = tmpPath;
      currentJob.cleanupContext.tmpPaths.add(tmpPath);
      const elapsedBeforeSec = tracks.slice(0, i).reduce((a, t) => a + (t.durationSec || 0), 0);
      const trackReport = {
        inputPath: audioPath,
        durationSec: trackPlan.durationSec || 0,
        outputFinalPath,
        tmpPath,
        ffmpegArgsBase: trackPlan.ffmpegArgsBase,
        ffmpegArgs: [],
        startTs: null,
        endTs: null,
        durationMs: null,
        exitCode: null,
        stderrTail: '',
        audioMode: 'copy',
        fallbackReason: null,
      };
      report.tracks.push(trackReport);

      let runResult = null;
      let shouldFallback = false;
      let fallbackReason = null;

      try {
        runResult = await runFfmpegStillImage({
          event,
          audioPath,
          outputPath: tmpPath,
          progressOutputPath: outputFinalPath,
          ffmpegArgsBase: trackPlan.ffmpegArgsBase,
          logLevel: 'error',
          trackIndex: i,
          trackCount: tracks.length,
          timeoutMs: timeoutPerTrackMs || 30 * 60 * 1000,
          debugLog: debugLogger?.log,
          durationSec: trackPlan.durationSec,
          totalDurationSec,
          elapsedBeforeSec,
          totalDurationKnown,
          audioMode: 'copy',
          jobId,
        });
      } catch (err) {
        shouldFallback = (
          err?.code === REASON_CODES.FFMPEG_EXIT_NONZERO
          && isAudioCopyCompatibilityError(err?.stderr || err?.stderrTail)
        );

        if (!shouldFallback) throw err;

        fallbackReason = extractFallbackReason(err?.stderr || err?.stderrTail);
        sessionLogger?.warn('render.audio_copy_fallback', { jobId, trackIndex: i, fallbackReason });
        if (debugLogger) debugLogger.log(`[fallback] track=${i + 1} reason=${fallbackReason}`);
        safeUnlink(tmpPath);

        runResult = await runFfmpegStillImage({
          event,
          audioPath,
          outputPath: tmpPath,
          progressOutputPath: outputFinalPath,
          ffmpegArgsBase: buildFfmpegArgsBase({
            imagePath: plan.imagePath,
            audioPath,
            presetKey: plan.presetKey,
            audioMode: 'aac',
          }),
          logLevel: 'error',
          trackIndex: i,
          trackCount: tracks.length,
          timeoutMs: timeoutPerTrackMs || 30 * 60 * 1000,
          debugLog: debugLogger?.log,
          durationSec: trackPlan.durationSec,
          totalDurationSec,
          elapsedBeforeSec,
          totalDurationKnown,
          audioMode: 'aac',
          jobId,
        });
      }

      trackReport.audioMode = shouldFallback ? 'aac-fallback' : 'copy';
      trackReport.fallbackReason = fallbackReason;
      trackReport.ffmpegArgs = runResult.ffmpegArgs;
      trackReport.startTs = runResult.startTs;
      trackReport.endTs = runResult.endTs;
      trackReport.durationMs = runResult.durationMs;
      trackReport.exitCode = runResult.exitCode;
      trackReport.stderrTail = runResult.stderrTail;

      validateTmpOutput(tmpPath);
      fs.renameSync(tmpPath, outputFinalPath);
      currentJob.cleanupContext.tmpPaths.delete(tmpPath);
      currentJob.cleanupContext.currentTrackTmpPath = null;

      rendered.push({ audioPath, outputPath: outputFinalPath });
    }

    report.job.status = 'SUCCESS';
    report.job.reasonCode = '';
    report.job.humanMessage = 'Render completed successfully.';
    report.job.endTs = new Date().toISOString();
    report.job.durationMs = Date.now() - jobStartedAtMs;
    reportPath = writeRenderReport(exportFolder, report);
    sessionLogger?.info('render.success', { jobId, renderedCount: rendered.length, reportPath });

    if (debugLogger?.path) currentJob.cleanupContext.stagingPaths.delete(debugLogger.path);
    return {
      ok: true,
      exportFolder,
      rendered,
      debugLogPath: debugLogger?.path || null,
      reportPath,
    };
  } catch (err) {
    const reasonCode = reasonCodeFromError(err);
    const jobStatus = reasonCode === REASON_CODES.CANCELLED
      ? 'CANCELLED'
      : (reasonCode === REASON_CODES.TIMEOUT ? 'TIMEOUT' : 'FAILED');
    report.job.status = jobStatus;
    report.job.reasonCode = reasonCode;
    report.job.humanMessage = humanMessageForReason(reasonCode, err);
    report.job.endTs = new Date().toISOString();
    report.job.durationMs = Date.now() - jobStartedAtMs;

    const lastTrack = report.tracks[report.tracks.length - 1];
    if (lastTrack && !lastTrack.endTs) {
      lastTrack.endTs = new Date().toISOString();
      lastTrack.durationMs = 0;
      lastTrack.exitCode = err?.exitCode ?? null;
      lastTrack.stderrTail = err?.stderrTail || tailLines(err?.stderr || err?.message, 50);
      if (Array.isArray(err?.ffmpegArgs) && err.ffmpegArgs.length) {
        lastTrack.ffmpegArgs = err.ffmpegArgs;
      }
    }

    cleanupJob(jobId, reasonCode, currentJob.cleanupContext);
    sessionLogger?.error('render.failed', {
      jobId,
      reasonCode,
      message: String(err?.message || err),
      trackCount: tracks.length,
    });

    try {
      reportPath = writeRenderReport(exportFolder, report);
    } catch (reportErr) {
      sessionLogger?.error('report.write_failed', {
        jobId,
        message: String(reportErr?.message || reportErr),
      });
    }

    if (debugLogger?.path) {
      err.message = `${err.message}\nDebug log: ${debugLogger.path}`;
    }
    throw err;
  } finally {
    if (debugLogger) debugLogger.close();
    currentJob.active = false;
    currentJob.ffmpeg = null;
    currentJob.cancelled = false;
    currentJob.cancelReason = null;
    currentJob.cleanupContext = null;
    currentJob.id = null;
  }
});
