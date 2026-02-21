#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const packageJsonPath = path.join(projectRoot, 'package.json');
const latestYmlPath = path.join(distDir, 'latest.yml');

function fail(message) {
  console.error(`[verify-win-artifacts] FAIL: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureFile(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) fail(`${label} is not a file: ${filePath}`);
    return stat;
  } catch {
    fail(`${label} not found: ${filePath}`);
  }
}

function renderTemplate(template, context) {
  return String(template || '').replace(/\$\{([^}]+)\}/g, (_m, key) => {
    const token = String(key || '').trim();
    if (Object.prototype.hasOwnProperty.call(context, token)) {
      return String(context[token]);
    }
    return '';
  });
}

function stripYamlScalar(value) {
  const trimmed = String(value || '').trim();
  const single = trimmed.match(/^'(.*)'$/);
  if (single) return single[1];
  const dbl = trimmed.match(/^"(.*)"$/);
  if (dbl) return dbl[1];
  return trimmed;
}

function parseLatestYml(raw) {
  const pathMatch = raw.match(/^path:\s*(.+)$/m);
  const rootSha512Match = raw.match(/^sha512:\s*(.+)$/m);
  const fileUrlMatch = raw.match(/^\s*-\s*url:\s*(.+)$/m);
  const fileSha512Match = raw.match(/^\s{2,}sha512:\s*(.+)$/m);
  const fileSizeMatch = raw.match(/^\s{2,}size:\s*(\d+)\s*$/m);

  return {
    path: pathMatch ? stripYamlScalar(pathMatch[1]) : null,
    rootSha512: rootSha512Match ? stripYamlScalar(rootSha512Match[1]) : null,
    fileUrl: fileUrlMatch ? stripYamlScalar(fileUrlMatch[1]) : null,
    fileSha512: fileSha512Match ? stripYamlScalar(fileSha512Match[1]) : null,
    fileSize: fileSizeMatch ? Number(fileSizeMatch[1]) : null,
  };
}

function hashFile(filePath, algorithm, digestEncoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest(digestEncoding)));
  });
}

async function main() {
  const pkg = readJson(packageJsonPath);
  const productName = String(pkg?.build?.productName || pkg?.productName || pkg?.name || '').trim();
  const version = String(pkg?.version || '').trim();
  const nsisTemplate = String(pkg?.build?.nsis?.artifactName || '').trim();
  const portableTemplate = String(pkg?.build?.portable?.artifactName || '').trim();

  if (!productName) fail('Missing productName in package.json build config.');
  if (!version) fail('Missing version in package.json.');
  if (!nsisTemplate) fail('Missing build.nsis.artifactName in package.json.');
  if (!portableTemplate) fail('Missing build.portable.artifactName in package.json.');

  const context = {
    productName,
    version,
    os: 'win',
    platform: 'win',
    arch: 'x64',
    ext: 'exe',
  };
  const expectedSetupName = renderTemplate(nsisTemplate, context);
  const expectedPortableName = renderTemplate(portableTemplate, context);
  if (!expectedSetupName || !expectedPortableName) {
    fail('Could not resolve expected Windows artifact names from templates.');
  }
  if (expectedSetupName === expectedPortableName) {
    fail(`Resolved setup and portable names collide: ${expectedSetupName}`);
  }

  const setupPath = path.join(distDir, expectedSetupName);
  const portablePath = path.join(distDir, expectedPortableName);
  const setupStat = ensureFile(setupPath, 'Setup artifact');
  const portableStat = ensureFile(portablePath, 'Portable artifact');
  if (setupStat.size <= 0 || portableStat.size <= 0) {
    fail('Setup/portable artifacts must be non-empty files.');
  }

  const [setupSha256, portableSha256] = await Promise.all([
    hashFile(setupPath, 'sha256', 'hex'),
    hashFile(portablePath, 'sha256', 'hex'),
  ]);
  if (setupSha256 === portableSha256) {
    fail('Setup and portable artifacts are byte-identical (unexpected collision).');
  }

  ensureFile(latestYmlPath, 'latest.yml');
  const latestRaw = fs.readFileSync(latestYmlPath, 'utf8');
  const latest = parseLatestYml(latestRaw);

  if (!latest.path) fail('latest.yml missing `path`.');
  if (!latest.rootSha512) fail('latest.yml missing root `sha512`.');
  if (!Number.isFinite(latest.fileSize)) fail('latest.yml missing file `size`.');
  if (!latest.fileUrl) fail('latest.yml missing `files[0].url`.');

  if (latest.path !== expectedSetupName) {
    fail(`latest.yml path must point to setup artifact. expected=${expectedSetupName} actual=${latest.path}`);
  }
  if (latest.fileUrl !== expectedSetupName) {
    fail(`latest.yml files[0].url must point to setup artifact. expected=${expectedSetupName} actual=${latest.fileUrl}`);
  }
  if (latest.fileSha512 && latest.fileSha512 !== latest.rootSha512) {
    fail('latest.yml has mismatched root/file sha512 values.');
  }

  const latestArtifactPath = path.join(distDir, latest.path);
  const latestArtifactStat = ensureFile(latestArtifactPath, 'latest.yml path artifact');
  if (latestArtifactStat.size !== latest.fileSize) {
    fail(`latest.yml size mismatch. expected=${latest.fileSize} actual=${latestArtifactStat.size}`);
  }

  const latestSha512Actual = await hashFile(latestArtifactPath, 'sha512', 'base64');
  if (latestSha512Actual !== latest.rootSha512) {
    fail('latest.yml sha512 does not match artifact content.');
  }

  console.log('[verify-win-artifacts] PASS');
  console.log(`[verify-win-artifacts] setup=${expectedSetupName} size=${setupStat.size}`);
  console.log(`[verify-win-artifacts] portable=${expectedPortableName} size=${portableStat.size}`);
  console.log(`[verify-win-artifacts] latest.path=${latest.path}`);
}

main().catch((err) => fail(String(err?.message || err)));
