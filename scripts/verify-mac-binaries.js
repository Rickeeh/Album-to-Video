const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  BINARY_CONTRACT_VERSION,
  getBinaryContractTarget,
} = require('../src/main/binaries-contract');

const base = path.join(__dirname, '..', 'resources', 'bin');
const darwinX64 = getBinaryContractTarget('darwin', 'x64');
const darwinArm64 = getBinaryContractTarget('darwin', 'arm64');

if (!darwinX64 || !darwinArm64) {
  throw new Error('Missing darwin targets in binaries contract.');
}

const required = [
  {
    relPath: darwinX64.ffmpeg.relPath,
    arch: 'x64',
    expectedSha256: darwinX64.ffmpeg.repoSha256 || darwinX64.ffmpeg.sha256,
  },
  {
    relPath: darwinX64.ffprobe.relPath,
    arch: 'x64',
    expectedSha256: darwinX64.ffprobe.repoSha256 || darwinX64.ffprobe.sha256,
  },
  {
    relPath: darwinArm64.ffmpeg.relPath,
    arch: 'arm64',
    expectedSha256: darwinArm64.ffmpeg.repoSha256 || darwinArm64.ffmpeg.sha256,
  },
  {
    relPath: darwinArm64.ffprobe.relPath,
    arch: 'arm64',
    expectedSha256: darwinArm64.ffprobe.repoSha256 || darwinArm64.ffprobe.sha256,
  },
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

function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const entries = required.map((entry) => ({ ...entry, abs: path.join(base, entry.relPath) }));

  const missing = entries.filter((entry) => !isReadableFile(entry.abs));
  if (missing.length) {
    console.error('Missing vendored mac binaries required for universal build:');
    missing.forEach((entry) => console.error(`- ${entry.relPath}`));
    console.error('');
    console.error('Fix:');
    console.error('1) Run `npm run bootstrap:mac-bins` on an Apple Silicon Mac.');
    console.error('2) Run `npm run bootstrap:mac-bins` on an Intel Mac.');
    console.error('3) Ensure both folders exist locally for this build: resources/bin/darwin-arm64 and resources/bin/darwin-x64.');
    process.exit(1);
  }

  for (const entry of entries) {
    try {
      ensureExecutable(entry.abs);
    } catch {
      console.error(`Not executable and chmod failed: ${entry.relPath}`);
      process.exit(1);
    }
  }

  const wrongArch = entries.filter((entry) => !hasExpectedArch(entry.abs, entry.arch));
  if (wrongArch.length) {
    console.error('Architecture mismatch in vendored mac binaries:');
    wrongArch.forEach((entry) => console.error(`- ${entry.relPath} (expected ${entry.arch})`));
    process.exit(1);
  }

  const checksumMismatch = [];
  const report = [];
  for (const entry of entries) {
    const digest = await sha256Stream(entry.abs);
    const expected = entry.expectedSha256;
    const stat = fs.statSync(entry.abs);
    const match = Boolean(expected && digest === expected);
    if (!match) {
      checksumMismatch.push({
        file: entry.abs,
        expected,
        actual: digest,
      });
    }
    report.push({
      file: entry.abs,
      sizeBytes: stat.size,
      sha256: digest,
      sha256Expected: expected,
      sha256Match: match,
      arch: entry.arch,
    });
  }

  if (checksumMismatch.length) {
    console.error('Checksum mismatch in vendored mac binaries required for dist:mac.');
    console.error(`Contract version: ${BINARY_CONTRACT_VERSION}`);
    checksumMismatch.forEach((item) => {
      console.error(`- ${item.file}`);
      console.error(`  expected: ${item.expected}`);
      console.error(`  actual:   ${item.actual}`);
    });
    process.exit(1);
  }

  console.log('All required mac vendored binaries are present.');
  console.log(`Contract version: ${BINARY_CONTRACT_VERSION}`);
  report.forEach((item) => {
    console.log(`${item.file}`);
    console.log(`  sizeBytes=${item.sizeBytes}`);
    console.log(`  sha256=${item.sha256}`);
    console.log(`  arch=${item.arch}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`verify-mac-binaries failed: ${String(err?.message || err)}`);
    process.exit(1);
  });
}

module.exports = {
  sha256Stream,
};
