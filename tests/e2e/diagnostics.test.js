const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  exportDiagnosticsBundle,
  MAX_RENDER_REPORT_BYTES,
} = require('../../src/main/diagnostics');

function assertOk(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

(async () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assertOk(
    mainSource.includes("registerIpcHandler('export-diagnostics'"),
    'Diagnostics test: export-diagnostics IPC handler is not registered in main.js.'
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-to-video-diag-e2e-'));
  const destinationDir = path.join(root, 'Release', 'Logs');
  const appLogsDestinationDir = path.join(root, 'AppLogs');
  const sessionLogPath = path.join(root, 'session-test.jsonl');
  const renderReportPath = path.join(destinationDir, 'render-report.json');
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.mkdirSync(appLogsDestinationDir, { recursive: true });

  // Build >200 events to validate deterministic tailing.
  const events = [];
  for (let i = 0; i < 220; i += 1) {
    events.push(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `event.${i}`,
      filePath: '/Users/alice/private/path/file.mp4',
      winPath: 'C:\\Users\\Alice\\private\\path\\file.mp4',
      macVolumePath: '/Volumes/AliceDrive/private/path/file.mp4',
    }));
  }
  fs.writeFileSync(sessionLogPath, `${events.join('\n')}\n`, 'utf8');

  fs.writeFileSync(renderReportPath, JSON.stringify({
    reportVersion: 1,
    outputPath: '/Users/alice/exports/final.mp4',
  }), 'utf8');

  const result = await exportDiagnosticsBundle({
    destinationDir,
    appInfo: {
      appVersion: '1.0.0',
      platform: process.platform,
      arch: process.arch,
      execPath: '/Users/alice/Applications/Album to Video.app',
      resourcesPath: 'C:\\Users\\Alice\\AppData\\Roaming\\Album-to-Video\\resources',
    },
    engineInfo: {
      GLOBAL_FPS: 1,
      binaries: {
        FFMPEG_SOURCE: 'vendored',
        FFMPEG_PATH: '/Users/alice/bin/ffmpeg',
      },
    },
    sessionLogPath,
    renderReportPath,
    pinnedWinBinaryHashes: {
      'ffmpeg.exe': 'hash1',
      'ffprobe.exe': 'hash2',
    },
    maxLogEvents: 200,
  });

  assertOk(result && result.diagnosticsPath, 'Diagnostics test: expected diagnosticsPath result.');
  assertOk(fs.existsSync(result.diagnosticsPath), 'Diagnostics test: diagnostics.json was not created.');

  // Also validate destination without exportFolder semantics (app logs destination path).
  const resultNoExportFolder = await exportDiagnosticsBundle({
    destinationDir: appLogsDestinationDir,
    appInfo: {
      appVersion: '1.0.0',
      platform: process.platform,
      arch: process.arch,
      execPath: '/Users/alice/Applications/Album to Video.app',
      resourcesPath: 'C:\\Users\\Alice\\AppData\\Roaming\\Album-to-Video\\resources',
    },
    engineInfo: {
      GLOBAL_FPS: 1,
      binaries: {
        FFMPEG_SOURCE: 'vendored',
        FFMPEG_PATH: '/Users/alice/bin/ffmpeg',
      },
    },
    sessionLogPath,
    renderReportPath: path.join(appLogsDestinationDir, 'render-report.json'),
    maxLogEvents: 200,
  });
  assertOk(
    fs.existsSync(resultNoExportFolder.diagnosticsPath),
    'Diagnostics test: diagnostics.json was not created for no-exportFolder destination.'
  );

  const diagnostics = JSON.parse(fs.readFileSync(result.diagnosticsPath, 'utf8'));
  assertOk(typeof diagnostics === 'object' && diagnostics !== null, 'Diagnostics test: invalid diagnostics JSON.');
  assertOk(Boolean(diagnostics.app), 'Diagnostics test: missing app key.');
  assertOk(Boolean(diagnostics.engine), 'Diagnostics test: missing engine key.');
  assertOk(Boolean(diagnostics.logs), 'Diagnostics test: missing logs key.');
  assertOk(Array.isArray(diagnostics.logs.events), 'Diagnostics test: logs.events must be an array.');
  assertOk(diagnostics.logs.events.length === 200, `Diagnostics test: expected 200 tail events, got ${diagnostics.logs.events.length}.`);
  assertOk(diagnostics.logs.truncated === true, 'Diagnostics test: expected truncated=true for >200 input events.');

  const serialized = JSON.stringify(diagnostics);
  assertOk(!serialized.includes('/Users/alice/'), 'Diagnostics test: expected /Users path redaction.');
  assertOk(!serialized.includes('C:\\\\Users\\\\Alice\\\\'), 'Diagnostics test: expected C:\\Users redaction.');
  assertOk(serialized.includes('/Users/{USER}/'), 'Diagnostics test: expected redacted /Users/{USER}/ marker.');
  assertOk(serialized.includes('C:\\\\Users\\\\{USER}\\\\'), 'Diagnostics test: expected redacted C:\\Users\\{USER}\\ marker.');
  assertOk(serialized.includes('/Volumes/{VOLUME}/'), 'Diagnostics test: expected redacted /Volumes/{VOLUME}/ marker.');

  // Limit behavior for render report payload size.
  const bigRenderDir = path.join(root, 'Big', 'Logs');
  const bigRenderPath = path.join(bigRenderDir, 'render-report.json');
  fs.mkdirSync(bigRenderDir, { recursive: true });
  fs.writeFileSync(bigRenderPath, 'x'.repeat(MAX_RENDER_REPORT_BYTES + 1), 'utf8');

  const bigResult = await exportDiagnosticsBundle({
    destinationDir: bigRenderDir,
    appInfo: { appVersion: '1.0.0' },
    engineInfo: { GLOBAL_FPS: 1 },
    sessionLogPath,
    renderReportPath: bigRenderPath,
  });
  const bigDiagnostics = JSON.parse(fs.readFileSync(bigResult.diagnosticsPath, 'utf8'));
  const oversized = bigDiagnostics?.render || {};
  assertOk(
    oversized.included === false && oversized.reason === 'too_large',
    'Diagnostics test: expected oversized render report to be skipped with included=false and reason=too_large.'
  );

  console.log('OK: diagnostics export writes bundle with keys and redacted paths');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
