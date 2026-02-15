const fs = require('fs');
const path = require('path');
const {
  BIN_INTEGRITY_BYPASS_ENV,
  isBinaryIntegrityBypassEnabled,
  decideBinaryIntegrityFailureAction,
  isDiagnosticsOnlyIntegrityMode,
} = require('../../src/main/binary-integrity-airbag');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

(function run() {
  const off = decideBinaryIntegrityFailureAction({
    isPackaged: true,
    strictPackaged: true,
    env: { [BIN_INTEGRITY_BYPASS_ENV]: '0' },
  });
  assertOk(off.action === 'THROW', 'Airbag test: packaged mismatch without bypass must hard-fail (THROW).');

  const on = decideBinaryIntegrityFailureAction({
    isPackaged: true,
    strictPackaged: true,
    env: { [BIN_INTEGRITY_BYPASS_ENV]: '1' },
  });
  assertOk(on.action === 'BYPASS', 'Airbag test: packaged mismatch with bypass must enter BYPASS mode.');
  assertOk(on.diagnosticsOnly === true, 'Airbag test: bypass mode must be diagnostics-only.');

  assertOk(
    isBinaryIntegrityBypassEnabled({ [BIN_INTEGRITY_BYPASS_ENV]: '1' }) === true,
    'Airbag test: bypass env parser should accept only value 1.'
  );
  assertOk(
    isBinaryIntegrityBypassEnabled({ [BIN_INTEGRITY_BYPASS_ENV]: 'true' }) === false,
    'Airbag test: bypass env parser must reject non-1 values.'
  );

  assertOk(
    isDiagnosticsOnlyIntegrityMode({ isPackaged: true, bypassUsed: true }) === true,
    'Airbag test: diagnostics-only mode should be true only when packaged+bypassUsed.'
  );
  assertOk(
    isDiagnosticsOnlyIntegrityMode({ isPackaged: true, bypassUsed: false }) === false,
    'Airbag test: diagnostics-only mode should be false when bypass not used.'
  );

  const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assertOk(
    mainSource.includes('bin.integrity.bypassed')
      && mainSource.includes('Integrity bypass active (diagnostics mode)'),
    'Airbag test: expected explicit bypass logs + startup alert text in main.js.'
  );
  assertOk(
    mainSource.includes('BIN_INTEGRITY_BYPASS')
      && mainSource.includes('Rendering disabled.'),
    'Airbag test: expected render-block error path for diagnostics-only bypass mode.'
  );

  console.log('OK: packaged integrity airbag is explicit, diagnostics-only, and non-silent');
})();
