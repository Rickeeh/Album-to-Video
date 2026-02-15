const fs = require('fs');
const path = require('path');

const JOB_LEDGER_SCHEMA_FAMILY = 'jobLedger';
const JOB_LEDGER_SCHEMA_VERSION = 1;
const JOB_LEDGER_STATE_IN_PROGRESS = 'IN_PROGRESS';
const TERMINAL_STATES = new Set(['DONE', 'FAILED', 'CANCELLED']);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeLedgerFileBase(input) {
  const cleaned = String(input || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || `job-${Date.now()}`;
}

function isAbsolutePath(p) {
  return typeof p === 'string' && p.length > 0 && path.isAbsolute(p);
}

function resolvePathSafe(p) {
  return path.resolve(String(p || ''));
}

function isPathWithinBase(basePath, targetPath) {
  const base = resolvePathSafe(basePath);
  const target = resolvePathSafe(targetPath);
  const rel = path.relative(base, target);
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) fs.unlinkSync(filePath);
    }
  } catch {}
}

function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function getJobLedgerDir(appLogDir) {
  return path.join(String(appLogDir || ''), 'job-ledgers');
}

function listLedgerFiles(ledgerDir) {
  if (!ledgerDir || !fs.existsSync(ledgerDir)) return [];
  try {
    return fs.readdirSync(ledgerDir)
      .filter((name) => /^job-ledger-.*\.json$/i.test(name))
      .map((name) => path.join(ledgerDir, name));
  } catch {
    return [];
  }
}

function logSchemaEvent({ logger, code, type, ledgerPath, schemaVersion = null, expectedSchemaVersion = null, redactPath }) {
  const redact = typeof redactPath === 'function' ? redactPath : (v) => v;
  const payload = {
    type,
    path: redact(ledgerPath),
    schemaVersion,
    expectedSchemaVersion,
    schemaFamily: JOB_LEDGER_SCHEMA_FAMILY,
  };
  if (code === 'schema.missing') logger?.warn?.('schema.missing', payload);
  else if (code === 'schema.unsupported') logger?.warn?.('schema.unsupported', payload);
}

function validateLedgerSchema(ledger, ledgerPath, { logger = null, redactPath = null } = {}) {
  const schemaVersion = Number(ledger?.schemaVersion);
  if (!Number.isFinite(schemaVersion)) {
    logSchemaEvent({
      logger,
      code: 'schema.missing',
      type: 'jobLedger',
      ledgerPath,
      schemaVersion: null,
      expectedSchemaVersion: JOB_LEDGER_SCHEMA_VERSION,
      redactPath,
    });
    return { ok: false, reason: 'schema_missing' };
  }
  if (schemaVersion !== JOB_LEDGER_SCHEMA_VERSION) {
    logSchemaEvent({
      logger,
      code: 'schema.unsupported',
      type: 'jobLedger',
      ledgerPath,
      schemaVersion,
      expectedSchemaVersion: JOB_LEDGER_SCHEMA_VERSION,
      redactPath,
    });
    return { ok: false, reason: 'schema_unsupported' };
  }

  if (String(ledger?.schemaFamily || '') !== JOB_LEDGER_SCHEMA_FAMILY) {
    logSchemaEvent({
      logger,
      code: 'schema.unsupported',
      type: 'jobLedger',
      ledgerPath,
      schemaVersion,
      expectedSchemaVersion: JOB_LEDGER_SCHEMA_VERSION,
      redactPath,
    });
    return { ok: false, reason: 'schema_family_unsupported' };
  }

  return { ok: true, schemaVersion };
}

function createJobLedger({
  ledgerDir,
  jobId,
  exportFolder,
  tmpPaths = [],
  outputFinalPaths = [],
  logPath = null,
}) {
  if (!isAbsolutePath(exportFolder)) {
    throw new Error(`Invalid exportFolder for job ledger: ${exportFolder}`);
  }
  const safeJobId = sanitizeLedgerFileBase(jobId || `job-${Date.now()}`);
  const ledgerPath = path.join(ledgerDir, `job-ledger-${safeJobId}.json`);

  const ledger = {
    schemaFamily: JOB_LEDGER_SCHEMA_FAMILY,
    schemaVersion: JOB_LEDGER_SCHEMA_VERSION,
    jobId: String(jobId || ''),
    createdAt: new Date().toISOString(),
    exportFolder: resolvePathSafe(exportFolder),
    tmpPaths: [...new Set((Array.isArray(tmpPaths) ? tmpPaths : [])
      .map((p) => resolvePathSafe(p))
      .filter((p) => isAbsolutePath(p)))],
    outputFinalPaths: [...new Set((Array.isArray(outputFinalPaths) ? outputFinalPaths : [])
      .map((p) => resolvePathSafe(p))
      .filter((p) => isAbsolutePath(p)))],
    logPath: isAbsolutePath(logPath) ? resolvePathSafe(logPath) : null,
    state: JOB_LEDGER_STATE_IN_PROGRESS,
    cleanupComplete: false,
    completedAt: null,
    reasonCode: null,
  };

  writeJsonAtomic(ledgerPath, ledger);
  return { ledgerPath, ledger };
}

