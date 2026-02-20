const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readText(relPath) {
  const fullPath = path.join(rootDir, relPath);
  return fs.readFileSync(fullPath, 'utf8');
}

function fileExists(relPath) {
  try {
    return fs.statSync(path.join(rootDir, relPath)).isFile();
  } catch {
    return false;
  }
}

function extractHandlerBlock(mainSource, name) {
  const marker = `registerIpcHandler('${name}'`;
  const start = mainSource.indexOf(marker);
  if (start < 0) return null;
  const next = mainSource.indexOf("registerIpcHandler('", start + marker.length);
  return next >= 0 ? mainSource.slice(start, next) : mainSource.slice(start);
}

function extractFunctionBlock(source, functionName) {
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const next = source.indexOf('\nfunction ', start + marker.length);
  return next >= 0 ? source.slice(start, next) : source.slice(start);
}

function has(pattern, text) {
  return pattern.test(text);
}

function main() {
  const errors = [];
  const passes = [];

  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const preloadSource = readText('preload.js');
  const mainSource = readText('main.js');
  const diagnosticsSource = readText('src/main/diagnostics.js');
  const jobLedgerSource = readText('src/main/job-ledger.js');

  const record = (ok, passMsg, failMsg) => {
    if (ok) passes.push(passMsg);
    else errors.push(failMsg);
  };

  // A) preload: no generic invoke
  const hasGenericInvoke =
    has(/\binvoke\s*:\s*\(\s*name\b/, preloadSource)
    || has(/\bapi\.invoke\b/, preloadSource);
  record(
    !hasGenericInvoke,
    'PASS preload: no generic invoke exposed',
    'FAIL preload: generic invoke API found (remove api.invoke / invoke(name, payload))'
  );

  // B) product policy: GLOBAL_FPS must be 1
  const fpsMatch = mainSource.match(/\bconst\s+GLOBAL_FPS\s*=\s*(\d+)\s*;/);
  const fpsValue = fpsMatch ? Number(fpsMatch[1]) : null;
  record(
    fpsValue === 1,
    'PASS main: GLOBAL_FPS is locked to 1',
    `FAIL main: GLOBAL_FPS must be 1 (found ${fpsValue === null ? 'missing' : fpsValue})`
  );

  // C) package scripts: dist:win must include verify:win-bins
  const distWinScript = String(packageJson?.scripts?.['dist:win'] || '');
  const distMacScript = String(packageJson?.scripts?.['dist:mac'] || '');
  const distMacArm64Script = String(packageJson?.scripts?.['dist:mac:arm64'] || '');
  const distMacX64Script = String(packageJson?.scripts?.['dist:mac:x64'] || '');
  record(
    distWinScript.includes('verify:win-bins'),
    'PASS package.json: dist:win is gated by verify:win-bins',
    'FAIL package.json: dist:win must run verify:win-bins before electron-builder'
  );
  record(
    distWinScript.includes('verify:packaged-bins'),
    'PASS package.json: dist:win verifies packaged binary contract',
    'FAIL package.json: dist:win must run verify:packaged-bins after build'
  );
  record(
    distWinScript.includes('verify:win-artifacts'),
    'PASS package.json: dist:win verifies updater metadata + artifact uniqueness',
    'FAIL package.json: dist:win must run verify:win-artifacts after build'
  );
  record(
    distMacArm64Script.includes('verify:packaged-bins'),
    'PASS package.json: dist:mac:arm64 verifies packaged binary contract',
    'FAIL package.json: dist:mac:arm64 must run verify:packaged-bins after build'
  );
  record(
    distMacX64Script.includes('verify:packaged-bins'),
    'PASS package.json: dist:mac:x64 verifies packaged binary contract',
    'FAIL package.json: dist:mac:x64 must run verify:packaged-bins after build'
  );
  record(
    distMacScript.includes('dist:mac:arm64') && distMacScript.includes('dist:mac:x64'),
    'PASS package.json: dist:mac orchestrates arm64 + x64 builds',
    'FAIL package.json: dist:mac must run dist:mac:arm64 and dist:mac:x64'
  );

  // D) vendored Windows binaries existence (if Windows build is configured)
  const windowsBuildConfigured = Boolean(packageJson?.scripts?.['dist:win'] || packageJson?.build?.win);
  if (windowsBuildConfigured) {
    const requiredBins = [
      'resources/bin/win32/ffmpeg.exe',
      'resources/bin/win32/ffprobe.exe',
    ];
    requiredBins.forEach((relPath) => {
      record(
        fileExists(relPath),
        `PASS windows bins: found ${relPath}`,
        `FAIL windows bins: missing ${relPath}`
      );
    });
  }

  // D2) binary contract source of truth must exist
  record(
    fileExists('src/main/binaries-contract.js'),
    'PASS contract: src/main/binaries-contract.js exists',
    'FAIL contract: missing src/main/binaries-contract.js'
  );
  record(
    fileExists('src/main/job-ledger.js'),
    'PASS contract: src/main/job-ledger.js exists',
    'FAIL contract: missing src/main/job-ledger.js'
  );
  record(
    has(/schemaFamily:\s*RENDER_REPORT_SCHEMA_FAMILY/, mainSource)
      && has(/schemaVersion:\s*RENDER_REPORT_SCHEMA_VERSION/, mainSource),
    'PASS main: render-report schemaFamily/schemaVersion stamping is present',
    'FAIL main: render-report must stamp schemaFamily/schemaVersion'
  );
  record(
    has(/DIAGNOSTICS_SCHEMA_VERSION/, diagnosticsSource)
      && has(/DIAGNOSTICS_SCHEMA_FAMILY/, diagnosticsSource)
      && has(/readDiagnosticsBundle\s*\(/, diagnosticsSource),
    'PASS diagnostics: schema versioning/read contract is present',
    'FAIL diagnostics: missing schema versioning/read contract'
  );
  record(
    has(/JOB_LEDGER_SCHEMA_VERSION/, jobLedgerSource)
      && has(/schema\.missing/, jobLedgerSource)
      && has(/schema\.unsupported/, jobLedgerSource),
    'PASS job-ledger: schema versioning + fail-safe schema logs are present',
    'FAIL job-ledger: missing schema versioning fail-safe guards'
  );
  record(
    has(/const\s+PUBLIC_APP_VERSION\s*=\s*'1\.0\.0'/, mainSource),
    'PASS main: PUBLIC_APP_VERSION is pinned to 1.0.0 for clean user-visible versioning',
    'FAIL main: expected PUBLIC_APP_VERSION to be pinned to 1.0.0'
  );
  record(
    has(/commitSha:\s*BUILD_IDENTITY\.commitSha/, mainSource)
      && has(/branch:\s*BUILD_IDENTITY\.branch/, mainSource)
      && has(/tag:\s*BUILD_IDENTITY\.tag/, mainSource),
    'PASS main: diagnostics/build logs include commit/branch/tag identity fields',
    'FAIL main: expected build identity fields (commitSha/branch/tag) in diagnostics/log payloads'
  );

  // E) path hardening helpers must exist
  const helperChecks = [
    { name: 'assertAbsolutePath', re: /function\s+assertAbsolutePath\s*\(/ },
    { name: 'resolveExistingDirectoryPath', re: /function\s+resolveExistingDirectoryPath\s*\(/ },
    { name: 'resolveExistingReadableFilePath', re: /function\s+resolveExistingReadableFilePath\s*\(/ },
    { name: 'isPathWithinBase', re: /function\s+isPathWithinBase\s*\(/ },
    { name: 'assertPathWithinBase', re: /function\s+assertPathWithinBase\s*\(/ },
  ];
  helperChecks.forEach(({ name, re }) => {
    record(
      has(re, mainSource),
      `PASS main: helper ${name} is present`,
      `FAIL main: helper ${name} is missing`
    );
  });

  record(
    has(/function\s+safeSendToRenderer\s*\(/, mainSource)
      && has(/safeSendToRenderer\(sender,\s*'render-status',\s*payload\)/, mainSource)
      && has(/safeSendToRenderer\(sender,\s*'render-progress',\s*payload\)/, mainSource),
    'PASS main: renderer IPC sends guard destroyed sender state',
    'FAIL main: render-status/render-progress sends must guard sender destroyed state'
  );
  record(
    has(/setWindowOpenHandler\s*\(/, mainSource)
      && has(/security\.window_open_blocked/, mainSource)
      && has(/on\('will-navigate'/, mainSource)
      && has(/security\.navigation_blocked/, mainSource),
    'PASS main: window.open and navigation are hard-blocked',
    'FAIL main: missing window.open/will-navigate hard-block guards'
  );
  record(
    has(/function\s+assertOutputPathNotExists\s*\(/, mainSource)
      && has(/assertOutputPathNotExists\(outputFinalPath\)/, mainSource),
    'PASS main: output finalize path has explicit no-overwrite guard',
    'FAIL main: finalize move must assert output path does not already exist'
  );
  record(
    has(/finalizing\.rename_outputs/, mainSource)
      && has(/finalizing\.post_rename/, mainSource)
      && has(/finalizing\.pre_success/, mainSource),
    'PASS main: finalizing stage contains cancellation checkpoints',
    'FAIL main: finalizing stage is missing cancellation checkpoints'
  );
  record(
    has(/phase\s*===\s*JOB_PHASES\.FINALIZING/, mainSource)
      && has(/deferredCleanup:\s*true/, mainSource)
      && has(/waitForCurrentJobToSettle/, mainSource),
    'PASS main: FINALIZING cancellation defers cleanup and waits for settle',
    'FAIL main: FINALIZING cancellation must defer cleanup and wait for job settle'
  );
  record(
    has(/WATCHDOG_TIMEOUT/, mainSource)
      && has(/render\.watchdog\.timeout/, mainSource),
    'PASS main: no-progress watchdog timeout guard is present',
    'FAIL main: expected WATCHDOG_TIMEOUT reason code and render.watchdog.timeout log guard'
  );
  record(
    has(/preset\.engine\.video\.invalid/, mainSource)
      && has(/preset\.engine\.video must be a function/, mainSource),
    'PASS main: preset.engine.video guard rejects invalid preset shape',
    'FAIL main: expected strict preset.engine.video function guard with structured logging'
  );
  record(
    has(/normalize\('NFC'\)/, mainSource),
    'PASS main: output base names are NFC-normalized',
    "FAIL main: sanitizeFileBaseName should normalize unicode to NFC"
  );

  // E2) binary integrity runtime guardrails must exist
  record(
    has(/ensureBinaryIntegrityContract\s*\(\s*\{\s*strictPackaged:\s*app\.isPackaged\s*\}\s*\)/, mainSource),
    'PASS main: packaged binary integrity is enforced at runtime',
    'FAIL main: missing ensureBinaryIntegrityContract({ strictPackaged: app.isPackaged }) call'
  );
  record(
    has(/bin\.integrity\.fail/, mainSource),
    'PASS main: structured bin.integrity.fail logging is present',
    'FAIL main: expected structured bin.integrity.fail logging'
  );
  record(
    has(/bin\.integrity\.bypassed/, mainSource)
      && has(/BIN_INTEGRITY_BYPASS_ENV/, mainSource),
    'PASS main: emergency bypass logging + env guard are present',
    'FAIL main: expected BIN_INTEGRITY_BYPASS_ENV bypass guard and bin.integrity.bypassed log'
  );
  record(
    has(/BIN_INTEGRITY_BYPASS/, mainSource)
      && has(/isDiagnosticsOnlyIntegrityMode\s*\(/, mainSource),
    'PASS main: diagnostics-only render block under bypass is present',
    'FAIL main: expected diagnostics-only render block for integrity bypass'
  );
  record(
    has(/startupRecoveryPromise/, mainSource)
      && has(/runStartupJobRecovery\s*\(/, mainSource)
      && has(/await startupRecoveryPromise/, mainSource),
    'PASS main: startup ledger recovery gate is present before render',
    'FAIL main: expected startupRecoveryPromise gate before render'
  );
  record(
    has(/job\.ledger\.created/, mainSource)
      && has(/job\.ledger\.completed/, mainSource)
      && has(/job\.recovery\.detected/, readText('src/main/job-ledger.js'))
      && has(/job\.recovery\.cleaned/, readText('src/main/job-ledger.js')),
    'PASS main: crash-safe ledger lifecycle/recovery logs are present',
    'FAIL main: expected ledger lifecycle/recovery structured logs'
  );
  record(
    has(/if\s*\(\s*!app\.isPackaged\s*\)/, mainSource)
      && has(/require\(['"]ffmpeg-static['"]\)/, mainSource)
      && has(/require\(['"]@ffprobe-installer\/ffprobe['"]\)/, mainSource),
    'PASS main: dependency fallback for ffmpeg/ffprobe is dev-only',
    'FAIL main: dependency fallback for ffmpeg/ffprobe must be guarded by !app.isPackaged'
  );

  // F) critical handlers must use hardened path resolution
  const handlerChecks = [
    {
      name: 'open-folder',
      expected: [
        /resolveExistingDirectoryPath\s*\(/,
        /shell\.openPath\s*\(/,
      ],
    },
    {
      name: 'ensure-dir',
      expected: [
        /lastSelectedExportFolder/,
        /resolveExistingDirectoryPath\s*\(/,
        /sanitizeAlbumFolderName\s*\(/,
        /assertPathWithinBase\s*\(/,
      ],
    },
    {
      name: 'read-metadata',
      expected: [/resolveExistingReadableFilePath\s*\(/],
    },
    {
      name: 'probe-audio',
      expected: [/resolveExistingReadableFilePath\s*\(/],
    },
    {
      name: 'render-album',
      expected: [
        /currentJob\.phase\s*=\s*JOB_PHASES\.PLANNING/,
        /buildRenderPlan\s*\(\s*payloadObj\s*,\s*\{\s*assertNotCancelled:\s*assertPlanningNotCancelled\s*\}\s*\)/,
      ],
    },
  ];

  handlerChecks.forEach(({ name, expected }) => {
    const block = extractHandlerBlock(mainSource, name);
    record(
      Boolean(block),
      `PASS main: handler ${name} exists`,
      `FAIL main: handler ${name} not found`
    );
    if (!block) return;

    expected.forEach((re) => {
      record(
        has(re, block),
        `PASS main: handler ${name} uses ${re}`,
        `FAIL main: handler ${name} missing expected usage ${re}`
      );
    });
  });

  // render-album hardening lives in buildRenderPlan; verify critical checks there.
  const buildRenderPlanBlock = extractFunctionBlock(mainSource, 'buildRenderPlan');
  record(
    Boolean(buildRenderPlanBlock),
    'PASS main: buildRenderPlan exists',
    'FAIL main: buildRenderPlan function not found'
  );
  if (buildRenderPlanBlock) {
    const expected = [
      /assertAbsolutePath\s*\(\s*exportFolder/,
      /resolveExistingDirectoryPath\s*\(\s*lastSelectedExportFolder/,
      /resolveExistingDirectoryPath\s*\(\s*requestedExportFolder/,
      /assertPathWithinBase\s*\(\s*selectedExportFolder/,
      /ensureWritableDir\s*\(\s*resolvedExportFolder/,
    ];
    expected.forEach((re) => {
      record(
        has(re, buildRenderPlanBlock),
        `PASS main: buildRenderPlan includes ${re}`,
        `FAIL main: buildRenderPlan missing ${re}`
      );
    });
  }

  if (errors.length > 0) {
    console.error('verify-invariants failed.\n');
    errors.forEach((msg, i) => console.error(`${i + 1}. ${msg}`));
    process.exit(1);
  }

  console.log('verify-invariants passed.');
  passes.forEach((msg) => console.log(`- ${msg}`));
}

main();
