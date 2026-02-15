#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let asar = null;
try {
  // Optional at runtime; used to inspect app.asar virtual entries for hidden non-runtime assets.
  // eslint-disable-next-line global-require
  asar = require('@electron/asar');
} catch {}

const SCHEMA_FAMILY = 'packageManifest';
const SCHEMA_VERSION = 1;
const TOP_FILES_LIMIT = 50;
const TOP_DIRS_LIMIT = 20;
const TXT_TOP_FILES_LIMIT = 20;
const TXT_TOP_DIRS_LIMIT = 10;

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosixPath(inputPath) {
  return String(inputPath || '').split(path.sep).join('/');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

function newestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function listDefaultCandidates(distDir) {
  if (!fs.existsSync(distDir)) return [];
  const candidates = [];
  const knownDirs = [
    'win-unpacked',
    'mac-universal',
    'mac-arm64',
    'mac-x64',
    'mac',
    'linux-unpacked',
  ];

  for (const name of knownDirs) {
    const full = path.join(distDir, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        candidates.push({ path: full, mtimeMs: newestMtimeMs(full), priority: 0 });
      }
    } catch {}
  }

  let distEntries = [];
  try {
    distEntries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch {}

  for (const entry of distEntries) {
    const full = path.join(distDir, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.app') || lower.endsWith('-unpacked')) {
        candidates.push({ path: full, mtimeMs: newestMtimeMs(full), priority: 1 });
      }
      continue;
    }
    if (entry.isFile()) {
      candidates.push({ path: full, mtimeMs: newestMtimeMs(full), priority: 2 });
    }
  }

  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.mtimeMs - a.mtimeMs;
  });
}

function resolveTargetPath(projectRoot, requestedTargetPath) {
  if (requestedTargetPath) {
    return path.resolve(projectRoot, requestedTargetPath);
  }
  const distDir = path.join(projectRoot, 'dist');
  const candidates = listDefaultCandidates(distDir);
  if (!candidates.length) return null;
  return candidates[0].path;
}

function initFlags() {
  return {
    containsTests: false,
    containsFixtures: false,
    containsPerfArtifacts: false,
    containsLogs: false,
    containsSourceMaps: false,
    containsDuplicateFfmpegCandidates: false,
  };
}

function detectFfmpegKind(relFilePath) {
  const base = path.posix.basename(String(relFilePath || '')).toLowerCase();
  if (base === 'ffmpeg' || base === 'ffmpeg.exe') return 'ffmpeg';
  if (base === 'ffprobe' || base === 'ffprobe.exe') return 'ffprobe';
  return null;
}

function expectedFfmpegCounts(platform, arch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  if (p === 'darwin' && a === 'universal') {
    return { ffmpeg: 2, ffprobe: 2 };
  }
  return { ffmpeg: 1, ffprobe: 1 };
}

function makeEmptyManifest({ platform, arch, targetPath, notes }) {
  return {
    schemaFamily: SCHEMA_FAMILY,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    platform,
    arch,
    targetPath: targetPath ? toPosixPath(targetPath) : null,
    targetType: null,
    totalBytes: 0,
    fileCount: 0,
    topFiles: [],
    topDirs: [],
    flags: initFlags(),
    ffmpegCandidates: [],
    notes: notes || null,
  };
}

