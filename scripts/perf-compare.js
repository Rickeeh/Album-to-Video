#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASELINE_SCHEMA_FAMILY = 'perfBaseline';
const BASELINE_SCHEMA_VERSION = 1;
const PERF_RUN_SCHEMA_FAMILY = 'perfRunResult';
const PERF_RUN_SCHEMA_VERSION = 1;

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] || fallback;
}

function asBoolFlag(name) {
  return process.argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function formatMs(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${Math.round(value)}ms`;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function normalizeBudget(raw) {
  if (Number.isFinite(raw) && raw > 0) {
    return { maxRatio: Number(raw), mode: 'fail' };
  }
  const maxRatio = Number(raw?.maxRatio);
  const mode = String(raw?.mode || 'fail').toLowerCase() === 'warn' ? 'warn' : 'fail';
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) return null;
  return { maxRatio, mode };
}

function toFiniteMetric(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function loadRuntimeContract(baseline, caseId, runtimeKey) {
  const selectedCase = (baseline.cases || []).find((entry) => String(entry?.id || '') === String(caseId || ''));
  if (!selectedCase) return { selectedCase: null, runtimeContract: null };
  const runtimeBaselines = selectedCase.runtimeBaselines || {};
  const runtimeContract = runtimeBaselines[runtimeKey] || runtimeBaselines.default || null;
  return { selectedCase, runtimeContract };
}

function comparePerfObjects({ baseline, runResult, strictRuntime = false }) {
  const errors = [];
  const warnings = [];
  const rows = [];

  if (baseline?.schemaFamily !== BASELINE_SCHEMA_FAMILY || Number(baseline?.schemaVersion) !== BASELINE_SCHEMA_VERSION) {
    throw new Error('Unsupported perf baseline schema.');
  }
  if (runResult?.schemaFamily !== PERF_RUN_SCHEMA_FAMILY || Number(runResult?.schemaVersion) !== PERF_RUN_SCHEMA_VERSION) {
    throw new Error('Unsupported perf run result schema.');
  }

  const runtime = runResult.runtime || {};
  const runtimeKey = `${runtime.platform || 'unknown'}-${runtime.arch || 'unknown'}`;
  const caseId = runResult?.case?.id || null;

  const { selectedCase, runtimeContract } = loadRuntimeContract(baseline, caseId, runtimeKey);
  if (!selectedCase) {
    errors.push(`Missing baseline case: ${caseId}`);
    return { ok: false, errors, warnings, rows, runtimeKey, caseId, skipped: false };
  }

  if (!runtimeContract) {
    const msg = `No runtime baseline for ${runtimeKey} in case ${caseId}`;
    if (strictRuntime) {
      errors.push(msg);
      return { ok: false, errors, warnings, rows, runtimeKey, caseId, skipped: false };
    }
    warnings.push(`${msg}; skipping comparison (use --strict-runtime to fail).`);
    return { ok: true, errors, warnings, rows, runtimeKey, caseId, skipped: true };
  }

  const baselineMetrics = runtimeContract.metricsBaseline || {};
  const budgets = runtimeContract.budgets || {};
  const currentMetrics = runResult.metricsMedian || {};

  Object.keys(baselineMetrics).forEach((metricName) => {
    const baselineValue = toFiniteMetric(baselineMetrics[metricName]);
    const currentValueRaw = currentMetrics[metricName];
    const currentValue = toFiniteMetric(currentValueRaw);

    const budget = normalizeBudget(budgets[metricName]);
    if (!Number.isFinite(baselineValue)) {
      warnings.push(`Metric ${metricName}: baseline missing/invalid; skipping.`);
      return;
    }
    if (!budget) {
      warnings.push(`Metric ${metricName}: budget missing/invalid; skipping.`);
      return;
    }

    const allowedMax = baselineValue * budget.maxRatio;
    const hasCurrent = Number.isFinite(currentValue);
    const deltaMs = hasCurrent ? (currentValue - baselineValue) : null;
    const deltaPct = hasCurrent && baselineValue > 0
      ? ((deltaMs / baselineValue) * 100)
      : null;

    let status = 'PASS';
    let note = '';

    if (!hasCurrent) {
      status = budget.mode === 'warn' ? 'WARN' : 'FAIL';
      note = 'missing current metric';
    } else if (currentValue > allowedMax) {
      status = budget.mode === 'warn' ? 'WARN' : 'FAIL';
      note = `exceeded by ${formatMs(currentValue - allowedMax)}`;
    }

    rows.push({
      metric: metricName,
      baseline: baselineValue,
      current: currentValue,
      allowedMax,
      deltaMs,
      deltaPct,
      mode: budget.mode,
      status,
      note,
    });

    if (status === 'FAIL') {
      errors.push(`${metricName} exceeded budget (${formatMs(currentValue)} > ${formatMs(allowedMax)})`);
    } else if (status === 'WARN') {
      warnings.push(`${metricName} warning (${note || 'budget warning'})`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rows,
    runtimeKey,
    caseId,
    skipped: false,
  };
}

function printComparisonReport(result, runResult) {
  const runtime = runResult.runtime || {};
  console.log(`[perf-compare] case=${result.caseId} runtime=${result.runtimeKey} packaged=${runtime.isPackaged}`);

  if (result.skipped) {
    result.warnings.forEach((msg) => console.warn(`[perf-compare] WARN: ${msg}`));
    return;
  }

  console.log('[perf-compare] metric                      baseline   current   allowed   delta     mode   status');
  result.rows.forEach((row) => {
    const metric = `${row.metric}`.padEnd(27, ' ');
    const baseline = `${formatMs(row.baseline)}`.padEnd(9, ' ');
    const current = `${formatMs(row.current)}`.padEnd(9, ' ');
    const allowed = `${formatMs(row.allowedMax)}`.padEnd(9, ' ');
    const delta = `${formatPct(row.deltaPct)}`.padEnd(8, ' ');
    const mode = `${row.mode}`.padEnd(6, ' ');
    const status = `${row.status}`.padEnd(6, ' ');
    console.log(`[perf-compare] ${metric} ${baseline} ${current} ${allowed} ${delta} ${mode} ${status}${row.note ? ` ${row.note}` : ''}`);
  });

  const runRefs = Array.isArray(runResult.runs) ? runResult.runs.map((run) => ({
    run: run.runIndex,
    jobId: run.jobId || null,
    reportPath: run.reportPath || null,
    ffmpegSha256: run.ffmpegSha256 || null,
    binaryContractKey: run.binaryContractKey || null,
  })) : [];

  if (result.warnings.length > 0) {
    result.warnings.forEach((msg) => console.warn(`[perf-compare] WARN: ${msg}`));
  }
  if (result.errors.length > 0) {
    result.errors.forEach((msg) => console.error(`[perf-compare] FAIL: ${msg}`));
  }

  console.log('[perf-compare] run refs:');
  runRefs.forEach((row) => {
    console.log(`[perf-compare] run=${row.run} jobId=${row.jobId || 'n/a'} report=${row.reportPath || 'n/a'} ffmpegSha256=${row.ffmpegSha256 || 'n/a'} contractKey=${row.binaryContractKey || 'n/a'}`);
  });
}

function compareFromFiles({ baselinePath, runResultPath, strictRuntime = false }) {
  const resolvedBaselinePath = path.resolve(baselinePath || 'perf-baseline.json');
  const resolvedRunPath = path.resolve(runResultPath || path.join('dist', 'perf', 'perf-run-result.json'));

  if (!fs.existsSync(resolvedBaselinePath)) {
    throw new Error(`Baseline file not found: ${resolvedBaselinePath}`);
  }
  if (!fs.existsSync(resolvedRunPath)) {
    throw new Error(`Perf run result not found: ${resolvedRunPath}`);
  }

  const baseline = readJson(resolvedBaselinePath);
  const runResult = readJson(resolvedRunPath);

  const result = comparePerfObjects({ baseline, runResult, strictRuntime });
  return {
    ...result,
    baselinePath: resolvedBaselinePath,
    runResultPath: resolvedRunPath,
    runResult,
  };
}

if (require.main === module) {
  try {
    const baselinePath = getArg('--baseline', 'perf-baseline.json');
    const runResultPath = getArg('--result', path.join('dist', 'perf', 'perf-run-result.json'));
    const strictRuntime = asBoolFlag('--strict-runtime');

    const output = compareFromFiles({ baselinePath, runResultPath, strictRuntime });
    console.log(`[perf-compare] baseline=${output.baselinePath}`);
    console.log(`[perf-compare] result=${output.runResultPath}`);
    printComparisonReport(output, output.runResult);

    if (!output.ok) process.exit(1);
    console.log('[perf-compare] PASS');
  } catch (err) {
    console.error('[perf-compare] ERROR:', err?.message || err);
    process.exit(1);
  }
}

module.exports = {
  BASELINE_SCHEMA_FAMILY,
  BASELINE_SCHEMA_VERSION,
  PERF_RUN_SCHEMA_FAMILY,
  PERF_RUN_SCHEMA_VERSION,
  comparePerfObjects,
  compareFromFiles,
  normalizeBudget,
};
