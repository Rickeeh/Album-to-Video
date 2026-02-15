const fs = require('fs');
const path = require('path');

const ARCH_BY_CODE = Object.freeze({
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
});

function resolveArch(context) {
  if (typeof context?.arch === 'string' && context.arch) return context.arch;
  if (Number.isInteger(context?.arch) && ARCH_BY_CODE[context.arch]) return ARCH_BY_CODE[context.arch];

  const outDir = String(context?.appOutDir || '').toLowerCase();
  if (outDir.includes('arm64')) return 'arm64';
  if (outDir.includes('x64')) return 'x64';
  if (outDir.includes('universal')) return 'universal';
  return null;
}

function hasDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function findAppBundle(appOutDir) {
  if (!hasDir(appOutDir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(appOutDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const match = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(appOutDir, entry.name))
    .sort()[0];

  return match || null;
}

module.exports = async function afterPack(context) {
  if (String(context?.electronPlatformName || '') !== 'darwin') return;

  const arch = resolveArch(context);
  if (!arch || arch === 'universal') return;
  if (arch !== 'arm64' && arch !== 'x64') return;

  const appBundle = findAppBundle(context.appOutDir);
  if (!appBundle) return;

  const binRoot = path.join(appBundle, 'Contents', 'Resources', 'bin');
  if (!hasDir(binRoot)) return;

  const expectedDir = `darwin-${arch}`;
  const otherDir = `darwin-${arch === 'arm64' ? 'x64' : 'arm64'}`;
  const expectedPath = path.join(binRoot, expectedDir);
  const otherPath = path.join(binRoot, otherDir);

  if (!hasDir(expectedPath)) {
    throw new Error(`[afterPack] Missing required packaged mac binaries at ${expectedPath}`);
  }

  if (hasDir(otherPath)) {
    fs.rmSync(otherPath, { recursive: true, force: true });
  }
};
