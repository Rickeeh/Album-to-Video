const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`);
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout || '';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileSizeOk(p) {
  try { return fs.statSync(p).size > 1024; } catch { return false; }
}

function probeDurationSeconds(mediaPath) {
  const out = run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ]);
  const n = parseFloat(String(out).trim());
  return Number.isFinite(n) ? n : 0;
}

function main() {
  const keep = process.argv.includes('--keep');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-test-'));
  ensureDir(baseDir);

  const coverPath = path.join(baseDir, 'cover.png');
  const audioPath = path.join(baseDir, 'tone.m4a');
  const outputPath = path.join(baseDir, 'output.mp4');
  const logPath = path.join(baseDir, 'ffmpeg.log');

  run(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=blue:s=1280x720:d=1',
    '-frames:v', '1',
    coverPath,
  ]);

  run(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=2',
    '-c:a', 'aac',
    audioPath,
  ]);

  const args = [
    '-y',
    '-nostdin',
    '-loglevel', 'info',
    '-loop', '1',
    '-framerate', '1',
    '-i', coverPath,
    '-i', audioPath,
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
    '-r', '1',
    '-vsync', 'cfr',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-g', '1',
    '-keyint_min', '1',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ];

  const res = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`, 'utf8');
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Render failed. See log at ${logPath}`);

  const duration = probeDurationSeconds(outputPath);
  const ok = fileSizeOk(outputPath) && duration >= 1.0;

  if (!ok) {
    throw new Error(`Output validation failed. sizeOk=${fileSizeOk(outputPath)} duration=${duration}`);
  }

  console.log('Smoke test passed.');
  console.log(`Output: ${outputPath}`);
  console.log(`Log: ${logPath}`);

  if (!keep) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error('Smoke test failed.');
  console.error(String(err && err.message ? err.message : err));
  process.exitCode = 1;
}