function collectManifestData(targetPath, { platform, arch }) {
  const stat = fs.statSync(targetPath);
  const files = [];
  const dirSizes = new Map();
  const ffmpegCandidates = [];
  const flags = initFlags();
  let totalBytes = 0;
  let fileCount = 0;

  const addDirSizes = (relFilePath, bytes) => {
    let current = path.posix.dirname(relFilePath);
    while (current && current !== '.') {
      dirSizes.set(current, (dirSizes.get(current) || 0) + bytes);
      const parent = path.posix.dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  };

  const updateFlagsAndCandidates = (relFilePath, bytes) => {
    const lower = relFilePath.toLowerCase();
    const withEdges = `/${lower}/`;
    if (withEdges.includes('/tests/') || withEdges.includes('/test/')) flags.containsTests = true;
    if (withEdges.includes('/fixtures/')) flags.containsFixtures = true;
    if (withEdges.includes('/dist/perf/') || withEdges.includes('/perf/')) flags.containsPerfArtifacts = true;
    if (withEdges.includes('/logs/')) flags.containsLogs = true;
    if (lower.endsWith('.map')) flags.containsSourceMaps = true;

    const kind = detectFfmpegKind(relFilePath);
    if (kind) {
      ffmpegCandidates.push({ path: relFilePath, bytes, kind });
    }
  };

  const addFileRecord = (absFilePath) => {
    const fileStat = fs.statSync(absFilePath);
    if (!fileStat.isFile()) return;
    const bytes = fileStat.size;
    const relPath = toPosixPath(path.relative(targetPath, absFilePath) || path.basename(absFilePath));

    totalBytes += bytes;
    fileCount += 1;
    files.push({ path: relPath, bytes });
    updateFlagsAndCandidates(relPath, bytes);
    addDirSizes(relPath, bytes);
  };

  if (stat.isFile()) {
    const relPath = toPosixPath(path.basename(targetPath));
    totalBytes = stat.size;
    fileCount = 1;
    files.push({ path: relPath, bytes: stat.size });
    updateFlagsAndCandidates(relPath, stat.size);
  } else if (stat.isDirectory()) {
    const stack = [targetPath];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) addFileRecord(full);
      }
    }
  }

  const topFiles = files
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_FILES_LIMIT);
  const topDirs = Array.from(dirSizes.entries())
    .map(([dirPath, bytes]) => ({ path: dirPath, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_DIRS_LIMIT);
  const sortedCandidates = ffmpegCandidates.sort((a, b) => b.bytes - a.bytes);
  const expected = expectedFfmpegCounts(platform, arch);
  const actualCounts = { ffmpeg: 0, ffprobe: 0 };
  sortedCandidates.forEach((entry) => {
    if (entry.kind === 'ffmpeg') actualCounts.ffmpeg += 1;
    if (entry.kind === 'ffprobe') actualCounts.ffprobe += 1;
  });
  flags.containsDuplicateFfmpegCandidates = (
    actualCounts.ffmpeg > expected.ffmpeg
    || actualCounts.ffprobe > expected.ffprobe
  );

  return {
    targetType: stat.isFile() ? 'file' : 'directory',
    totalBytes,
    fileCount,
    topFiles,
    topDirs,
    flags,
    ffmpegCandidates: sortedCandidates,
  };
}

function applyAsarFindings(targetPath, aggregate) {
  if (!asar || !aggregate || !Array.isArray(aggregate.ffmpegCandidates)) return;
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== 'app.asar') continue;

      let list = [];
      try {
        list = asar.listPackage(full) || [];
      } catch {
        continue;
      }

      for (const virtualPath of list) {
        const rel = String(virtualPath || '');
        const normalized = toPosixPath(rel.startsWith('/') ? rel : `/${rel}`);
        const withEdges = `/${normalized.toLowerCase()}/`;
        if (withEdges.includes('/tests/') || withEdges.includes('/test/')) aggregate.flags.containsTests = true;
        if (withEdges.includes('/fixtures/')) aggregate.flags.containsFixtures = true;
        if (withEdges.includes('/dist/perf/') || withEdges.includes('/perf/')) aggregate.flags.containsPerfArtifacts = true;
        if (withEdges.includes('/logs/')) aggregate.flags.containsLogs = true;
        if (normalized.toLowerCase().endsWith('.map')) aggregate.flags.containsSourceMaps = true;

        const kind = detectFfmpegKind(normalized);
        if (!kind) continue;
        let bytes = 0;
        try {
          const st = asar.statFile(full, normalized);
          bytes = Number(st?.size || 0);
        } catch {}
        aggregate.ffmpegCandidates.push({
          path: `app.asar:${normalized}`,
          bytes,
          kind,
        });
      }
    }
  }

  aggregate.ffmpegCandidates.sort((a, b) => b.bytes - a.bytes);
  const expected = expectedFfmpegCounts(aggregate.platform, aggregate.arch);
  const counts = { ffmpeg: 0, ffprobe: 0 };
  aggregate.ffmpegCandidates.forEach((entry) => {
    if (entry.kind === 'ffmpeg') counts.ffmpeg += 1;
    if (entry.kind === 'ffprobe') counts.ffprobe += 1;
  });
  aggregate.flags.containsDuplicateFfmpegCandidates = (
    counts.ffmpeg > expected.ffmpeg
    || counts.ffprobe > expected.ffprobe
  );
}

