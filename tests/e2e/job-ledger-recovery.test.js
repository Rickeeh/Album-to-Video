const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  JOB_LEDGER_SCHEMA_FAMILY,
  JOB_LEDGER_SCHEMA_VERSION,
  getJobLedgerDir,
  createJobLedger,
  recoverInProgressLedgers,
  completeJobLedger,
} = require('../../src/main/job-ledger');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function safeRmdirIfEmpty(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath).filter((name) => name !== '.DS_Store' && name !== 'Thumbs.db');
    if (entries.length === 0) fs.rmdirSync(dirPath);
  } catch {}
}

(function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-ledger-e2e-'));
  const appLogDir = path.join(root, 'app-logs');
  const ledgerDir = getJobLedgerDir(appLogDir);
  const exportFolder = path.join(root, 'exports', 'Release');
  fs.mkdirSync(exportFolder, { recursive: true });

  const tmpOne = path.join(exportFolder, '01.mp4.partial');
  const tmpTwo = path.join(exportFolder, 'scratch.tmp');
  const finalOne = path.join(exportFolder, '01.mp4');
  const outsideTmp = path.join(root, 'outside.partial');
  const legacyTmp = path.join(exportFolder, 'legacy.partial');
  const unsupportedTmp = path.join(exportFolder, 'unsupported.partial');

  fs.writeFileSync(tmpOne, 'partial-a');
  fs.writeFileSync(tmpTwo, 'tmp-b');
  fs.writeFileSync(finalOne, 'final-keep');
  fs.writeFileSync(outsideTmp, 'outside-keep');
  fs.writeFileSync(legacyTmp, 'legacy-keep');
  fs.writeFileSync(unsupportedTmp, 'unsupported-keep');

  const { ledgerPath } = createJobLedger({
    ledgerDir,
    jobId: 'job-crash-sim',
    exportFolder,
    tmpPaths: [tmpOne, tmpTwo, outsideTmp],
    outputFinalPaths: [finalOne],
    logPath: path.join(appLogDir, 'session-test.jsonl'),
  });

  // Add one terminal ledger that must be ignored by recovery.
  const terminal = createJobLedger({
    ledgerDir,
    jobId: 'job-terminal-ignore',
    exportFolder,
    tmpPaths: [path.join(exportFolder, 'ignored.partial')],
    outputFinalPaths: [path.join(exportFolder, 'ignored.mp4')],
    logPath: path.join(appLogDir, 'session-test.jsonl'),
  });
  completeJobLedger({
    ledgerPath: terminal.ledgerPath,
    status: 'DONE',
    cleanupComplete: true,
  });

  // Corrupted ledger should be ignored (fail-safe).
  const corruptPath = path.join(ledgerDir, 'job-ledger-corrupt.json');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(corruptPath, '{broken json', 'utf8');

  // Legacy ledger without schemaVersion should be ignored (fail-safe, no cleanup).
  const legacyPath = path.join(ledgerDir, 'job-ledger-legacy-v0.json');
  fs.writeFileSync(legacyPath, JSON.stringify({
    jobId: 'legacy-v0',
    state: 'IN_PROGRESS',
    exportFolder,
    tmpPaths: [legacyTmp],
    outputFinalPaths: [],
  }, null, 2), 'utf8');

  // Unsupported schema version should be ignored (fail-safe, no cleanup).
  const unsupportedPath = path.join(ledgerDir, 'job-ledger-unsupported-v99.json');
  fs.writeFileSync(unsupportedPath, JSON.stringify({
    schemaFamily: JOB_LEDGER_SCHEMA_FAMILY,
    schemaVersion: 99,
    jobId: 'unsupported-v99',
    state: 'IN_PROGRESS',
    exportFolder,
    tmpPaths: [unsupportedTmp],
    outputFinalPaths: [],
  }, null, 2), 'utf8');

  const events = [];
  const logger = {
    info: (msg, payload) => events.push({ level: 'info', msg, payload }),
    warn: (msg, payload) => events.push({ level: 'warn', msg, payload }),
    error: (msg, payload) => events.push({ level: 'error', msg, payload }),
  };

  const summary = recoverInProgressLedgers({
    ledgerDir,
    logger,
    safeRmdirIfEmpty,
    redactPath: (v) => v,
    maxLedgers: 50,
  });

  assertOk(summary.inProgressDetected === 1, `Ledger recovery: expected 1 supported in-progress ledger, got ${summary.inProgressDetected}.`);
  assertOk(summary.cleanedLedgers === 1, `Ledger recovery: expected 1 cleaned ledger, got ${summary.cleanedLedgers}.`);
  assertOk(summary.deletedTmpCount >= 2, `Ledger recovery: expected >=2 tmp deletions, got ${summary.deletedTmpCount}.`);
  assertOk(summary.blockedOutsideBaseCount >= 1, 'Ledger recovery: expected outside-base path to be blocked.');
  assertOk(summary.invalidLedgers >= 3, 'Ledger recovery: expected invalid/corrupt + unsupported schema ledgers.');

  assertOk(!fs.existsSync(tmpOne), 'Ledger recovery: expected in-base partial tmp to be deleted.');
  assertOk(!fs.existsSync(tmpTwo), 'Ledger recovery: expected in-base tmp to be deleted.');
  assertOk(fs.existsSync(finalOne), 'Ledger recovery: final output must not be deleted.');
  assertOk(fs.existsSync(outsideTmp), 'Ledger recovery: outside-base file must not be touched.');
  assertOk(fs.existsSync(legacyTmp), 'Ledger recovery: legacy (missing schema) tmp must not be touched.');
  assertOk(fs.existsSync(unsupportedTmp), 'Ledger recovery: unsupported schema tmp must not be touched.');
  assertOk(!fs.existsSync(ledgerPath), 'Ledger recovery: in-progress ledger should be removed after cleanup.');
  assertOk(fs.existsSync(terminal.ledgerPath), 'Ledger recovery: terminal ledger should be left untouched.');
  assertOk(fs.existsSync(corruptPath), 'Ledger recovery: corrupt ledger should be ignored (not deleted).');
  assertOk(fs.existsSync(legacyPath), 'Ledger recovery: legacy schema-missing ledger should be ignored (not deleted).');
  assertOk(fs.existsSync(unsupportedPath), 'Ledger recovery: unsupported schema ledger should be ignored (not deleted).');

  const detected = events.find((e) => e.msg === 'job.recovery.detected');
  const cleaned = events.find((e) => e.msg === 'job.recovery.cleaned');
  const schemaMissing = events.find((e) => e.msg === 'schema.missing' && e.payload?.type === 'jobLedger');
  const schemaUnsupported = events.find((e) => e.msg === 'schema.unsupported' && e.payload?.type === 'jobLedger');
  assertOk(Boolean(detected), 'Ledger recovery: missing job.recovery.detected log event.');
  assertOk(Boolean(cleaned), 'Ledger recovery: missing job.recovery.cleaned log event.');
  assertOk(Boolean(schemaMissing), 'Ledger recovery: missing schema.missing log for jobLedger.');
  assertOk(Boolean(schemaUnsupported), 'Ledger recovery: missing schema.unsupported log for jobLedger.');
  assertOk(
    schemaMissing?.payload?.expectedSchemaVersion === JOB_LEDGER_SCHEMA_VERSION,
    'Ledger recovery: schema.missing should include expected schema version.'
  );

  console.log('OK: crash-safe cleanup ledger recovers in-progress job artifacts deterministically');
})();
