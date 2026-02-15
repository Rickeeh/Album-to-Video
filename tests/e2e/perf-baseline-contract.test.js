const { comparePerfObjects } = require('../../scripts/perf-compare');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function makeBaseline() {
  return {
    schemaFamily: 'perfBaseline',
    schemaVersion: 1,
    cases: [
      {
        id: 'album_small_wav',
        runtimeBaselines: {
          'darwin-arm64': {
            metricsBaseline: {
              encodeMsTotal: 1000,
              finalizeMsTotal: 20,
              ffmpegSpawnMs: 400,
            },
            budgets: {
              encodeMsTotal: { maxRatio: 1.25, mode: 'fail' },
              finalizeMsTotal: { maxRatio: 1.35, mode: 'fail' },
              ffmpegSpawnMs: { maxRatio: 1.5, mode: 'warn' },
            },
          },
        },
      },
    ],
  };
}

function makeRunResult(metricsMedian) {
  return {
    schemaFamily: 'perfRunResult',
    schemaVersion: 1,
    runtime: {
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: false,
    },
    case: {
      id: 'album_small_wav',
    },
    metricsMedian,
    runs: [],
  };
}

(function run() {
  const baseline = makeBaseline();

  const passWithWarning = comparePerfObjects({
    baseline,
    runResult: makeRunResult({
      encodeMsTotal: 1100,
      finalizeMsTotal: 22,
      ffmpegSpawnMs: 700,
    }),
    strictRuntime: true,
  });

  assertOk(passWithWarning.ok, 'Expected pass when fail-gated metrics are within budget.');
  assertOk(passWithWarning.warnings.length >= 1, 'Expected warn-only metric to produce warning, not failure.');

  const failing = comparePerfObjects({
    baseline,
    runResult: makeRunResult({
      encodeMsTotal: 1400,
      finalizeMsTotal: 22,
      ffmpegSpawnMs: 500,
    }),
    strictRuntime: true,
  });

  assertOk(!failing.ok, 'Expected failure when encodeMsTotal exceeds fail budget.');
  assertOk(failing.errors.some((msg) => msg.includes('encodeMsTotal')), 'Expected encodeMsTotal failure reason.');

  const noRuntimeNonStrict = comparePerfObjects({
    baseline,
    runResult: {
      ...makeRunResult({ encodeMsTotal: 1000, finalizeMsTotal: 20, ffmpegSpawnMs: 300 }),
      runtime: { platform: 'linux', arch: 'x64', isPackaged: false },
    },
    strictRuntime: false,
  });

  assertOk(noRuntimeNonStrict.ok, 'Expected non-strict runtime mode to skip unknown runtime.');
  assertOk(noRuntimeNonStrict.skipped, 'Expected skipped=true when runtime baseline is missing in non-strict mode.');

  console.log('OK: perf baseline comparator enforces fail/warn budgets deterministically');
})();
