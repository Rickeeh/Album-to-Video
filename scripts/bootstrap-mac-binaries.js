const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('bootstrap:mac-bins must run on macOS.');
  process.exit(1);
}

const force = process.argv.includes('--force');
const archDir = `darwin-${process.arch}`;
const outDir = path.join(__dirname, '..', 'resources', 'bin', archDir);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyExecutable(src, dest, label) {
  if (!src || !fs.existsSync(src)) {
    throw new Error(`Missing source binary: ${src}`);
  }
  const absSrc = path.resolve(src);
  const absDest = path.resolve(dest);

  if (!force && fs.existsSync(absDest)) {
    console.log(`[skip] ${label}`);
    console.log(`  from: ${absSrc}`);
    console.log(`  to:   ${absDest}`);
    console.log('  reason: destination already exists (use --force to overwrite)');
    return false;
  }

  fs.copyFileSync(src, dest);
  fs.chmodSync(absDest, 0o755);
  console.log(`[copy] ${label}`);
  console.log(`  from: ${absSrc}`);
  console.log(`  to:   ${absDest}`);
  return true;
}

function main() {
  const ffmpegPath = require('ffmpeg-static');
  const ffprobePath = require('@ffprobe-installer/ffprobe').path;

  ensureDir(outDir);
  const ffmpegOut = path.join(outDir, 'ffmpeg');
  const ffprobeOut = path.join(outDir, 'ffprobe');

  const ffmpegCopied = copyExecutable(ffmpegPath, ffmpegOut, 'ffmpeg');
  const ffprobeCopied = copyExecutable(ffprobePath, ffprobeOut, 'ffprobe');

  console.log(`Bootstrapped mac binaries for ${archDir}`);
  console.log(`Output dir: ${path.resolve(outDir)}`);
  if (!ffmpegCopied && !ffprobeCopied) {
    console.log('No files were overwritten.');
  }
}

try {
  main();
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}