function completeJobLedger({ ledgerPath, status, cleanupComplete = true, reasonCode = null }) {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!TERMINAL_STATES.has(normalizedStatus)) {
    throw new Error(`Invalid terminal ledger status: ${normalizedStatus}`);
  }

  const current = readJsonFile(ledgerPath);
  const schemaCheck = validateLedgerSchema(current, ledgerPath);
  if (!schemaCheck.ok) {
    throw new Error(`Unsupported job ledger schema (${schemaCheck.reason}) for ${ledgerPath}`);
  }

  const next = {
    ...current,
    state: normalizedStatus,
    cleanupComplete: Boolean(cleanupComplete),
    completedAt: new Date().toISOString(),
    reasonCode: reasonCode ? String(reasonCode) : null,
  };
  writeJsonAtomic(ledgerPath, next);
  return next;
}

function deleteJobLedger(ledgerPath) {
  safeUnlink(ledgerPath);
}

function buildRecoveryDeleteCandidates(ledger) {
  const candidates = new Set();
  if (Array.isArray(ledger.tmpPaths)) {
    for (const p of ledger.tmpPaths) candidates.add(resolvePathSafe(p));
  }
  if (Array.isArray(ledger.outputFinalPaths)) {
    for (const outputPath of ledger.outputFinalPaths) {
      const normalized = resolvePathSafe(outputPath);
      if (String(normalized).toLowerCase().endsWith('.partial')) {
        candidates.add(normalized);
      } else {
        candidates.add(`${normalized}.partial`);
      }
    }
  }
  return [...candidates];
}

function recoverInProgressLedgers({
  ledgerDir,
  logger,
  safeRmdirIfEmpty,
  redactPath,
  maxLedgers = 100,
}) {
  const redact = typeof redactPath === 'function' ? redactPath : (v) => v;
  const files = listLedgerFiles(ledgerDir).slice(0, Math.max(1, Number(maxLedgers) || 100));

  const summary = {
    scannedLedgers: files.length,
    inProgressDetected: 0,
    cleanedLedgers: 0,
    invalidLedgers: 0,
    deletedTmpCount: 0,
    blockedOutsideBaseCount: 0,
  };

  for (const ledgerPath of files) {
    let ledger = null;
    try {
      ledger = readJsonFile(ledgerPath);
    } catch (err) {
      summary.invalidLedgers += 1;
      logger?.warn?.('job.recovery.detected', {
        ledgerPath: redact(ledgerPath),
        valid: false,
        reason: 'invalid_json',
        message: String(err?.message || err),
      });
      continue;
    }

    const schemaCheck = validateLedgerSchema(ledger, ledgerPath, { logger, redactPath });
    if (!schemaCheck.ok) {
      summary.invalidLedgers += 1;
      logger?.warn?.('job.recovery.detected', {
        ledgerPath: redact(ledgerPath),
        valid: false,
        reason: schemaCheck.reason,
      });
      continue;
    }

    const state = String(ledger?.state || '');
    if (state !== JOB_LEDGER_STATE_IN_PROGRESS) continue;
    const exportFolder = String(ledger?.exportFolder || '');
    if (!isAbsolutePath(exportFolder)) {
      summary.invalidLedgers += 1;
      logger?.warn?.('job.recovery.detected', {
        ledgerPath: redact(ledgerPath),
        valid: false,
        reason: 'invalid_export_folder',
      });
      continue;
    }

    summary.inProgressDetected += 1;
    logger?.warn?.('job.recovery.detected', {
      ledgerPath: redact(ledgerPath),
      jobId: ledger?.jobId || null,
      exportFolder: redact(exportFolder),
      state,
      schemaVersion: JOB_LEDGER_SCHEMA_VERSION,
    });

    const candidates = buildRecoveryDeleteCandidates(ledger);
    const parentDirs = new Set();
    let deleted = 0;
    let blocked = 0;

    for (const candidate of candidates) {
      const resolved = resolvePathSafe(candidate);
      const lower = String(resolved).toLowerCase();
      const allowedSuffix = lower.endsWith('.tmp') || lower.includes('.tmp.') || lower.endsWith('.partial');
      if (!allowedSuffix) continue;
      if (!isPathWithinBase(exportFolder, resolved)) {
        blocked += 1;
        continue;
      }
      if (!fs.existsSync(resolved)) continue;
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      safeUnlink(resolved);
      if (!fs.existsSync(resolved)) {
        deleted += 1;
        parentDirs.add(path.dirname(resolved));
      }
    }

    if (typeof safeRmdirIfEmpty === 'function') {
      [...parentDirs].forEach((dirPath) => {
        try { safeRmdirIfEmpty(dirPath); } catch {}
      });
      try { safeRmdirIfEmpty(exportFolder); } catch {}
    }

    summary.cleanedLedgers += 1;
    summary.deletedTmpCount += deleted;
    summary.blockedOutsideBaseCount += blocked;

    logger?.info?.('job.recovery.cleaned', {
      ledgerPath: redact(ledgerPath),
      jobId: ledger?.jobId || null,
      exportFolder: redact(exportFolder),
      deletedTmpCount: deleted,
      blockedOutsideBaseCount: blocked,
      schemaVersion: JOB_LEDGER_SCHEMA_VERSION,
    });

    safeUnlink(ledgerPath);
  }

  return summary;
}

module.exports = {
  JOB_LEDGER_SCHEMA_FAMILY,
  JOB_LEDGER_SCHEMA_VERSION,
  JOB_LEDGER_STATE_IN_PROGRESS,
  getJobLedgerDir,
  createJobLedger,
  completeJobLedger,
  deleteJobLedger,
  recoverInProgressLedgers,
  validateLedgerSchema,
};
