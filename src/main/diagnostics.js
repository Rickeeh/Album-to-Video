const fs = require('fs');
const path = require('path');

const MAX_LOG_EVENTS = 200;
const MAX_RENDER_REPORT_BYTES = 256 * 1024; // 256 KiB

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function redactSensitivePathSegments(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  // Windows user profiles with slash/backslash and case variations.
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/]+/gi, '$1{USER}');
  // Bare \Users\<name>\... variants.
  out = out.replace(/([\\/]+Users[\\/]+)[^\\/]+/gi, '$1{USER}');
  // macOS user homes.
  out = out.replace(/(\/Users\/)[^/]+/g, '$1{USER}');
  // Optional volume name redaction on macOS paths.
  out = out.replace(/(\/Volumes\/)[^/]+/g, '$1{VOLUME}');
  // Keep token, redact user segment that follows it when present.
  out = out.replace(/(%USERPROFILE%[\\/]+)[^\\/]+/gi, '$1{USER}');
  return out;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return redactSensitivePathSegments(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
  return out;
}

function readSessionTail(sessionLogPath, maxEvents = MAX_LOG_EVENTS) {
  if (!sessionLogPath || !fs.existsSync(sessionLogPath)) {
    return { sessionLogPath: sanitizeValue(sessionLogPath || null), events: [], truncated: false };
  }

  const lines = fs.readFileSync(sessionLogPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-Math.max(1, maxEvents));
  const events = [];

  for (const line of tail) {
    try {
      const parsed = JSON.parse(line);
      const { ts = null, level = null, msg = null, ...payload } = parsed || {};
      events.push(sanitizeValue({ ts, level, msg, payload }));
    } catch {
      events.push(sanitizeValue({ ts: null, level: 'warn', msg: 'malformed.jsonl', payload: { raw: line } }));
    }
  }

  return {
    sessionLogPath: sanitizeValue(sessionLogPath),
    events,
    truncated: lines.length > tail.length,
  };
}

function normalizeProgressStatusTail(progressStatusTail, maxEvents = MAX_LOG_EVENTS) {
  if (!Array.isArray(progressStatusTail)) return [];
  const limit = Math.max(1, Number(maxEvents) || MAX_LOG_EVENTS);
  return progressStatusTail
    .slice(-limit)
    .map((entry) => {
      const row = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};
      const kindRaw = String(row.kind || row.type || '').toLowerCase();
      const kind = kindRaw === 'status' ? 'status' : (kindRaw === 'progress' ? 'progress' : 'unknown');
      const payload = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload))
        ? row.payload
        : {};
      return {
        ts: row.ts || null,
        kind,
        payload,
      };
    });
}

function findLastLogPayload(events, messageName) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i];
    if (!entry || entry.msg !== messageName) continue;
    return entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  }
  return null;
}

function readRenderReport(renderReportPath) {
  if (!renderReportPath || !fs.existsSync(renderReportPath)) {
    return {
      reportPath: sanitizeValue(renderReportPath || null),
      found: false,
      included: false,
      report: null,
    };
  }

  try {
    const stat = fs.statSync(renderReportPath);
    if (!stat.isFile()) {
      return {
        reportPath: sanitizeValue(renderReportPath),
        found: false,
        included: false,
        report: null,
      };
    }
    if (stat.size > MAX_RENDER_REPORT_BYTES) {
      return {
        reportPath: sanitizeValue(renderReportPath),
        found: true,
        included: false,
        reason: 'too_large',
        sizeBytes: stat.size,
        report: null,
      };
    }
    const raw = fs.readFileSync(renderReportPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      reportPath: sanitizeValue(renderReportPath),
      found: true,
      included: true,
      sizeBytes: stat.size,
      report: sanitizeValue(parsed),
    };
  } catch (err) {
    return {
      reportPath: sanitizeValue(renderReportPath),
      found: true,
      included: false,
      reason: 'read_error',
      readError: String(err?.message || err),
      report: null,
    };
  }
}

async function exportDiagnosticsBundle({
  destinationDir,
  appInfo,
  engineInfo,
  sessionLogPath,
  renderReportPath,
  pinnedWinBinaryHashes = null,
  maxLogEvents = MAX_LOG_EVENTS,
  startupPartialScan = null,
  startupJobRecovery = null,
  finalizeSummary = null,
  progressStatusTail = null,
}) {
  if (!destinationDir) throw new Error('Missing destinationDir for diagnostics export.');
  ensureDir(destinationDir);

  const logs = readSessionTail(sessionLogPath, maxLogEvents);
  const normalizedProgressStatusTail = normalizeProgressStatusTail(progressStatusTail, maxLogEvents);
  const startupFromLogs = findLastLogPayload(logs.events, 'startup.partial_scan');
  const finalizeFromLogs = findLastLogPayload(logs.events, 'finalize.summary');

  const diagnostics = sanitizeValue({
    generatedAt: new Date().toISOString(),
    app: appInfo || {},
    engine: {
      ...(engineInfo || {}),
      pinnedWinBinaryHashes: pinnedWinBinaryHashes || null,
    },
    logs: {
      ...logs,
      progressStatusTail: normalizedProgressStatusTail,
    },
    observability: {
      startupPartialScan: startupPartialScan || startupFromLogs || null,
      startupJobRecovery: startupJobRecovery || null,
      finalizeSummary: finalizeSummary || finalizeFromLogs || null,
    },
    render: readRenderReport(renderReportPath),
  });

  const diagnosticsPath = path.join(destinationDir, 'diagnostics.json');
  fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  return { diagnosticsPath, diagnostics };
}

module.exports = {
  MAX_LOG_EVENTS,
  MAX_RENDER_REPORT_BYTES,
  exportDiagnosticsBundle,
  redactSensitivePathSegments,
  sanitizeValue,
};
