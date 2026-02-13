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
  record(
    distWinScript.includes('verify:win-bins'),
    'PASS package.json: dist:win is gated by verify:win-bins',
    'FAIL package.json: dist:win must run verify:win-bins before electron-builder'
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
      expected: [/buildRenderPlan\s*\(\s*payload\s*\)/],
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
