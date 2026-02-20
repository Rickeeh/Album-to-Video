const fs = require('fs');
const path = require('path');

function safeUnlink(filePath) {
  const result = { existed: false, removed: false, error: null };
  try {
    if (filePath && fs.existsSync(filePath)) {
      result.existed = true;
      fs.unlinkSync(filePath);
      result.removed = true;
    }
  } catch (err) {
    result.error = err;
  }
  return result;
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

function normalizePathForCompare(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  try {
    const resolved = path.resolve(raw);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return process.platform === 'win32' ? raw.toLowerCase() : raw;
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
    cleanupDeleteFailedCount: 0,
    cleanupDeleteFailedExamples: [],
  };
}

async function cleanupJob(jobId, reason, context) {
  if (!context) return defaultCleanupStats();
  if (context.cleanupPromise) return await context.cleanupPromise;
  if (context.cleanedUp) return context.cleanupStats || defaultCleanupStats();

  context.cleanupPromise = (async () => {
    const logger = context.logger;
    const logData = { jobId, reason };
    const stats = defaultCleanupStats();
    let removedCount = 0;
    let skippedFinalizePartialCount = 0;
    try {
      if (logger?.info) logger.info('cleanup.start', logData);

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

      const filesToDelete = new Set();
      const finalizingPartials = new Set();
      if (context.finalizingPartials instanceof Set) {
        for (const p of context.finalizingPartials) {
          const normalized = normalizePathForCompare(p);
          if (normalized) finalizingPartials.add(normalized);
        }
      }
      const queueDeletion = (filePath) => {
        if (!filePath) return;
        const normalized = normalizePathForCompare(filePath);
        if (normalized && finalizingPartials.has(normalized)) {
          skippedFinalizePartialCount += 1;
          return;
        }
        filesToDelete.add(filePath);
      };
      if (context.stagingClosers instanceof Set) {
        for (const closer of context.stagingClosers) {
          try { closer(); } catch {}
        }
      }
      if (context.currentTrackPartialPath) queueDeletion(context.currentTrackPartialPath);
      if (context.currentTrackTmpPath) queueDeletion(context.currentTrackTmpPath);
      if (context.partialPaths instanceof Set) {
        for (const p of context.partialPaths) queueDeletion(p);
      }
      if (context.tmpPaths instanceof Set) {
        for (const p of context.tmpPaths) queueDeletion(p);
      }
      if (context.stagingPaths instanceof Set) {
        for (const p of context.stagingPaths) queueDeletion(p);
      }
      for (const p of collectTmpArtifacts(context.outputFolder)) queueDeletion(p);

      if (reason === 'CANCELLED' && context.plannedFinalOutputs instanceof Set) {
        for (const p of context.plannedFinalOutputs) queueDeletion(p);
        if (context.completedFinalOutputs instanceof Set) {
          for (const p of context.completedFinalOutputs) queueDeletion(p);
        }
        if (context.outputFolder) {
          queueDeletion(path.join(context.outputFolder, 'Logs', 'render-report.json'));
        }
      }

      for (const p of filesToDelete) {
        const lower = String(p || '').toLowerCase();
        const outcome = safeUnlink(p);
        if (!outcome.existed) continue;
        if (!outcome.removed) {
          stats.cleanupDeleteFailedCount += 1;
          if (stats.cleanupDeleteFailedExamples.length < 3) {
            stats.cleanupDeleteFailedExamples.push({
              path: String(p),
              error: String(outcome.error?.code || outcome.error?.message || outcome.error || 'unlink_failed'),
            });
          }
          continue;
        }
        removedCount += 1;
        if (lower.endsWith('.tmp') || lower.includes('.tmp.') || lower.endsWith('.partial')) {
          stats.cleanupDeletedTmpCount += 1;
        }
        else if (lower.endsWith('.mp4')) stats.cleanupDeletedFinalCount += 1;
      }

      if (context.createAlbumFolder) {
        const hadUserContentBefore = Boolean(context.outputFolderHadUserContentBefore);
        if (hadUserContentBefore) {
          if (logger?.warn) {
            logger.warn('cleanup.remove_folder_blocked', {
              ...logData,
              reason: 'preexisting_user_content',
              outputFolderExistedBefore: Boolean(context.outputFolderExistedBefore),
              outputFolderHadUserContentBefore: true,
            });
          }
        } else if (typeof context.safeRmdirIfEmpty === 'function') {
          if (!context.outputFolder) {
            logger?.warn?.('cleanup.skipped_no_outputFolder', {
              ...logData,
              createAlbumFolder: true,
            });
          } else {
            const logsDir = path.join(context.outputFolder, 'Logs');
            try {
              if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
                const logsEntries = fs.readdirSync(logsDir);
                if (logsEntries.length === 0) fs.rmdirSync(logsDir);
              }
            } catch {}
            context.safeRmdirIfEmpty(context.outputFolder);
            stats.cleanupRemovedEmptyFolder = !fs.existsSync(context.outputFolder);
          }
        }
      }

      if (stats.cleanupDeleteFailedCount > 0 && logger?.warn) {
        logger.warn('cleanup.delete_failed', {
          ...logData,
          cleanupDeleteFailedCount: stats.cleanupDeleteFailedCount,
          cleanupDeleteFailedExamples: stats.cleanupDeleteFailedExamples,
        });
      }

      context.cleanedUp = true;
      context.cleanupStats = stats;
      if (logger?.info) {
        logger.info('cleanup.end', {
          ...logData,
          removedCount,
          skippedFinalizePartialCount,
          ...stats,
        });
      }
      return stats;
    } catch (err) {
      context.cleanedUp = true;
      context.cleanupStats = stats;
      if (logger?.error) {
        logger.error('cleanup.unhandled_error', { ...logData, error: String(err?.message || err) });
      }
      if (logger?.info) {
        logger.info('cleanup.end', {
          ...logData,
          removedCount,
          skippedFinalizePartialCount,
          ...stats,
          cleanupUnhandledError: true,
        });
      }
      return stats;
    }
  })();

  return await context.cleanupPromise;
}

module.exports = { cleanupJob };
