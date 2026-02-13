const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const OUTPUT_FILE = path.join(DIST_DIR, 'SHA256SUMS.txt');
const ARTEFACT_EXTENSIONS = new Set(['.exe', '.dmg', '.zip']);
const EXCLUDED_SUFFIXES = ['.blockmap', 'latest.yml', '.yaml', '.__uninstaller.exe'];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function shouldIncludeArtefact(fileName) {
  const lower = fileName.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const ext = path.extname(lower);
  return ARTEFACT_EXTENSIONS.has(ext);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes || 0);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const fixed = idx === 0 ? value.toFixed(0) : value.toFixed(2);
  return `${fixed} ${units[idx]}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  if (!fs.existsSync(DIST_DIR) || !fs.statSync(DIST_DIR).isDirectory()) {
    console.error(`Release hash failed: dist folder not found at ${DIST_DIR}`);
    process.exit(1);
  }

  const candidates = fs.readdirSync(DIST_DIR)
    .filter((name) => shouldIncludeArtefact(name))
    .map((name) => ({
      name,
      fullPath: path.join(DIST_DIR, name),
    }))
    .filter((entry) => isFile(entry.fullPath))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    console.error(`Release hash failed: no release artefacts found in ${DIST_DIR}`);
    console.error('Expected at least one of: *.exe, *.dmg, *.zip');
    process.exit(1);
  }

  const lines = [];
  for (const entry of candidates) {
    const stat = fs.statSync(entry.fullPath);
    const digest = await sha256File(entry.fullPath);
    lines.push(`${digest}  ${entry.name}`);

    console.log(`artefact: ${entry.fullPath}`);
    console.log(`size: ${stat.size} bytes (${formatBytes(stat.size)})`);
    console.log(`sha256: ${digest}`);
  }

  fs.writeFileSync(OUTPUT_FILE, `${lines.join('\n')}\n`, 'utf8');
  console.log(`sha256sums: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(`Release hash failed: ${String(err?.message || err)}`);
  process.exit(1);
});
