const fs = require('fs');
const path = require('path');

const MAX_LOG_EVENTS = 200;
const MAX_RENDER_REPORT_BYTES = 256 * 1024; // 256 KiB
const RENDER_REPORT_SCHEMA_FAMILY = 'renderReport';
const RENDER_REPORT_SCHEMA_VERSION = 1;
const DIAGNOSTICS_SCHEMA_FAMILY = 'diagnostics';
const DIAGNOSTICS_SCHEMA_VERSION = 1;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function redactSensitivePathSegments(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  // UNC shares where user home-style folders are nested (\\SERVER\share\Users\name\...).
  out = out.replace(/(\\\\[^\\\/]+\\[^\\\/]+\\Users\\)[^\\\/]+/gi, '$1{USER}');
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

function makeSchemaEvent({ code, type, filePath, schemaVersion = null, expectedSchemaVersion = null }) {
  return sanitizeValue({
    code,
    type,
    path: filePath || null,
    schemaVersion,
    expectedSchemaVersion,
  });
}

function validateSchemaEnvelope({
  artifactType,
  parsed,
  filePath,
  expectedSchemaFamily,
  expectedSchemaVersion,
}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'schema.unsupported',
      reason: 'invalid_object',
      event: makeSchemaEvent({
        code: 'schema.unsupported',
        type: artifactType,
        filePath,
        schemaVersion: null,
        expectedSchemaVersion,
      }),
    };
  }

  const schemaVersion = Number(parsed.schemaVersion);
  if (!Number.isFinite(schemaVersion)) {
    return {
      ok: false,
      code: 'schema.missing',
      reason: 'missing_schema_version',
      event: makeSchemaEvent({
        code: 'schema.missing',
        type: artifactType,
        filePath,
        schemaVersion: null,
        expectedSchemaVersion,
      }),
    };
  }

  if (schemaVersion !== expectedSchemaVersion) {
    return {
      ok: false,
      code: 'schema.unsupported',
      reason: 'unsupported_schema_version',
      event: makeSchemaEvent({
        code: 'schema.unsupported',
        type: artifactType,
        filePath,
        schemaVersion,
        expectedSchemaVersion,
      }),
    };
  }

  if (String(parsed.schemaFamily || '') !== expectedSchemaFamily) {
    return {
      ok: false,
      code: 'schema.unsupported',
      reason: 'unsupported_schema_family',
      event: makeSchemaEvent({
        code: 'schema.unsupported',
        type: artifactType,
        filePath,
        schemaVersion,
        expectedSchemaVersion,
      }),
    };
  }

  return { ok: true, schemaVersion };
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

function readRenderReport(renderReportPath, schemaEvents = []) {
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
    const schemaCheck = validateSchemaEnvelope({
      artifactType: 'renderReport',
      parsed,
      filePath: renderReportPath,
      expectedSchemaFamily: RENDER_REPORT_SCHEMA_FAMILY,
      expectedSchemaVersion: RENDER_REPORT_SCHEMA_VERSION,
    });
    if (!schemaCheck.ok) {
      if (schemaCheck.event) schemaEvents.push(schemaCheck.event);
      return {
        reportPath: sanitizeValue(renderReportPath),
        found: true,
        included: false,
        reason: schemaCheck.code === 'schema.missing' ? 'schema_missing' : 'schema_unsupported',
        schemaVersion: Number.isFinite(Number(parsed?.schemaVersion)) ? Number(parsed.schemaVersion) : null,
        expectedSchemaVersion: RENDER_REPORT_SCHEMA_VERSION,
        sizeBytes: stat.size,
        report: null,
      };
    }

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

function readDiagnosticsBundle(diagnosticsPath) {
  if (!diagnosticsPath || !fs.existsSync(diagnosticsPath)) {
    return {
      diagnosticsPath: sanitizeValue(diagnosticsPath || null),
      found: false,
      supported: false,
      diagnostics: null,
      schemaEvent: null,
    };
  }

  try {
    const raw = fs.readFileSync(diagnosticsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const schemaCheck = validateSchemaEnvelope({
      artifactType: 'diagnostics',
      parsed,
      filePath: diagnosticsPath,
      expectedSchemaFamily: DIAGNOSTICS_SCHEMA_FAMILY,
      expectedSchemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    });
    if (!schemaCheck.ok) {
      return {
        diagnosticsPath: sanitizeValue(diagnosticsPath),
        found: true,
        supported: false,
        diagnostics: null,
        schemaEvent: schemaCheck.event || null,
      };
    }
    return {
      diagnosticsPath: sanitizeValue(diagnosticsPath),
      found: true,
      supported: true,
      diagnostics: sanitizeValue(parsed),
      schemaEvent: null,
    };
  } catch (err) {
    return {
      diagnosticsPath: sanitizeValue(diagnosticsPath),
      found: true,
      supported: false,
      diagnostics: null,
      reason: 'read_error',
      readError: String(err?.message || err),
      schemaEvent: null,
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

  const schemaEvents = [];
  const logs = readSessionTail(sessionLogPath, maxLogEvents);
  const normalizedProgressStatusTail = normalizeProgressStatusTail(progressStatusTail, maxLogEvents);
  const startupFromLogs = findLastLogPayload(logs.events, 'startup.partial_scan');
  const finalizeFromLogs = findLastLogPayload(logs.events, 'finalize.summary');

  const diagnostics = sanitizeValue({
    schemaFamily: DIAGNOSTICS_SCHEMA_FAMILY,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
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
    render: readRenderReport(renderReportPath, schemaEvents),
  });

  const diagnosticsPath = path.join(destinationDir, 'diagnostics.json');
  fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  return { diagnosticsPath, diagnostics, schemaEvents: schemaEvents.map((event) => sanitizeValue(event)) };
}

module.exports = {
  MAX_LOG_EVENTS,
  MAX_RENDER_REPORT_BYTES,
  RENDER_REPORT_SCHEMA_FAMILY,
  RENDER_REPORT_SCHEMA_VERSION,
  DIAGNOSTICS_SCHEMA_FAMILY,
  DIAGNOSTICS_SCHEMA_VERSION,
  exportDiagnosticsBundle,
  readDiagnosticsBundle,
  redactSensitivePathSegments,
  sanitizeValue,
};
