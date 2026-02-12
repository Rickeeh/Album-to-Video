const fs = require('fs');
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
      .filter((name) => name.endsWith('.tmp') || name.includes('.tmp.'))
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
    if (context.currentTrackTmpPath) filesToDelete.add(context.currentTrackTmpPath);
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
      if (lower.endsWith('.tmp') || lower.includes('.tmp.')) stats.cleanupDeletedTmpCount += 1;
      else if (lower.endsWith('.mp4')) stats.cleanupDeletedFinalCount += 1;
    }

    if (context.createAlbumFolder) {
      if (reason === 'CANCELLED') {
        try {
          fs.rmSync(context.outputFolder, { recursive: true, force: true });
        } catch {}
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
