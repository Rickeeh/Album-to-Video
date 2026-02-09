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

function cleanupJob(jobId, reason, context) {
  if (!context || context.cleanedUp) return;
  context.cleanedUp = true;

  const logger = context.logger;
  const logData = { jobId, reason };
  if (logger?.info) logger.info('cleanup.start', logData);

  const activeProcess = typeof context.getActiveProcess === 'function'
    ? context.getActiveProcess()
    : null;
  if (activeProcess && !activeProcess.killed) {
    try {
      context.killProcessTree(activeProcess);
      if (logger?.warn) logger.warn('cleanup.ffmpeg_killed', logData);
    } catch (err) {
      if (logger?.error) {
        logger.error('cleanup.kill_failed', { ...logData, error: String(err?.message || err) });
      }
    }
  }

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

  for (const p of filesToDelete) safeUnlink(p);

  if (context.createAlbumFolder && typeof context.safeRmdirIfEmpty === 'function') {
    context.safeRmdirIfEmpty(context.outputFolder);
  }

  if (logger?.info) logger.info('cleanup.end', { ...logData, removedCount: filesToDelete.size });
}

module.exports = { cleanupJob };
