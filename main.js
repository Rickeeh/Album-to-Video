// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { cleanupJob } = require('./src/main/cleanup');
const { createSessionLogger } = require('./src/main/logger');
const { exportDiagnosticsBundle, MAX_LOG_EVENTS, redactSensitivePathSegments } = require('./src/main/diagnostics');
const { getPreset, listPresets } = require('./src/main/presets');

let mainWindow = null;
let sessionLogger = null;
let lastSelectedExportFolder = null;

if (process.platform === 'win32') {
  try {
    // Prevent DPI virtualization and force deterministic scaling.
    app.commandLine.appendSwitch('high-dpi-support', '1');
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
  } catch {}
}

const APP_START_NS = process.hrtime.bigint();
function msSinceAppStart() {
  return Number((process.hrtime.bigint() - APP_START_NS) / 1000000n);
}

function perfMark(mark, extra = {}) {
  const payload = {
    mark,
    msFromStart: msSinceAppStart(),
    ts: new Date().toISOString(),
    ...extra,
  };

  if (sessionLogger?.info) sessionLogger.info('perf.mark', payload);
  else console.log('[perf]', payload);
}

function payloadKeys(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload);
}

function logIpcHandlerFailure(methodName, err, payload) {
  const details = {
    code: 'IPC_HANDLER_FAILED',
    methodName,
    payloadKeys: payloadKeys(payload),
    message: String(err?.message || err),
    stack: String(err?.stack || err),
  };

  if (sessionLogger?.error) sessionLogger.error('ipc.handler_failed', details);
  else console.error('[IPC_HANDLER_FAILED]', details);
}

function registerIpcHandler(methodName, handler) {
  ipcMain.handle(methodName, async (event, payload) => {
    try {
      return await handler(event, payload);
    } catch (err) {
      logIpcHandlerFailure(methodName, err, payload);
      throw err;
    }
  });
}

perfMark('app.start', { pid: process.pid, platform: process.platform, arch: process.arch });

const LOCAL_BIN_ROOT = path.join(__dirname, 'resources', 'bin');

// ✅ Bundled FFmpeg/FFprobe (no PATH dependency)
let FFMPEG_BIN = null;
let FFPROBE_BIN = null;
let FFMPEG_SOURCE = null;
let FFPROBE_SOURCE = null;
let binariesResolved = false;
let musicMetadataModule = null;

function isReadableFile(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveVendoredMacBinary(binaryName) {
  if (process.platform !== 'darwin') return null;
  const archDir = `darwin-${process.arch}`;
  const candidates = [];

  if (process.resourcesPath && path.isAbsolute(process.resourcesPath)) {
    candidates.push(path.join(process.resourcesPath, 'bin', archDir, binaryName));
  }
  candidates.push(path.join(LOCAL_BIN_ROOT, archDir, binaryName));

  return candidates.find((candidate) => isReadableFile(candidate)) || null;
}

function resolveVendoredWinBinary(relPath) {
  if (process.platform !== 'win32') return null;
  const candidates = [];

  if (process.resourcesPath && path.isAbsolute(process.resourcesPath)) {
    candidates.push(path.join(process.resourcesPath, relPath));
  }
  candidates.push(path.join(__dirname, 'resources', relPath));

  return candidates.find((candidate) => isReadableFile(candidate)) || null;
}

function resolveBundledBinaries() {
  if (binariesResolved) return;
  binariesResolved = true;

  const vendoredFfmpeg = resolveVendoredMacBinary('ffmpeg');
  if (vendoredFfmpeg) {
    FFMPEG_BIN = vendoredFfmpeg;
    FFMPEG_SOURCE = 'vendored';
  }

  const vendoredFfprobe = resolveVendoredMacBinary('ffprobe');
  if (vendoredFfprobe) {
    FFPROBE_BIN = vendoredFfprobe;
    FFPROBE_SOURCE = 'vendored';
  }

  if (process.platform === 'win32') {
    const vendoredWinFfmpeg = resolveVendoredWinBinary(path.join('bin', 'win32', 'ffmpeg.exe'));
    if (vendoredWinFfmpeg) {
      FFMPEG_BIN = vendoredWinFfmpeg;
      FFMPEG_SOURCE = 'vendored';
    }

    const vendoredWinFfprobe = resolveVendoredWinBinary(path.join('bin', 'win32', 'ffprobe.exe'));
    if (vendoredWinFfprobe) {
      FFPROBE_BIN = vendoredWinFfprobe;
      FFPROBE_SOURCE = 'vendored';
    }
  }

  if (!app.isPackaged) {
    try {
      // ffmpeg-static exports an absolute path to the platform binary
      // eslint-disable-next-line global-require
      if (!FFMPEG_BIN) {
        const ffmpegStatic = require('ffmpeg-static');
        if (typeof ffmpegStatic === 'string' && ffmpegStatic.length) {
          FFMPEG_BIN = ffmpegStatic;
          FFMPEG_SOURCE = 'dependency';
        }
      }
    } catch {}

    try {
      // eslint-disable-next-line global-require
      if (!FFPROBE_BIN) {
        const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
        if (ffprobeInstaller?.path) {
          FFPROBE_BIN = ffprobeInstaller.path;
          FFPROBE_SOURCE = 'dependency';
        }
      }
    } catch {}
  }
}

function buildEnginePathProbe() {
  const resourcesPath = process.resourcesPath || null;
  const expectedWinFfmpegPath = resourcesPath ? path.join(resourcesPath, 'bin', 'win32', 'ffmpeg.exe') : null;
  const expectedWinFfprobePath = resourcesPath ? path.join(resourcesPath, 'bin', 'win32', 'ffprobe.exe') : null;
  const devWinFfmpegPath = path.join(__dirname, 'resources', 'bin', 'win32', 'ffmpeg.exe');
  const devWinFfprobePath = path.join(__dirname, 'resources', 'bin', 'win32', 'ffprobe.exe');

  return {
    appIsPackaged: app.isPackaged,
    execPath: process.execPath || null,
    resourcesPath,
    expectedWinFfmpegPath,
    expectedWinFfmpegExists: Boolean(expectedWinFfmpegPath && fs.existsSync(expectedWinFfmpegPath)),
    expectedWinFfprobePath,
    expectedWinFfprobeExists: Boolean(expectedWinFfprobePath && fs.existsSync(expectedWinFfprobePath)),
    devWinFfmpegPath,
    devWinFfmpegExists: fs.existsSync(devWinFfmpegPath),
    devWinFfprobePath,
    devWinFfprobeExists: fs.existsSync(devWinFfprobePath),
  };
}

function getEngineBinariesSnapshot() {
  return {
    FFMPEG_SOURCE,
    FFPROBE_SOURCE,
    FFMPEG_PATH: FFMPEG_BIN || null,
    FFPROBE_PATH: FFPROBE_BIN || null,
    FFMPEG_BIN: Boolean(FFMPEG_BIN),
    FFPROBE_BIN: Boolean(FFPROBE_BIN),
  };
}

function getPinnedWinBinaryHashes() {
  try {
    // Optional source of truth used by verify:win-bins.
    // This file may not exist in packaged runtime.
    // eslint-disable-next-line global-require
    const verify = require('./scripts/verify-win-binaries.js');
    if (verify && verify.expectedSha256 && typeof verify.expectedSha256 === 'object') {
      return verify.expectedSha256;
    }
  } catch {}
  return null;
}

// 🎯 Performance principle:
// - This app is a static-image publisher tool. We hard-lock 1fps globally.
// - 1fps is the fastest, most stable choice for still-cover audio videos.
const GLOBAL_FPS = 1;

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
  resolveBundledBinaries();
  if (!FFMPEG_BIN || !path.isAbsolute(FFMPEG_BIN)) {
    const e = new Error('Bundled ffmpeg is required but not available.');
    e.code = REASON_CODES.UNCAUGHT;
    throw e;
  }
  if (!FFPROBE_BIN || !path.isAbsolute(FFPROBE_BIN)) {
    FFPROBE_BIN = null;
    FFPROBE_SOURCE = 'missing';
  }
}

