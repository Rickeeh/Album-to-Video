const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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

  fs.writeFileSync(tmpOne, 'partial-a');
  fs.writeFileSync(tmpTwo, 'tmp-b');
  fs.writeFileSync(finalOne, 'final-keep');
  fs.writeFileSync(outsideTmp, 'outside-keep');

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

  assertOk(summary.inProgressDetected === 1, `Ledger recovery: expected 1 in-progress ledger, got ${summary.inProgressDetected}.`);
  assertOk(summary.cleanedLedgers === 1, `Ledger recovery: expected 1 cleaned ledger, got ${summary.cleanedLedgers}.`);
  assertOk(summary.deletedTmpCount >= 2, `Ledger recovery: expected >=2 tmp deletions, got ${summary.deletedTmpCount}.`);
  assertOk(summary.blockedOutsideBaseCount >= 1, 'Ledger recovery: expected outside-base path to be blocked.');
  assertOk(summary.invalidLedgers >= 1, 'Ledger recovery: expected at least one invalid/corrupt ledger.');

  assertOk(!fs.existsSync(tmpOne), 'Ledger recovery: expected in-base partial tmp to be deleted.');
  assertOk(!fs.existsSync(tmpTwo), 'Ledger recovery: expected in-base tmp to be deleted.');
  assertOk(fs.existsSync(finalOne), 'Ledger recovery: final output must not be deleted.');
  assertOk(fs.existsSync(outsideTmp), 'Ledger recovery: outside-base file must not be touched.');
  assertOk(!fs.existsSync(ledgerPath), 'Ledger recovery: in-progress ledger should be removed after cleanup.');
  assertOk(fs.existsSync(terminal.ledgerPath), 'Ledger recovery: terminal ledger should be left untouched.');
  assertOk(fs.existsSync(corruptPath), 'Ledger recovery: corrupt ledger should be ignored (not deleted).');

  const detected = events.find((e) => e.msg === 'job.recovery.detected');
  const cleaned = events.find((e) => e.msg === 'job.recovery.cleaned');
  assertOk(Boolean(detected), 'Ledger recovery: missing job.recovery.detected log event.');
  assertOk(Boolean(cleaned), 'Ledger recovery: missing job.recovery.cleaned log event.');

  console.log('OK: crash-safe cleanup ledger recovers in-progress job artifacts deterministically');
})();
