const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateLogs } = require('../../src/main/logger');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

(function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-logger-rotation-e2e-'));
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const names = ['session-c.jsonl', 'session-a.jsonl', 'session-b.jsonl'];
  names.forEach((name) => fs.writeFileSync(path.join(logDir, name), `${name}\n`, 'utf8'));

  const equalMtime = new Date('2026-01-01T00:00:00.000Z');
  names.forEach((name) => {
    const fullPath = path.join(logDir, name);
    fs.utimesSync(fullPath, equalMtime, equalMtime);
  });

  rotateLogs(logDir, 2);

  const remaining = fs.readdirSync(logDir).sort((a, b) => String(a).localeCompare(String(b)));
  assertOk(remaining.length === 2, `Logger rotation: expected 2 files after rotate, got ${remaining.length}.`);
  assertOk(
    remaining[0] === 'session-b.jsonl' && remaining[1] === 'session-c.jsonl',
    `Logger rotation: expected deterministic tie-break keep [session-b.jsonl, session-c.jsonl], got [${remaining.join(', ')}].`
  );

  console.log('OK: logger rotation is deterministic when mtime ties occur');
})();