function getMusicMetadata() {
  if (!musicMetadataModule) {
    // Lazy-load: avoid loading this dependency during app startup.
    // eslint-disable-next-line global-require
    musicMetadataModule = require('music-metadata');
  }
  return musicMetadataModule;
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory "${dirPath}": ${err.message}`);
  }
}

function isBlockedWindowsPath(rawPath) {
  const normalized = String(rawPath || '').replace(/\//g, '\\');
  // Device namespace and UNC paths are not supported for renderer-provided paths.
  if (/^\\\\\?\\/.test(normalized)) return true;
  if (/^\\\\\.\\/.test(normalized)) return true;
  if (/^\\\\/.test(normalized)) return true;
  return false;
}

function isBlockedUnixPath(absolutePath) {
  return absolutePath === '/dev'
    || absolutePath.startsWith('/dev/')
    || absolutePath === '/proc'
    || absolutePath.startsWith('/proc/')
    || absolutePath === '/sys'
    || absolutePath.startsWith('/sys/');
}

function assertAbsolutePath(rawPath, label) {
  const value = String(rawPath || '').trim();
  if (!value) throw new Error(`Missing ${label}`);
  if (value.includes('\0')) throw new Error(`${label} contains invalid characters.`);
  if (process.platform === 'win32' && isBlockedWindowsPath(value)) {
    throw new Error(`${label} uses an unsupported Windows path prefix.`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  const resolved = path.resolve(value);
  if (process.platform !== 'win32' && isBlockedUnixPath(resolved)) {
    throw new Error(`${label} points to a blocked system path.`);
  }
  return resolved;
}

function isPathWithinBase(basePath, targetPath) {
  const rel = path.relative(basePath, targetPath);
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveExistingDirectoryPath(rawPath, label) {
  const absolute = assertAbsolutePath(rawPath, label);
  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (err) {
    throw new Error(`${label} does not exist: ${absolute}. ${err.message}`);
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new Error('not a directory');
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
    return real;
  } catch (err) {
    throw new Error(`${label} not accessible: ${real}. ${err.message}`);
  }
}

function resolveExistingReadableFilePath(rawPath, label) {
  const absolute = assertAbsolutePath(rawPath, label);
  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch (err) {
    throw new Error(`${label} does not exist: ${absolute}. ${err.message}`);
  }
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('not a file');
    fs.accessSync(real, fs.constants.R_OK);
    return real;
  } catch (err) {
    throw new Error(`${label} not readable: ${real}. ${err.message}`);
  }
}

function assertPathWithinBase(basePath, targetPath, label) {
  if (!isPathWithinBase(basePath, targetPath)) {
    throw new Error(`${label} must stay inside the selected export folder.`);
  }
}

function assertFileReadable(filePath, label) {
  resolveExistingReadableFilePath(filePath, label);
}

function ensureWritableDir(dirPath) {
  const safeDir = resolveExistingDirectoryPath(dirPath, 'Export folder');
  const testPath = path.join(safeDir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(testPath, '');
    fs.unlinkSync(testPath);
  } catch (err) {
    throw new Error(`Export folder not writable: ${safeDir}. ${err.message}`);
  }
}

function getAppLogDir() {
  app.setAppLogsPath();
  const logsRoot = app.getPath('logs');
  const appLogDir = path.join(logsRoot, 'Album-to-Video');
  ensureDir(appLogDir);
  return appLogDir;
}

function findLatestSessionLogPath(appLogDir) {
  try {
    const files = fs.readdirSync(appLogDir)
      .filter((name) => /^session-.*\.jsonl$/i.test(name))
      .map((name) => {
        const fullPath = path.join(appLogDir, name);
        const stat = fs.statSync(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.fullPath || null;
  } catch {
    return null;
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

function sanitizeAlbumFolderName(name) {
  let cleaned = sanitizeFileBaseName(name || 'Album');
  if (cleaned === '.' || cleaned === '..') cleaned = 'Album';
  return cleaned;
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

function normalizeTrackNo(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function buildOutputBaseForPreset(rawBase, trackNo, shouldPrefixTrackNo) {
  const base = sanitizeFileBaseName(rawBase);
  if (!shouldPrefixTrackNo || !Number.isInteger(trackNo) || trackNo <= 0) return base;
  const prefixed = `${String(trackNo).padStart(2, '0')}. ${base}`;
  return sanitizeFileBaseName(prefixed);
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
  if (!proc || proc.killed) return Promise.resolve();

  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          ['/PID', String(proc.pid), '/T', '/F'],
          { windowsHide: true },
        );
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          setTimeout(resolve, 100);
        };
        killer.on('close', finish);
        killer.on('error', finish);
        setTimeout(() => {
          if (!done && sessionLogger?.warn) {
            sessionLogger.warn('process.kill.timeout', {
              pid: proc?.pid,
              platform: process.platform,
            });
          }
          finish();
        }, 2000);
        return;
      }

      try { proc.kill('SIGTERM'); } catch {}

      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 800);
    } catch {
      resolve();
    }
  });
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

function runFfmpegValidationProbe(audioPath, timeoutMs) {
  return new Promise((resolve) => {
    if (!FFMPEG_BIN || !path.isAbsolute(FFMPEG_BIN)) {
      resolve({ ok: false, stderr: 'ffmpeg binary missing' });
      return;
    }

    const p = spawn(FFMPEG_BIN, [
      '-v', 'error',
      '-i', audioPath,
      '-f', 'null',
      '-',
    ], { windowsHide: true });

    let stderr = '';
    const STDERR_MAX = 16 * 1024;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch {}
    }, Math.max(1000, timeoutMs || 0));

    p.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX);
    });

    p.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve({ ok: false, stderr: `${stderr}\nprobe timeout`.trim() });
        return;
      }
      resolve({ ok: code === 0, stderr });
    });

    p.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, stderr: String(err?.message || err || 'ffmpeg probe error') });
    });
  });
}

async function durationFromMetadata(audioPath) {
  try {
    const mm = getMusicMetadata();
    const meta = await mm.parseFile(audioPath, { duration: true });
    const durationSec = Number(meta?.format?.duration || 0);
    if (Number.isFinite(durationSec) && durationSec > 0) return durationSec;
  } catch {}
  return 0;
}

async function probeAudioInfo(audioPath, timeoutMs) {
  resolveBundledBinaries();
  const safeTimeoutMs = Math.max(1000, timeoutMs || 5000);
  const extension = String(path.extname(audioPath || '') || '').toLowerCase();
  let probeMethod = 'ffprobe';
  let errorTail = '';

  if (FFPROBE_BIN && path.isAbsolute(FFPROBE_BIN)) {
    const data = await runFfprobeJson([
      '-v', 'error',
      '-show_entries', 'stream=codec_type,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      audioPath,
    ], safeTimeoutMs);

    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const hasAudio = streams.some((s) => s.codec_type === 'audio');
    const streamDur = streams.find((s) => s.codec_type === 'audio')?.duration;
    const formatDur = data?.format?.duration;
    const durationSec = parseFloat(String(streamDur || formatDur || '0'));
    const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;

    if (hasAudio && safeDuration > 0) {
      return { ok: true, durationSec: safeDuration, probeMethod };
    }
    errorTail = 'ffprobe returned no audio stream or invalid duration';
  } else {
    probeMethod = 'ffmpeg-fallback';
    errorTail = 'ffprobe missing';
  }

  const fallback = await runFfmpegValidationProbe(audioPath, safeTimeoutMs);
  const fallbackMethod = FFPROBE_BIN ? 'ffmpeg-fallback' : 'ffmpeg';
  if (fallback.ok) {
    const metadataDuration = await durationFromMetadata(audioPath);
    const safeDuration = metadataDuration > 0 ? metadataDuration : 1;
    return {
      ok: true,
      durationSec: safeDuration,
      probeMethod: fallbackMethod,
    };
  }

  const stderrTail = tailLines(fallback.stderr || errorTail, 6).slice(0, 300);
  sessionLogger?.warn('audio.probe_unsupported', {
    extension,
    probeMethod: fallbackMethod,
    stderrTail,
  });
  return {
    ok: false,
    durationSec: 0,
    probeMethod: fallbackMethod,
    stderrTail,
  };
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
  const preset = getPreset(presetKey);
  const fps = GLOBAL_FPS;
  const videoArgs = typeof preset.engine.video === 'function' ? preset.engine.video() : preset.engine.video;
  const vf = preset.engine.vf;
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
  const requestedExportFolder = assertAbsolutePath(exportFolder, 'Export folder');
  if (!lastSelectedExportFolder) throw new Error('Export folder was not selected from the picker.');
  const selectedExportFolder = resolveExistingDirectoryPath(lastSelectedExportFolder, 'Selected export folder');
  const resolvedExportFolder = resolveExistingDirectoryPath(requestedExportFolder, 'Export folder');
  assertPathWithinBase(selectedExportFolder, resolvedExportFolder, 'Export folder');
  ensureWritableDir(resolvedExportFolder);

  const preset = getPreset(presetKey);
  const resolvedPresetKey = preset.key;
  const policy = preset.policy || {};
  const maxTracks = Number.isInteger(policy.maxTracks) ? policy.maxTracks : null;
  if (Number.isInteger(maxTracks) && tracks.length > maxTracks) {
    const e = new Error(`Preset "${preset.label}" supports up to ${maxTracks} track(s).`);
    e.code = REASON_CODES.UNCAUGHT;
    throw e;
  }

  const normalizedTracks = tracks.map((t, i) => {
    if (!t?.audioPath || typeof t.audioPath !== 'string') {
      throw new Error(`Invalid audio path for track ${i + 1}`);
    }
    const trackNo = normalizeTrackNo(t.trackNo);
    const hasTrackNo = Boolean(t.hasTrackNo) && Number.isInteger(trackNo);
    const outputBaseRaw = sanitizeFileBaseName(t.outputBase || `Track ${i + 1}`);
    return {
      audioPath: t.audioPath,
      outputBaseRaw,
      trackNo: hasTrackNo ? trackNo : null,
      hasTrackNo,
      inputIndex: i,
    };
  });

  const orderingPolicy = policy.ordering || 'input';
  const allTracksHaveTrackNo = normalizedTracks.length > 0
    && normalizedTracks.every((t) => t.hasTrackNo && Number.isInteger(t.trackNo));
  let orderingApplied = 'input';
  let orderedTracks = normalizedTracks.slice();
  if (orderingPolicy === 'track_no_if_all_present' && allTracksHaveTrackNo) {
    orderedTracks.sort((a, b) => {
      if (a.trackNo !== b.trackNo) return a.trackNo - b.trackNo;
      return a.inputIndex - b.inputIndex;
    });
    orderingApplied = 'track_no';
  }

  const prefixTrackNumber = Boolean(policy.prefixTrackNumber);
  const presetDecisions = {
    orderingPolicy,
    orderingApplied,
    allTracksHaveTrackNo,
    prefixTrackNumber,
    maxTracks,
  };
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reservedOutputs = new Set();
  const plannedTracks = [];

  for (let i = 0; i < orderedTracks.length; i++) {
    const t = orderedTracks[i];
    assertFileReadable(t.audioPath, `Audio file ${i + 1}`);

    const outputBase = buildOutputBaseForPreset(
      t.outputBaseRaw,
      t.trackNo,
      prefixTrackNumber,
    );
    const outputFinalPath = uniquePlannedOutputPath(resolvedExportFolder, outputBase, '.mp4', reservedOutputs);
    const partialPath = buildPartialPath(outputFinalPath);
    const probe = await probeAudioInfo(t.audioPath, 5000);
    const durationSec = Number(probe?.durationSec || 0);
    if (!probe?.ok || !Number.isFinite(durationSec) || durationSec <= 0) {
      const e = new Error(`Probe failed for track ${i + 1}: ${t.audioPath}`);
      e.code = REASON_CODES.PROBE_FAILED;
      throw e;
    }

    plannedTracks.push({
      audioPath: t.audioPath,
      trackNo: t.trackNo,
      durationSec,
      outputBase,
      outputFinalPath,
      partialPath,
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
    exportFolder: resolvedExportFolder,
    presetKey: resolvedPresetKey,
    presetDecisions,
    imagePath,
    totalDurationSec,
    tracks: plannedTracks,
  };
}

function buildPartialPath(finalPath) {
  return `${String(finalPath || '')}.partial`;
}

function isPartialPath(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.partial');
}

function validatePartialOutput(partialPath) {
  if (!isPartialPath(partialPath)) {
    const e = new Error(`Partial output path invalid: ${partialPath}`);
    e.code = REASON_CODES.UNCAUGHT;
    throw e;
  }
  const stat = fs.statSync(partialPath);
  if (!stat.isFile() || stat.size <= 0) {
    const e = new Error(`Partial output invalid: ${partialPath}`);
    e.code = REASON_CODES.FFMPEG_EXIT_NONZERO;
    throw e;
  }
}

function listPartialOutputs(outputFolder) {
  if (!outputFolder || !fs.existsSync(outputFolder)) return [];
  try {
    return fs.readdirSync(outputFolder)
      .filter((name) => String(name || '').toLowerCase().endsWith('.partial'))
      .map((name) => path.join(outputFolder, name));
  } catch {
    return [];
  }
}

function listPartialOutputsRecursive(baseDir, { maxDepth = 2, maxMatches = 25 } = {}) {
  const root = String(baseDir || '');
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const walk = (dirPath, depth) => {
    if (out.length >= maxMatches || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxMatches) return;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isFile() && String(entry.name || '').toLowerCase().endsWith('.partial')) {
        out.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) walk(entryPath, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function redactPathForLog(filePath) {
  const raw = String(filePath || '');
  if (!raw) return raw;
  try {
    return typeof redactSensitivePathSegments === 'function'
      ? redactSensitivePathSegments(raw)
      : raw;
  } catch {
    return raw;
  }
}

function logStartupPartialArtifacts() {
  const controlledRoots = new Set();
  try {
    controlledRoots.add(getAppLogDir());
  } catch {}
  if (!app.isPackaged) {
    ['tmp', 'test-artifacts', 'fixtures'].forEach((relDir) => {
      const full = path.join(__dirname, relDir);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
          controlledRoots.add(full);
        }
      } catch {}
    });
  }

  const roots = [...controlledRoots];
  if (roots.length === 0) return;

  const perRoot = [];
  const matches = [];
  roots.forEach((rootPath) => {
    const found = listPartialOutputsRecursive(rootPath, { maxDepth: 2, maxMatches: 25 });
    perRoot.push({ root: redactPathForLog(rootPath), count: found.length });
    found.forEach((filePath) => matches.push(filePath));
  });

  sessionLogger?.info?.('startup.partial_scan', {
    foundCount: matches.length,
    rootsScanned: roots.length,
    examples: matches.slice(0, 5).map((p) => redactPathForLog(p)),
    rootsWithMatches: perRoot.filter((item) => item.count > 0),
  });
}

function movePartialToFinalOutput(partialPath, outputFinalPath) {
  try {
    fs.renameSync(partialPath, outputFinalPath);
    return { exdevFallback: false, method: 'rename' };
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(partialPath, outputFinalPath);
    const stat = fs.statSync(outputFinalPath);
    if (!stat.isFile() || stat.size <= 0) {
      const e = new Error(`EXDEV fallback produced invalid output: ${outputFinalPath}`);
      e.code = REASON_CODES.UNCAUGHT;
      throw e;
    }
    fs.unlinkSync(partialPath);
    return { exdevFallback: true, method: 'copy_unlink_exdev' };
  }
}

function emitFinalizeStep(jobId, step, extra = {}) {
  const payload = { jobId, ...extra };
  sessionLogger?.info?.(step, payload);
  perfMark(step, payload);
}

function firstLine(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || '';
}

function humanMessageForReason(code, err) {
  const raw = String(err?.message || '').trim();

  if (code === REASON_CODES.CANCELLED) return 'Export cancelled.';
  if (code === REASON_CODES.TIMEOUT) {
    return 'Export timed out. Try fewer tracks or shorter files, then export again.';
  }
  if (code === REASON_CODES.PROBE_FAILED) {
    return 'One or more audio files could not be read. Re-add the file or convert it to WAV, MP3, or M4A.';
  }
  if (code === REASON_CODES.FFMPEG_EXIT_NONZERO) {
    return 'Encoding failed for at least one track. Try again, or enable debug logging for details.';
  }

  if (/No tracks to export/i.test(raw)) return 'No tracks selected. Add at least one audio file.';
  if (/Missing cover art/i.test(raw)) return 'Cover art is missing. Choose an image before exporting.';
  if (/Missing export folder/i.test(raw)) return 'Export folder is missing. Choose where to save the videos.';
  if (/Preset ".*" supports up to \d+ track\(s\)\./i.test(raw)) return firstLine(raw);
  if (/Export folder not writable/i.test(raw)) {
    return 'The selected export folder is not writable. Choose a different folder.';
  }
  if (/Bundled ffmpeg is required but not available/i.test(raw) || /Bundled ffprobe is required but not available/i.test(raw)) {
    return 'The render engine is unavailable in this build. Reinstall or rebuild the app.';
  }

  return firstLine(raw) || 'Unexpected export failure.';
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
      trackNo: Number.isFinite(Number(t?.trackNo)) ? Number(t.trackNo) : null,
      hasTrackNo: Boolean(t?.hasTrackNo),
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

function writeNonSuccessRenderReportToAppLogs(jobId, report) {
  app.setAppLogsPath();
  const logsRoot = app.getPath('logs');
  const appLogDir = path.join(logsRoot, 'Album-to-Video');
  ensureDir(appLogDir);
  const safeJobId = sanitizeFileBaseName(jobId || `cancel-${formatTimestampForFile()}`);
  const reportPath = path.join(appLogDir, `render-report-${safeJobId}.json`);
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
  perfMark('createWindow.start');
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (process.platform === 'win32') {
    try { mainWindow.removeMenu(); } catch {}
  }
  try {
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay?.();
    sessionLogger?.info?.('dpi.main', {
      primary: d ? {
        scaleFactor: d.scaleFactor,
        size: d.size,
        workAreaSize: d.workAreaSize,
        bounds: d.bounds,
      } : null,
      windowBounds: mainWindow.getBounds(),
    });
  } catch {}

  perfMark('createWindow.end');
  mainWindow.once('ready-to-show', () => {
    perfMark('window.ready-to-show');
    mainWindow.show();

    // Warm up binary resolution after window is visible.
    setTimeout(() => {
      perfMark('binaryWarmup.start');
      resolveBundledBinaries();
      perfMark('binaryWarmup.end', {
        ffmpegSource: FFMPEG_SOURCE || 'missing',
        ffprobeSource: FFPROBE_SOURCE || 'missing',
      });
    }, 0);
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      await mainWindow.webContents.setZoomFactor(1);
      await mainWindow.webContents.setZoomLevel(0);
      await mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    } catch {}
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const ctrlOrCmd = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if ((input.type === 'mouseWheel' && ctrlOrCmd) || input.type === 'gesturePinch') {
      event.preventDefault();
      return;
    }
    if (ctrlOrCmd && (key === '+' || key === '-' || key === '=' || key === '0')) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.once('did-finish-load', () => perfMark('loadURL.end'));
  perfMark('loadURL.start', { url: 'index.html' });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  perfMark('app.ready');
  createWindow();
  // Keep window creation first; non-UI startup work runs after the window begins loading.
  setTimeout(() => {
    try {
      sessionLogger = createSessionLogger(app, { appFolderName: 'Album-to-Video', keepLatest: 20 });
      sessionLogger.info('app.ready', {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
      });
      resolveBundledBinaries();
      sessionLogger.info('engine.binaries', {
        ...getEngineBinariesSnapshot(),
      });
      sessionLogger.info('engine.startup_probe', buildEnginePathProbe());
      try {
        const { screen } = require('electron');
        const d = screen.getPrimaryDisplay?.();
        sessionLogger.info('dpi.main', {
          primary: d ? {
            scaleFactor: d.scaleFactor,
            size: d.size,
            workAreaSize: d.workAreaSize,
            bounds: d.bounds,
          } : null,
          windowBounds: mainWindow?.getBounds?.() || null,
        });
      } catch {}
      try {
        logStartupPartialArtifacts();
      } catch (err) {
        sessionLogger?.warn?.('startup.partial_scan_failed', {
          message: String(err?.message || err),
        });
      }
    } catch (err) {
      console.error('[session_logger_init_failed]', String(err?.message || err));
    }
  }, 0);
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
registerIpcHandler('select-audios', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'aif', 'aiff', 'flac', 'm4a', 'aac', 'ogg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : (result.filePaths || []);
});

registerIpcHandler('select-image', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : (result.filePaths?.[0] || null);
});

registerIpcHandler('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) return null;
  const pickedPath = result.filePaths?.[0] || null;
  if (!pickedPath) return null;
  const safePath = resolveExistingDirectoryPath(pickedPath, 'Export folder');
  lastSelectedExportFolder = safePath;
  return safePath;
});

registerIpcHandler('list-presets', async () => listPresets());

registerIpcHandler('dpi-probe', async (_event, payload) => {
  sessionLogger?.info?.('dpi.renderer', payload || {});
  return true;
});

registerIpcHandler('ensure-dir', async (_event, payload) => {
  if (!lastSelectedExportFolder) throw new Error('Export folder not selected.');
  const selectedExportFolder = resolveExistingDirectoryPath(lastSelectedExportFolder, 'Export folder');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid ensure-dir payload.');
  }
  const rawAlbumFolderName = payload.albumFolderName;
  const albumFolderName = sanitizeAlbumFolderName(rawAlbumFolderName);
  const requestedDir = path.join(selectedExportFolder, albumFolderName);
  ensureDir(requestedDir);
  const resolvedDir = resolveExistingDirectoryPath(requestedDir, 'Release folder');
  assertPathWithinBase(selectedExportFolder, resolvedDir, 'Release folder');
  return resolvedDir;
});

registerIpcHandler('open-folder', async (_event, folderPath) => {
  const safeFolder = resolveExistingDirectoryPath(folderPath, 'Folder');
  const pendingPartials = listPartialOutputs(safeFolder);
  if (pendingPartials.length > 0) {
    throw new Error('Cannot open folder while partial outputs exist.');
  }
  const err = await shell.openPath(safeFolder);
  if (err) throw new Error(`Failed to open folder: ${err}`);
  return true;
});

ipcMain.on('perf-mark', (_event, payload) => {
  const mark = String(payload?.mark || '').trim();
  if (!mark) return;
  perfMark(mark, { source: 'renderer' });
});

// ---------------- Metadata ----------------
registerIpcHandler('read-metadata', async (_event, filePath) => {
  try {
    const safeFilePath = resolveExistingReadableFilePath(filePath, 'Audio file');
    const mm = getMusicMetadata();
    const meta = await mm.parseFile(safeFilePath, { duration: false });
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

registerIpcHandler('probe-audio', async (_event, filePath) => {
  try {
    const safeFilePath = resolveExistingReadableFilePath(filePath, 'Audio file');
    return await probeAudioInfo(safeFilePath, 5000);
  } catch {
    return { ok: false, durationSec: 0 };
  }
});

// ---------------- Render job (album-level) ----------------
registerIpcHandler('cancel-render', async () => {
  if (!currentJob.active) return true;
  currentJob.cancelled = true;
  currentJob.cancelReason = REASON_CODES.CANCELLED;
  await cleanupJob(currentJob.id, REASON_CODES.CANCELLED, currentJob.cleanupContext);
  return true;
});

registerIpcHandler('export-diagnostics', async (_event, payload) => {
  const requestedExportFolder = String(payload?.exportFolder || '').trim();
  let destinationDir;
  let renderReportPath = null;

  if (requestedExportFolder) {
    const safeExportFolder = resolveExistingDirectoryPath(requestedExportFolder, 'Export folder');
    if (lastSelectedExportFolder) {
      const selectedExportFolder = resolveExistingDirectoryPath(lastSelectedExportFolder, 'Selected export folder');
      assertPathWithinBase(selectedExportFolder, safeExportFolder, 'Export folder');
    }
    destinationDir = path.join(safeExportFolder, 'Logs');
    ensureDir(destinationDir);
    renderReportPath = path.join(destinationDir, 'render-report.json');
  } else {
    destinationDir = getAppLogDir();
  }

  const appLogDir = getAppLogDir();
  const sessionLogPath = sessionLogger?.filePath || findLatestSessionLogPath(appLogDir);
  const appInfo = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    execPath: process.execPath || null,
    resourcesPath: process.resourcesPath || null,
  };
  const engineInfo = {
    GLOBAL_FPS,
    binaries: getEngineBinariesSnapshot(),
    startup_probe: buildEnginePathProbe(),
  };

  const { diagnosticsPath } = await exportDiagnosticsBundle({
    destinationDir,
    appInfo,
    engineInfo,
    sessionLogPath,
    renderReportPath,
    pinnedWinBinaryHashes: getPinnedWinBinaryHashes(),
    maxLogEvents: MAX_LOG_EVENTS,
  });
  sessionLogger?.info?.('diagnostics.exported', { diagnosticsPath, requestedExportFolder: requestedExportFolder || null });
  return { ok: true, diagnosticsPath };
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
  jobTotalMs,
  jobDoneMsBeforeTrack,
  getHasRealSignal,
  markHasRealSignal,
  audioMode,
  jobId,
}) {
  const log = typeof debugLog === 'function' ? debugLog : null;
  const outputForProgress = progressOutputPath || outputPath;
  const baseArgs = Array.isArray(ffmpegArgsBase) ? ffmpegArgsBase.slice() : [];

  return new Promise(async (resolve, reject) => {
    if (!isPartialPath(outputPath)) {
      const e = new Error(`Render output must use .partial staging path: ${outputPath}`);
      e.code = REASON_CODES.UNCAUGHT;
      reject(e);
      return;
    }

    const dSec = Number(durationSec || 0);
    if (!Number.isFinite(dSec) || dSec <= 0) {
      const e = new Error(`Invalid planned duration for track ${trackIndex + 1}`);
      e.code = REASON_CODES.PROBE_FAILED;
      reject(e);
      return;
    }
    const durationKnown = Number.isFinite(dSec) && dSec > 0.25;
    const durationMs = durationKnown ? Math.floor(dSec * 1000) : 0;
    const safeTrackCount = Math.max(1, Number(trackCount) || 1);
    const safeJobTotalMs = Math.floor(Number(jobTotalMs || 0));
    const jobDoneBaseMs = Math.max(0, Math.floor(Number(jobDoneMsBeforeTrack || 0)));

    let stderr = '';
    const STDERR_MAX = 64 * 1024;
    let killedByTimeout = false;

    const effectiveLogLevel = log ? 'info' : (logLevel || 'error');
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let lastOutTimeMs = 0;
    let trackMaxOutTimeMs = 0;
    let lastSentJobDoneMs = jobDoneBaseMs;
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
    const buildProgressPayload = ({
      percentTrack,
      phase,
      isFinal,
      indeterminate,
      jobDoneMs,
    }) => {
      const safeDoneMs = Math.max(0, Math.min(safeJobTotalMs, Math.floor(Number(jobDoneMs || 0))));
      const hasRealSignal = typeof getHasRealSignal === 'function' && getHasRealSignal() === true;
      const rawProgress = (hasRealSignal && safeJobTotalMs > 0)
        ? Math.max(0, Math.min(1, safeDoneMs / safeJobTotalMs))
        : null;
      const safePercentTrack = Math.max(0, Math.min(99.9, Number(percentTrack || 0)));
      const safePercentTotal = rawProgress === null
        ? 0
        : Math.max(0, Math.min(99.9, rawProgress * 100));
      return {
        trackIndex,
        trackCount: safeTrackCount,
        audioPath,
        outputPath: outputForProgress,
        percentTrack: safePercentTrack,
        percentTotal: safePercentTotal,
        indeterminate: Boolean(indeterminate),
        isFinal: Boolean(isFinal),
        phase,
        jobTotalMs: safeJobTotalMs,
        jobDoneMs: safeDoneMs,
        hasRealSignal,
        rawProgress,
      };
    };
    const args = [
      ...baseArgs,
      '-loglevel', effectiveLogLevel,

      // 7) Robust progress
      '-progress', 'pipe:1',
      '-nostats',
      '-f', 'mp4',

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
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    currentJob.ffmpeg = ff;
    if (currentJob.cleanupContext) {
      currentJob.cleanupContext.activeProcess = ff;
    }

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
            trackMaxOutTimeMs = Math.max(trackMaxOutTimeMs, Math.max(0, v));
            if (trackMaxOutTimeMs > 0 && typeof markHasRealSignal === 'function') {
              markHasRealSignal();
            }
            const doneMs = jobDoneBaseMs + trackMaxOutTimeMs;
            lastSentJobDoneMs = doneMs;
            if (durationKnown) {
              const pctTrack = computePercentTrack();
              event.sender.send('render-progress', buildProgressPayload({
                percentTrack: pctTrack || 0,
                phase: 'ENCODING',
                isFinal: false,
                indeterminate: false,
                jobDoneMs: doneMs,
              }));
            } else {
              event.sender.send('render-progress', buildProgressPayload({
                percentTrack: 0,
                phase: 'ENCODING',
                isFinal: false,
                indeterminate: true,
                jobDoneMs: doneMs,
              }));
            }
          }
        } else if (line === 'progress=end') {
          const doneMs = jobDoneBaseMs + trackMaxOutTimeMs;
          lastSentJobDoneMs = doneMs;
          const isLastTrack = trackIndex === (safeTrackCount - 1);
          event.sender.send('render-progress', buildProgressPayload({
            percentTrack: 99.9,
            phase: isLastTrack ? 'FINALIZING' : 'ENCODING',
            isFinal: true,
            indeterminate: false,
            jobDoneMs: doneMs,
          }));
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
          jobDoneMs: lastSentJobDoneMs,
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

registerIpcHandler('render-album', async (event, payload) => {
  const { timeoutPerTrackMs, debug, createAlbumFolder } = payload || {};

  event.sender.send('render-status', { phase: 'planning' });
  const plan = await buildRenderPlan(payload);

  const jobId = plan.jobId;
  const exportFolder = plan.exportFolder;
  const selectedExportFolder = resolveExistingDirectoryPath(lastSelectedExportFolder, 'Selected export folder');
  currentJob.cancelled = false;
  currentJob.cancelReason = null;
  currentJob.active = true;
  currentJob.id = jobId;
  currentJob.cleanupContext = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    activeProcess: null,
    getActiveProcess: () => currentJob.cleanupContext?.activeProcess || null,
    killProcessTree,
    killWaitTimeoutMs: 1500,
    currentTrackPartialPath: null,
    currentTrackTmpPath: null,
    partialPaths: new Set(),
    tmpPaths: new Set(),
    plannedFinalOutputs: new Set(plan.tracks.map((t) => t.outputFinalPath)),
    completedFinalOutputs: new Set(),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder: exportFolder,
    baseExportFolder: lastSelectedExportFolder || null,
    createAlbumFolder: Boolean(createAlbumFolder),
    safeRmdirIfEmpty,
    logger: sessionLogger,
  };

  const rendered = [];
  const tracks = plan.tracks;
  let debugLogger = null;
  const totalDurationSec = plan.totalDurationSec;
  const totalDurationKnown = totalDurationSec > 0;
  const jobTotalMs = tracks.reduce((sum, t) => {
    const ms = Math.floor(Math.max(0, Number(t?.durationSec || 0)) * 1000);
    return sum + (Number.isFinite(ms) ? ms : 0);
  }, 0);
  let jobDoneMs = 0;
  let jobHasRealSignal = false;
  const markJobHasRealSignal = () => { jobHasRealSignal = true; };
  const getJobHasRealSignal = () => jobHasRealSignal;
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
    presetKey: plan.presetKey,
    presetDecisions: plan.presetDecisions || null,
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
    cleanup: {
      cleanupDeletedTmpCount: 0,
      cleanupDeletedFinalCount: 0,
      cleanupRemovedEmptyFolder: false,
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
    if (jobTotalMs <= 0) {
      sessionLogger?.warn('progress.job_total_missing', {
        jobId,
        trackCount: tracks.length,
        totalDurationSec,
        jobTotalMs,
      });
    }
    event.sender.send('render-progress', {
      trackIndex: 0,
      trackCount: Math.max(1, tracks.length),
      phase: 'PREPARING',
      jobTotalMs,
      jobDoneMs: 0,
      rawProgress: null,
      hasRealSignal: false,
      percentTrack: 0,
      percentTotal: 0,
      indeterminate: true,
      isFinal: false,
    });

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
      const partialPath = trackPlan.partialPath;
      if (!isPartialPath(partialPath)) {
        const e = new Error(`Partial output path invalid: ${partialPath}`);
        e.code = REASON_CODES.UNCAUGHT;
        throw e;
      }
      safeUnlink(partialPath);
      currentJob.cleanupContext.currentTrackPartialPath = partialPath;
      currentJob.cleanupContext.currentTrackTmpPath = partialPath;
      currentJob.cleanupContext.partialPaths.add(partialPath);
      currentJob.cleanupContext.tmpPaths.add(partialPath);
      const trackReport = {
        inputPath: audioPath,
        durationSec: trackPlan.durationSec || 0,
        outputFinalPath,
        partialPath,
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
          outputPath: partialPath,
          progressOutputPath: outputFinalPath,
          ffmpegArgsBase: trackPlan.ffmpegArgsBase,
          logLevel: 'error',
          trackIndex: i,
          trackCount: tracks.length,
          timeoutMs: timeoutPerTrackMs || 30 * 60 * 1000,
          debugLog: debugLogger?.log,
          durationSec: trackPlan.durationSec,
          jobTotalMs,
          jobDoneMsBeforeTrack: jobDoneMs,
          getHasRealSignal: getJobHasRealSignal,
          markHasRealSignal: markJobHasRealSignal,
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
        safeUnlink(partialPath);

        runResult = await runFfmpegStillImage({
          event,
          audioPath,
          outputPath: partialPath,
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
          jobTotalMs,
          jobDoneMsBeforeTrack: jobDoneMs,
          getHasRealSignal: getJobHasRealSignal,
          markHasRealSignal: markJobHasRealSignal,
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
      jobDoneMs = Math.max(jobDoneMs, Math.floor(Number(runResult?.jobDoneMs || 0)));

      validatePartialOutput(partialPath);
      currentJob.cleanupContext.currentTrackPartialPath = null;
      currentJob.cleanupContext.currentTrackTmpPath = null;
      if (currentJob.cleanupContext) {
        currentJob.cleanupContext.activeProcess = null;
      }
    }

    event.sender.send('render-status', { phase: 'finalizing' });
    const finalizingRaw = (jobHasRealSignal && jobTotalMs > 0)
      ? Math.max(0, Math.min(0.999, jobDoneMs / jobTotalMs))
      : null;
    event.sender.send('render-progress', {
      trackIndex: Math.max(0, tracks.length - 1),
      trackCount: Math.max(1, tracks.length),
      phase: 'FINALIZING',
      jobTotalMs,
      jobDoneMs,
      rawProgress: finalizingRaw,
      hasRealSignal: jobHasRealSignal,
      percentTrack: 99.9,
      percentTotal: 99.9,
      indeterminate: false,
      isFinal: true,
    });

    emitFinalizeStep(jobId, 'finalize.start', { exportFolder, trackCount: tracks.length });
    const finalizeStartedAtMs = Date.now();
    const finalizeSummary = {
      renameMs: 0,
      reportMs: 0,
      cleanupMs: 0,
      totalMs: 0,
    };

    emitFinalizeStep(jobId, 'finalize.rename_outputs.start', { pendingCount: tracks.length });
    const renameStartedAtMs = Date.now();
    let renamedCount = 0;
    let exdevFallbackCount = 0;
    for (const trackPlan of tracks) {
      const partialPath = trackPlan.partialPath;
      const outputFinalPath = trackPlan.outputFinalPath;
      assertPathWithinBase(selectedExportFolder, partialPath, 'Partial output');
      assertPathWithinBase(selectedExportFolder, outputFinalPath, 'Final output');
      validatePartialOutput(partialPath);
      const moveResult = movePartialToFinalOutput(partialPath, outputFinalPath);
      if (moveResult.exdevFallback) exdevFallbackCount += 1;
      currentJob.cleanupContext.partialPaths.delete(partialPath);
      currentJob.cleanupContext.tmpPaths.delete(partialPath);
      currentJob.cleanupContext.completedFinalOutputs.add(outputFinalPath);
      rendered.push({ audioPath: trackPlan.audioPath, outputPath: outputFinalPath });
      renamedCount += 1;
    }
    finalizeSummary.renameMs = Date.now() - renameStartedAtMs;
    emitFinalizeStep(jobId, 'finalize.rename_outputs.method', {
      method: exdevFallbackCount > 0 ? 'copy_unlink_exdev' : 'rename',
      exdevFallback: exdevFallbackCount > 0,
    });
    emitFinalizeStep(jobId, 'finalize.rename_outputs.end', {
      renamedCount,
      exdevFallback: exdevFallbackCount > 0,
      exdevFallbackCount,
    });

    emitFinalizeStep(jobId, 'finalize.write_report.start');
    const reportStartedAtMs = Date.now();

    report.job.status = 'SUCCESS';
    report.job.reasonCode = '';
    report.job.humanMessage = 'Render completed successfully.';
    report.job.endTs = new Date().toISOString();
    report.job.durationMs = Date.now() - jobStartedAtMs;
    reportPath = writeRenderReport(exportFolder, report);
    finalizeSummary.reportMs = Date.now() - reportStartedAtMs;
    emitFinalizeStep(jobId, 'finalize.write_report.end', { reportPath });

    emitFinalizeStep(jobId, 'finalize.cleanup.start');
    const cleanupStartedAtMs = Date.now();
    const danglingPartials = listPartialOutputs(exportFolder);
    danglingPartials.forEach((partialPath) => {
      safeUnlink(partialPath);
      currentJob.cleanupContext.partialPaths.delete(partialPath);
      currentJob.cleanupContext.tmpPaths.delete(partialPath);
    });
    const partialsRemaining = listPartialOutputs(exportFolder);
    if (partialsRemaining.length > 0) {
      const e = new Error(`Finalize cleanup left partial outputs: ${partialsRemaining.length}`);
      e.code = REASON_CODES.UNCAUGHT;
      throw e;
    }
    finalizeSummary.cleanupMs = Date.now() - cleanupStartedAtMs;
    finalizeSummary.totalMs = Date.now() - finalizeStartedAtMs;
    emitFinalizeStep(jobId, 'finalize.cleanup.end', { removedPartialCount: danglingPartials.length });
    emitFinalizeStep(jobId, 'finalize.summary', {
      renamedCount,
      exdevFallback: exdevFallbackCount > 0,
      exdevFallbackCount,
      ...finalizeSummary,
    });
    emitFinalizeStep(jobId, 'finalize.end', { renderedCount: rendered.length, reportPath, ...finalizeSummary });

    sessionLogger?.info('render.success', { jobId, renderedCount: rendered.length, reportPath });
    event.sender.send('render-status', { phase: 'success' });

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

    const cleanupStats = await cleanupJob(jobId, reasonCode, currentJob.cleanupContext);
    report.cleanup = {
      cleanupDeletedTmpCount: Number(cleanupStats?.cleanupDeletedTmpCount || 0),
      cleanupDeletedFinalCount: Number(cleanupStats?.cleanupDeletedFinalCount || 0),
      cleanupRemovedEmptyFolder: Boolean(cleanupStats?.cleanupRemovedEmptyFolder),
    };
    sessionLogger?.error('render.failed', {
      jobId,
      reasonCode,
      message: String(err?.message || err),
      trackCount: tracks.length,
    });

    try {
      reportPath = writeNonSuccessRenderReportToAppLogs(jobId, report);
    } catch (reportErr) {
      sessionLogger?.error('report.write_failed', {
        jobId,
        message: String(reportErr?.message || reportErr),
      });
    }

    const publicMessage = report.job.humanMessage || 'Unexpected export failure.';
    return {
      ok: false,
      error: {
        code: reasonCode,
        message: publicMessage,
      },
      reportPath: reportPath || null,
      debugLogPath: debugLogger?.path || null,
      exportFolder,
      rendered,
    };
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
