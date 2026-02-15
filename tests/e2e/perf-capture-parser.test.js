const {
  parseLogEvents,
  findLastWarmupEvent,
  extractCaseSignals,
  metricText,
} = require('../../scripts/perf-capture-mac');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

(function run() {
  const sampleEvents = [
    { ts: '2026-02-15T00:00:00.000Z', level: 'info', msg: 'logger.ready' },
    { ts: '2026-02-15T00:00:00.050Z', level: 'info', msg: 'ffmpeg.warmup.done', durationMs: 12 },
    { ts: '2026-02-15T00:00:00.090Z', level: 'info', msg: 'ffmpeg.warmup.done', durationMs: 27 },
    { ts: '2026-02-15T00:00:01.000Z', level: 'info', msg: 'ffmpeg.first_write', jobId: 'job-cold', firstWriteMs: 137 },
    { ts: '2026-02-15T00:00:01.001Z', level: 'info', msg: 'ffmpeg.first_progress', jobId: 'job-cold', firstProgressMs: 137 },
    // Diagnostics-style wrapper event (msg/payload)
    {
      ts: '2026-02-15T00:00:02.000Z',
      level: 'info',
      msg: 'ffmpeg.first_write',
      payload: { jobId: 'job-warm', firstWriteMs: 55 },
    },
    {
      ts: '2026-02-15T00:00:02.001Z',
      level: 'info',
      msg: 'ffmpeg.first_progress',
      payload: { jobId: 'job-warm', firstProgressMs: 56 },
    },
  ];

  const parsed = parseLogEvents(sampleEvents);
  assertOk(parsed.length === sampleEvents.length, 'Parser test: expected all sample events to parse.');

  const warmup = findLastWarmupEvent(parsed);
  assertOk(warmup && warmup.data && warmup.data.durationMs === 27, 'Parser test: expected last warmup durationMs=27.');

  const coldSignals = extractCaseSignals(parsed, 'job-cold');
  assertOk(coldSignals.firstWriteEvent?.data?.firstWriteMs === 137, 'Parser test: expected cold firstWriteMs=137.');
  assertOk(coldSignals.firstProgressEvent?.data?.firstProgressMs === 137, 'Parser test: expected cold firstProgressMs=137.');

  const warmSignals = extractCaseSignals(parsed, 'job-warm');
  assertOk(warmSignals.firstWriteEvent?.data?.firstWriteMs === 55, 'Parser test: expected warm firstWriteMs=55.');
  assertOk(warmSignals.firstProgressEvent?.data?.firstProgressMs === 56, 'Parser test: expected warm firstProgressMs=56.');

  const metricOk = metricText(coldSignals.firstWriteEvent?.data?.firstWriteMs, null);
  assertOk(metricOk === '137', `Parser test: expected metricText numeric output, got ${metricOk}`);

  const missingSignals = extractCaseSignals(parsed, 'job-missing');
  assertOk(missingSignals.missing.length >= 2, 'Parser test: expected missing reasons for absent job events.');
  const missingText = metricText(null, missingSignals.missing[0]);
  assertOk(missingText.startsWith('missing ('), 'Parser test: expected explicit missing reason text.');

  console.log('OK: perf-capture parser extracts warmup/first signals deterministically');
})();
