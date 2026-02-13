const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const base = path.join(__dirname, '..', 'resources', 'bin');
const required = [
  { rel: 'darwin-x64/ffmpeg', arch: 'x64' },
  { rel: 'darwin-x64/ffprobe', arch: 'x64' },
  { rel: 'darwin-arm64/ffmpeg', arch: 'arm64' },
  { rel: 'darwin-arm64/ffprobe', arch: 'arm64' },
];

function isReadableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return;
  } catch {}

  fs.chmodSync(filePath, 0o755);
  fs.accessSync(filePath, fs.constants.X_OK);
  console.log(`[fix] added executable permission: ${filePath}`);
}

function hasExpectedArch(filePath, expectedArch) {
  if (process.platform !== 'darwin') return true;

  let out = '';
  try {
    out = execFileSync('file', ['-b', filePath], { encoding: 'utf8' });
  } catch {
    return false;
  }

  const desc = String(out || '').toLowerCase();
  if (expectedArch === 'x64') return /x86_64|x64/.test(desc);
  if (expectedArch === 'arm64') return /arm64/.test(desc);
  return false;
}

const missing = required
  .map((entry) => ({ ...entry, abs: path.join(base, entry.rel) }))
  .filter((entry) => !isReadableFile(entry.abs));

if (missing.length) {
  console.error('Missing vendored mac binaries required for universal build:');
  missing.forEach((entry) => console.error(`- ${entry.rel}`));
  console.error('');
  console.error('Fix:');
  console.error('1) Run `npm run bootstrap:mac-bins` on an Apple Silicon Mac.');
  console.error('2) Run `npm run bootstrap:mac-bins` on an Intel Mac.');
  console.error('3) Ensure both folders exist locally for this build: resources/bin/darwin-arm64 and resources/bin/darwin-x64.');
  process.exit(1);
}

for (const entry of required.map((e) => ({ ...e, abs: path.join(base, e.rel) }))) {
  try {
    ensureExecutable(entry.abs);
  } catch {
    console.error(`Not executable and chmod failed: ${entry.rel}`);
    process.exit(1);
  }
}

const wrongArch = required
  .map((entry) => ({ ...entry, abs: path.join(base, entry.rel) }))
  .filter((entry) => !hasExpectedArch(entry.abs, entry.arch));

if (wrongArch.length) {
  console.error('Architecture mismatch in vendored mac binaries:');
  wrongArch.forEach((entry) => console.error(`- ${entry.rel} (expected ${entry.arch})`));
  process.exit(1);
}

console.log('All required mac vendored binaries are present.');