function buildTxt(manifest) {
  const lines = [];
  lines.push('Package Manifest');
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push(`Target: ${manifest.targetPath || 'n/a'}`);
  lines.push(`Target type: ${manifest.targetType || 'n/a'}`);
  lines.push(`Platform: ${manifest.platform || 'n/a'}`);
  lines.push(`Arch: ${manifest.arch || 'n/a'}`);
  lines.push(`Total size: ${formatBytes(manifest.totalBytes)} (${manifest.totalBytes} bytes)`);
  lines.push(`File count: ${manifest.fileCount}`);
  lines.push('');
  lines.push('Flags');
  for (const [key, value] of Object.entries(manifest.flags || {})) {
    lines.push(`- ${key}: ${value ? 'true' : 'false'}`);
  }

  lines.push('');
  lines.push(`Top files (${Math.min(TXT_TOP_FILES_LIMIT, (manifest.topFiles || []).length)})`);
  (manifest.topFiles || []).slice(0, TXT_TOP_FILES_LIMIT).forEach((entry, idx) => {
    lines.push(`${idx + 1}. ${formatBytes(entry.bytes)} (${entry.bytes})  ${entry.path}`);
  });

  lines.push('');
  lines.push(`Top dirs (${Math.min(TXT_TOP_DIRS_LIMIT, (manifest.topDirs || []).length)})`);
  (manifest.topDirs || []).slice(0, TXT_TOP_DIRS_LIMIT).forEach((entry, idx) => {
    lines.push(`${idx + 1}. ${formatBytes(entry.bytes)} (${entry.bytes})  ${entry.path}`);
  });

  lines.push('');
  lines.push(`FFmpeg candidates (${(manifest.ffmpegCandidates || []).length})`);
  (manifest.ffmpegCandidates || []).forEach((entry, idx) => {
    lines.push(`${idx + 1}. ${formatBytes(entry.bytes)} (${entry.bytes})  ${entry.path}`);
  });

  if (manifest.notes) {
    lines.push('');
    lines.push(`Notes: ${manifest.notes}`);
  }

  lines.push('');
  return lines.join('\n');
}

function writeOutputs(outDir, manifest) {
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'package-manifest.json');
  const txtPath = path.join(outDir, 'package-manifest.txt');
  fs.writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(txtPath, buildTxt(manifest), 'utf8');
  return { jsonPath, txtPath };
}

function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const requestedTarget = getArg('--target', null);
  const outDir = path.resolve(projectRoot, getArg('--out-dir', path.join('dist', 'package')));
  const platform = String(getArg('--platform', process.platform) || process.platform);
  const arch = String(getArg('--arch', process.arch) || process.arch);
  const softMode = hasFlag('--soft');
  const requestedNote = getArg('--note', null);

  let manifest;
  let resolvedTargetPath = null;

  try {
    resolvedTargetPath = resolveTargetPath(projectRoot, requestedTarget);
    if (!resolvedTargetPath) throw new Error('No package target found (pass --target or generate dist artifacts first).');
    if (!fs.existsSync(resolvedTargetPath)) throw new Error(`Target path not found: ${resolvedTargetPath}`);

    const data = collectManifestData(resolvedTargetPath, { platform, arch });
    manifest = {
      schemaFamily: SCHEMA_FAMILY,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      platform,
      arch,
      targetPath: toPosixPath(resolvedTargetPath),
      targetType: data.targetType,
      totalBytes: data.totalBytes,
      fileCount: data.fileCount,
      topFiles: data.topFiles,
      topDirs: data.topDirs,
      flags: data.flags,
      ffmpegCandidates: data.ffmpegCandidates,
      notes: requestedNote || null,
    };
    applyAsarFindings(resolvedTargetPath, manifest);
  } catch (err) {
    if (!softMode) throw err;
    manifest = makeEmptyManifest({
      platform,
      arch,
      targetPath: resolvedTargetPath || requestedTarget,
      notes: requestedNote || `soft mode: ${String(err?.message || err)}`,
    });
  }

  const out = writeOutputs(outDir, manifest);
  console.log(`[package-manifest] target=${manifest.targetPath || 'n/a'}`);
  console.log(`[package-manifest] totalBytes=${manifest.totalBytes} fileCount=${manifest.fileCount}`);
  console.log(`[package-manifest] json=${out.jsonPath}`);
  console.log(`[package-manifest] txt=${out.txtPath}`);
}

try {
  run();
} catch (err) {
  console.error('[package-manifest] ERROR:', String(err?.message || err));
  process.exit(1);
}
