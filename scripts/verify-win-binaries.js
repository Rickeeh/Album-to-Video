const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  BINARY_CONTRACT_VERSION,
  getBinaryContractTarget,
} = require('../src/main/binaries-contract');

const base = path.join(__dirname, '..', 'resources', 'bin');
const winTarget = getBinaryContractTarget('win32', 'x64');

if (!winTarget || !winTarget.ffmpeg || !winTarget.ffprobe) {
  throw new Error('Missing win32-x64 target in binaries contract.');
}

const required = [
  {
    name: 'ffmpeg.exe',
    relPath: winTarget.ffmpeg.relPath,
    expectedSha256: winTarget.ffmpeg.repoSha256 || winTarget.ffmpeg.sha256,
  },
  {
    name: 'ffprobe.exe',
    relPath: winTarget.ffprobe.relPath,
    expectedSha256: winTarget.ffprobe.repoSha256 || winTarget.ffprobe.sha256,
  },
];

const expectedSha256 = Object.freeze({
  'ffmpeg.exe': winTarget.ffmpeg.repoSha256 || winTarget.ffmpeg.sha256,
  'ffprobe.exe': winTarget.ffprobe.repoSha256 || winTarget.ffprobe.sha256,
});

function existsReadable(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isPeExecutable(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    return buf[0] === 0x4d && buf[1] === 0x5a; // "MZ"
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
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
  const missing = [];
  const invalid = [];
  const checksumMismatch = [];
  const report = [];

  for (const entry of required) {
    const full = path.join(base, entry.relPath);
    if (!existsReadable(full)) {
      missing.push(full);
      continue;
    }
    const pe = isPeExecutable(full);
    if (!pe) invalid.push(full);
    const digest = await sha256Stream(full);
    const expected = entry.expectedSha256;
    const match = Boolean(expected && digest === expected);
    if (!match) {
      checksumMismatch.push({
        file: full,
        expected: expected || null,
        actual: digest,
      });
    }

    const stat = fs.statSync(full);
    report.push({
      file: full,
      sizeBytes: stat.size,
      sha256: digest,
      sha256Expected: expected || null,
      sha256Match: match,
      peExecutable: pe,
    });
  }

  if (missing.length || invalid.length || checksumMismatch.length) {
    console.error('Missing or invalid vendored Windows binaries required for dist:win.');
    console.error(`Contract version: ${BINARY_CONTRACT_VERSION}`);
    if (missing.length) {
      console.error('Missing:');
      missing.forEach((m) => console.error(`  - ${m}`));
    }
    if (invalid.length) {
      console.error('Invalid (not PE/MZ executable):');
      invalid.forEach((m) => console.error(`  - ${m}`));
    }
    if (checksumMismatch.length) {
      console.error('Checksum mismatch:');
      checksumMismatch.forEach((item) => {
        console.error(`  - ${item.file}`);
        console.error(`    expected: ${item.expected}`);
        console.error(`    actual:   ${item.actual}`);
      });
    }
    console.error(`Expected files: ${required.map((entry) => path.join('resources', 'bin', entry.relPath)).join(' and ')}`);
    process.exit(1);
  }

  console.log('All required Windows vendored binaries are present.');
  console.log(`Contract version: ${BINARY_CONTRACT_VERSION}`);
  report.forEach((r) => {
    console.log(`${r.file}`);
    console.log(`  sizeBytes=${r.sizeBytes}`);
    console.log(`  sha256=${r.sha256}`);
    console.log(`  peExecutable=${r.peExecutable}`);
  });
}

module.exports = {
  expectedSha256,
  sha256Stream,
  isPeExecutable,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`verify-win-binaries failed: ${String(err?.message || err)}`);
    process.exit(1);
  });
}
