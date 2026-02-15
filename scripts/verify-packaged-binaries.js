const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  BINARY_CONTRACT_VERSION,
  getBinaryContractTarget,
} = require('../src/main/binaries-contract');

const rootDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

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

function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

function findMacPackagedBinRoot() {
  const macUniversalDir = path.join(rootDir, 'dist', 'mac-universal');
  let appDirs = [];
  try {
    appDirs = fs.readdirSync(macUniversalDir)
      .filter((name) => name.endsWith('.app'))
      .sort();
  } catch {
    appDirs = [];
  }

  if (!appDirs.length) {
    throw new Error(`No .app bundle found in ${macUniversalDir}. Run npm run dist:mac first.`);
  }

  return path.join(macUniversalDir, appDirs[0], 'Contents', 'Resources', 'bin');
}

function resolvePackagedBinRoot(platform, overrideRoot) {
  if (overrideRoot) {
    const abs = path.isAbsolute(overrideRoot) ? overrideRoot : path.join(rootDir, overrideRoot);
    return path.resolve(abs);
  }
  if (platform === 'win32') {
    return path.join(rootDir, 'dist', 'win-unpacked', 'resources', 'bin');
  }
  if (platform === 'darwin') {
    return findMacPackagedBinRoot();
  }
  throw new Error(`Unsupported platform for packaged binary verification: ${platform}`);
}

function getTargetPairs(platform, archArg) {
  if (platform === 'win32') {
    const arch = archArg || 'x64';
    if (arch !== 'x64') throw new Error(`Unsupported Windows packaged arch: ${arch}`);
    return [{ platform: 'win32', arch: 'x64', key: 'win32-x64' }];
  }

  if (platform === 'darwin') {
    const arch = archArg || 'universal';
    if (arch === 'universal') {
      return [
        { platform: 'darwin', arch: 'x64', key: 'darwin-x64' },
        { platform: 'darwin', arch: 'arm64', key: 'darwin-arm64' },
      ];
    }
    if (arch === 'x64' || arch === 'arm64') {
      return [{ platform: 'darwin', arch, key: `darwin-${arch}` }];
    }
    throw new Error(`Unsupported mac packaged arch: ${arch}`);
  }

  throw new Error(`Unsupported packaged platform: ${platform}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = String(args.platform || process.platform);
  const archArg = args.arch ? String(args.arch) : null;
  const packagedRoot = args.root ? String(args.root) : null;

  const targetPairs = getTargetPairs(platform, archArg);
  const packagedBinRoot = resolvePackagedBinRoot(platform, packagedRoot);

  const missing = [];
  const mismatches = [];
  const report = [];

  for (const pair of targetPairs) {
    const target = getBinaryContractTarget(pair.platform, pair.arch);
    if (!target || !target.ffmpeg || !target.ffprobe) {
      throw new Error(`Missing contract target: ${pair.key}`);
    }

    const binaries = [
      { name: 'ffmpeg', meta: target.ffmpeg },
      { name: 'ffprobe', meta: target.ffprobe },
    ];

    for (const binary of binaries) {
      const relPath = binary.meta.relPath;
      const expected = binary.meta.runtimeSha256 || binary.meta.sha256 || null;
      const absPath = path.join(packagedBinRoot, relPath);

      if (!existsReadable(absPath)) {
        missing.push({ key: pair.key, file: absPath });
        continue;
      }

      const digest = await sha256Stream(absPath);
      const stat = fs.statSync(absPath);
      const match = Boolean(expected && digest === expected);
      if (!match) {
        mismatches.push({ key: pair.key, file: absPath, expected, actual: digest });
      }

      report.push({
        key: pair.key,
        file: absPath,
        sizeBytes: stat.size,
        sha256: digest,
        sha256Expected: expected,
        sha256Match: match,
      });
    }
  }

  if (missing.length || mismatches.length) {
    console.error('Packaged binary contract verification failed.');
    console.error(`Contract version: ${BINARY_CONTRACT_VERSION}`);
    console.error(`Packaged bin root: ${packagedBinRoot}`);

    if (missing.length) {
      console.error('Missing packaged binaries:');
      missing.forEach((item) => console.error(`- [${item.key}] ${item.file}`));
    }

    if (mismatches.length) {
      console.error('Packaged binary checksum mismatch:');
      mismatches.forEach((item) => {
        console.error(`- [${item.key}] ${item.file}`);
        console.error(`  expected: ${item.expected}`);
        console.error(`  actual:   ${item.actual}`);
      });
    }

    process.exit(1);
  }

  console.log('Packaged binary contract verification passed.');
  console.log(`Contract version: ${BINARY_CONTRACT_VERSION}`);
  console.log(`Packaged bin root: ${packagedBinRoot}`);
  report.forEach((item) => {
    console.log(`${item.file}`);
    console.log(`  key=${item.key}`);
    console.log(`  sizeBytes=${item.sizeBytes}`);
    console.log(`  sha256=${item.sha256}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`verify-packaged-binaries failed: ${String(err?.message || err)}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  getTargetPairs,
};
