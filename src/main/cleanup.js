const fs = require('fs');
const os = require('os');
const path = require('path');

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function collectTmpArtifacts(outputFolder) {
  if (!outputFolder || !fs.existsSync(outputFolder)) return [];
  try {
    return fs.readdirSync(outputFolder)
      .sort((a, b) => String(a).localeCompare(String(b)))
      .filter((name) => {
        const lower = String(name || '').toLowerCase();
        return lower.endsWith('.tmp') || lower.includes('.tmp.') || lower.endsWith('.partial');
      })
      .map((name) => path.join(outputFolder, name));
  } catch {
    return [];
  }
}

function waitProcessExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve('already-exited');
      return;
    }

    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      proc.removeListener('exit', onExit);
      proc.removeListener('close', onClose);
      resolve(result);
    };
    const onExit = () => finish('exit');
    const onClose = () => finish('close');

    proc.once('exit', onExit);
    proc.once('close', onClose);

    timer = setTimeout(() => finish('timeout'), Math.max(200, timeoutMs || 0));
  });
}

function defaultCleanupStats() {
  return {
    cleanupDeletedTmpCount: 0,
    cleanupDeletedFinalCount: 0,
    cleanupRemovedEmptyFolder: false,
  };
}

function isPathWithinBase(basePath, targetPath) {
  const rel = path.relative(basePath, targetPath);
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function realpathOrResolve(p) {
  const abs = path.resolve(String(p || ''));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function isDangerousDeleteTarget(outputFolder) {
  const normalized = realpathOrResolve(outputFolder);
  if (!path.isAbsolute(normalized)) {
    return { dangerous: true, reason: 'not_absolute', normalized };
  }

  const root = path.parse(normalized).root;
  if (normalized === root) {
    return { dangerous: true, reason: 'filesystem_root', normalized };
  }

  const home = realpathOrResolve(os.homedir());
  if (normalized === home) {
    return { dangerous: true, reason: 'home_directory', normalized };
  }

  const desktop = path.join(home, 'Desktop');
  if (normalized === desktop) {
    return { dangerous: true, reason: 'desktop_directory', normalized };
  }

  const depth = normalized
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)
    .length;
  if (depth < 2) {
    return { dangerous: true, reason: 'path_too_shallow', normalized };
  }

  return { dangerous: false, reason: null, normalized };
}

function canRemoveOutputFolder(outputFolder, baseExportFolder) {
  if (!outputFolder) {
    return { ok: false, reason: 'missing_output_folder' };
  }

  const dangerCheck = isDangerousDeleteTarget(outputFolder);
  if (dangerCheck.dangerous) {
    return { ok: false, reason: dangerCheck.reason, outputFolder: dangerCheck.normalized };
  }

  const realOutputFolder = dangerCheck.normalized;
  const logsMarkerPath = path.join(realOutputFolder, 'Logs');
  let hasLogsMarker = false;
  try {
    hasLogsMarker = fs.existsSync(logsMarkerPath) && fs.statSync(logsMarkerPath).isDirectory();
  } catch {}

  let withinBaseExport = false;
  let sameAsBase = false;
  let realBaseExportFolder = null;
  if (baseExportFolder) {
    realBaseExportFolder = realpathOrResolve(baseExportFolder);
    sameAsBase = realOutputFolder === realBaseExportFolder;
    withinBaseExport = isPathWithinBase(realBaseExportFolder, realOutputFolder) && !sameAsBase;
  }

  if (sameAsBase) {
    return {
      ok: false,
      reason: 'output_equals_base_export',
      outputFolder: realOutputFolder,
      baseExportFolder: realBaseExportFolder,
    };
  }

  if (!withinBaseExport && !hasLogsMarker) {
    return {
      ok: false,
      reason: 'outside_base_and_missing_marker',
      outputFolder: realOutputFolder,
      baseExportFolder: realBaseExportFolder,
      logsMarkerPath,
    };
  }

  return {
    ok: true,
    reason: null,
    outputFolder: realOutputFolder,
    baseExportFolder: realBaseExportFolder,
    withinBaseExport,
    hasLogsMarker,
  };
}

async function cleanupJob(jobId, reason, context) {
  if (!context) return defaultCleanupStats();
  if (context.cleanupPromise) return await context.cleanupPromise;
  if (context.cleanedUp) return context.cleanupStats || defaultCleanupStats();

  context.cleanupPromise = (async () => {
    const logger = context.logger;
    const logData = { jobId, reason };
    if (logger?.info) logger.info('cleanup.start', logData);
    const stats = defaultCleanupStats();

    const activeProcess =
      (typeof context.getActiveProcess === 'function' ? context.getActiveProcess() : null)
      || context.activeProcess
      || null;
    if (activeProcess && !activeProcess.killed) {
      try {
        if (typeof context.killProcessTree === 'function') {
          await context.killProcessTree(activeProcess);
        }
        const waitOutcome = await waitProcessExit(activeProcess, context.killWaitTimeoutMs || 1500);
        if (logger?.warn) logger.warn('cleanup.ffmpeg_killed', logData);
        if (logger?.info) logger.info('cleanup.ffmpeg_wait', { ...logData, waitOutcome });
      } catch (err) {
        if (logger?.error) {
          logger.error('cleanup.kill_failed', { ...logData, error: String(err?.message || err) });
        }
      }
    }

    context.cleanedUp = true;

    const filesToDelete = new Set();
    if (context.stagingClosers instanceof Set) {
      for (const closer of context.stagingClosers) {
        try { closer(); } catch {}
      }
    }
    if (context.currentTrackPartialPath) filesToDelete.add(context.currentTrackPartialPath);
    if (context.currentTrackTmpPath) filesToDelete.add(context.currentTrackTmpPath);
    if (context.partialPaths instanceof Set) {
      for (const p of context.partialPaths) filesToDelete.add(p);
    }
    if (context.tmpPaths instanceof Set) {
      for (const p of context.tmpPaths) filesToDelete.add(p);
    }
    if (context.stagingPaths instanceof Set) {
      for (const p of context.stagingPaths) filesToDelete.add(p);
    }
    for (const p of collectTmpArtifacts(context.outputFolder)) filesToDelete.add(p);

    if (reason === 'CANCELLED' && context.plannedFinalOutputs instanceof Set) {
      for (const p of context.plannedFinalOutputs) filesToDelete.add(p);
      if (context.outputFolder) {
        filesToDelete.add(path.join(context.outputFolder, 'Logs', 'render-report.json'));
      }
    }

    for (const p of filesToDelete) {
      const lower = String(p || '').toLowerCase();
      const existed = Boolean(p && fs.existsSync(p));
      safeUnlink(p);
      if (!existed) continue;
      if (lower.endsWith('.tmp') || lower.includes('.tmp.') || lower.endsWith('.partial')) {
        stats.cleanupDeletedTmpCount += 1;
      }
      else if (lower.endsWith('.mp4')) stats.cleanupDeletedFinalCount += 1;
    }

    if (context.createAlbumFolder) {
      if (reason === 'CANCELLED') {
        const guard = canRemoveOutputFolder(context.outputFolder, context.baseExportFolder);
        if (!guard.ok) {
          if (logger?.warn) logger.warn('cleanup.remove_folder_blocked', { ...logData, ...guard });
        } else {
          try {
            fs.rmSync(guard.outputFolder, { recursive: true, force: true });
          } catch {}
        }
        stats.cleanupRemovedEmptyFolder = !fs.existsSync(context.outputFolder);
      } else if (typeof context.safeRmdirIfEmpty === 'function') {
        context.safeRmdirIfEmpty(context.outputFolder);
        stats.cleanupRemovedEmptyFolder = !fs.existsSync(context.outputFolder);
      }
    }

    context.cleanupStats = stats;
    if (logger?.info) logger.info('cleanup.end', { ...logData, removedCount: filesToDelete.size, ...stats });
    return stats;
  })();

  return await context.cleanupPromise;
}

module.exports = { cleanupJob };
