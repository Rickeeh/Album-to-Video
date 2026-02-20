#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');

function fail(message) {
  console.error(`[verify-build-config] FAIL: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getTargetEntries(winTarget) {
  if (!Array.isArray(winTarget)) return [];
  return winTarget.map((entry) => {
    if (typeof entry === 'string') return { target: entry };
    if (entry && typeof entry === 'object') return entry;
    return { target: '' };
  });
}

function findTargetEntry(entries, targetName) {
  return entries.find((entry) => String(entry?.target || '').toLowerCase() === targetName) || null;
}

function isTrackedInGit(relPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    const status = Number(err?.status);
    if (status === 1) return false;
    throw err;
  }
}

function main() {
  const pkg = readJson(packageJsonPath);
  const build = pkg?.build || {};
  const win = build?.win || {};
  const targetEntries = getTargetEntries(win.target);
  const nsisTarget = findTargetEntry(targetEntries, 'nsis');
  const portableTarget = findTargetEntry(targetEntries, 'portable');

  if (!nsisTarget) fail('build.win.target must include `nsis`.');
  if (!portableTarget) fail('build.win.target must include `portable`.');
  if (typeof build.artifactName === 'string' && build.artifactName.trim()) {
    fail('Global build.artifactName must be removed to avoid cross-target artifact collisions.');
  }

  const nsisArtifactName = String(
    nsisTarget.artifactName || build?.nsis?.artifactName || ''
  ).trim();
  const portableArtifactName = String(
    portableTarget.artifactName || build?.portable?.artifactName || ''
  ).trim();

  if (!nsisArtifactName) fail('Missing artifactName for NSIS target (build.nsis.artifactName).');
  if (!portableArtifactName) fail('Missing artifactName for portable target (build.portable.artifactName).');
  if (nsisArtifactName === portableArtifactName) {
    fail('NSIS and portable artifactName must be unique.');
  }
  if (!/(setup|nsis|\$\{target\})/i.test(nsisArtifactName)) {
    fail('NSIS artifactName should include a target discriminator (`setup`, `nsis`, or `${target}`).');
  }
  if (!/(portable|\$\{target\})/i.test(portableArtifactName)) {
    fail('Portable artifactName should include a target discriminator (`portable` or `${target}`).');
  }

  if (isTrackedInGit('index - BAK.html')) {
    fail('`index - BAK.html` is tracked. Remove it from git before release/CI.');
  }

  console.log('[verify-build-config] PASS');
  console.log(`[verify-build-config] nsis.artifactName=${nsisArtifactName}`);
  console.log(`[verify-build-config] portable.artifactName=${portableArtifactName}`);
}

try {
  main();
} catch (err) {
  fail(String(err?.message || err));
}
