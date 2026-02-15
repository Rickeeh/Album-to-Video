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

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function findFirstAppBundle(searchRoot) {
  if (!isDirectory(searchRoot)) return null;
  const found = [];
  const stack = [searchRoot];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.app')) {
        found.push(full);
        continue;
      }
      stack.push(full);
    }
  }

  if (!found.length) return null;
  found.sort((a, b) => {
    let aMtime = 0;
    let bMtime = 0;
    try { aMtime = fs.statSync(a).mtimeMs || 0; } catch {}
    try { bMtime = fs.statSync(b).mtimeMs || 0; } catch {}
    if (aMtime !== bMtime) return bMtime - aMtime;
    return a.localeCompare(b);
  });
  return found[0];
}

function toMacBinRoot(appBundlePath) {
  return path.join(appBundlePath, 'Contents', 'Resources', 'bin');
}

function findMacPackagedBinRoot(archArg) {
  const arch = String(archArg || 'universal').toLowerCase();
  const searchDirs = [];

  if (arch === 'arm64') {
    searchDirs.push(path.join(rootDir, 'dist', 'mac-arm64'));
  } else if (arch === 'x64') {
    searchDirs.push(path.join(rootDir, 'dist', 'mac-x64'));
    searchDirs.push(path.join(rootDir, 'dist', 'mac'));
  } else if (arch === 'universal') {
    searchDirs.push(path.join(rootDir, 'dist', 'mac-universal'));
  }

  searchDirs.push(path.join(rootDir, 'dist', 'mac-arm64'));
  searchDirs.push(path.join(rootDir, 'dist', 'mac-x64'));
  searchDirs.push(path.join(rootDir, 'dist', 'mac-universal'));
  searchDirs.push(path.join(rootDir, 'dist', 'mac'));

  const uniqueSearchDirs = Array.from(new Set(searchDirs));
  for (const candidate of uniqueSearchDirs) {
    const appBundlePath = findFirstAppBundle(candidate);
    if (appBundlePath) return toMacBinRoot(appBundlePath);
  }

  throw new Error(
    `No .app bundle found for mac arch=${arch}. Looked in: ${uniqueSearchDirs.join(', ')}. `
    + 'Run the matching dist script first (e.g. npm run dist:mac:arm64 or npm run dist:mac:x64).'
  );
}

function resolvePackagedBinRoot(platform, archArg, overrideRoot) {
  if (overrideRoot) {
    const abs = path.isAbsolute(overrideRoot) ? overrideRoot : path.join(rootDir, overrideRoot);
    const resolved = path.resolve(abs);
    if (platform === 'darwin') {
      if (resolved.endsWith('.app')) return toMacBinRoot(resolved);
      const appBundlePath = findFirstAppBundle(resolved);
      if (appBundlePath) return toMacBinRoot(appBundlePath);
    }
    return resolved;
  }
  if (platform === 'win32') {
    return path.join(rootDir, 'dist', 'win-unpacked', 'resources', 'bin');
  }
  if (platform === 'darwin') {
    return findMacPackagedBinRoot(archArg);
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
  const packagedBinRoot = resolvePackagedBinRoot(platform, archArg, packagedRoot);

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
      const expectedRuntime = binary.meta.runtimeSha256 || null;
      const expectedRepo = binary.meta.repoSha256 || binary.meta.sha256 || null;
      const absPath = path.join(packagedBinRoot, relPath);

      if (!existsReadable(absPath)) {
        missing.push({ key: pair.key, file: absPath });
        continue;
      }

      const digest = await sha256Stream(absPath);
      const stat = fs.statSync(absPath);
      const allowedDigests = [expectedRuntime, expectedRepo].filter(Boolean);
      const match = allowedDigests.includes(digest);
      let matchSource = null;
      if (match) {
        if (digest === expectedRuntime) matchSource = 'runtimeSha256';
        else if (digest === expectedRepo) matchSource = 'repoSha256';
      }
      if (!match) {
        mismatches.push({
          key: pair.key,
          file: absPath,
          expectedRuntime,
          expectedRepo,
          actual: digest,
        });
      }

      report.push({
        key: pair.key,
        file: absPath,
        sizeBytes: stat.size,
        sha256: digest,
        sha256ExpectedRuntime: expectedRuntime,
        sha256ExpectedRepo: expectedRepo,
        sha256Match: match,
        sha256MatchSource: matchSource,
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
        if (item.expectedRuntime) console.error(`  expected(runtime): ${item.expectedRuntime}`);
        if (item.expectedRepo) console.error(`  expected(repo):    ${item.expectedRepo}`);
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
    if (item.sha256MatchSource) console.log(`  sha256MatchSource=${item.sha256MatchSource}`);
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
