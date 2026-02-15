const BIN_INTEGRITY_BYPASS_ENV = 'ALBUMTOVIDEO_ALLOW_BIN_MISMATCH';

function isBinaryIntegrityBypassEnabled(env = process.env) {
  return String(env?.[BIN_INTEGRITY_BYPASS_ENV] || '').trim() === '1';
}

function decideBinaryIntegrityFailureAction({
  isPackaged,
  strictPackaged = isPackaged,
  env = process.env,
} = {}) {
  const packaged = Boolean(isPackaged);
  const strict = Boolean(strictPackaged);
  const bypassEnabled = isBinaryIntegrityBypassEnabled(env);

  if (packaged && strict && bypassEnabled) {
    return {
      action: 'BYPASS',
      diagnosticsOnly: true,
      bypassEnabled,
    };
  }

  return {
    action: 'THROW',
    diagnosticsOnly: false,
    bypassEnabled,
  };
}

function isDiagnosticsOnlyIntegrityMode(snapshot) {
  return Boolean(snapshot?.isPackaged) && Boolean(snapshot?.bypassUsed);
}

module.exports = {
  BIN_INTEGRITY_BYPASS_ENV,
  isBinaryIntegrityBypassEnabled,
  decideBinaryIntegrityFailureAction,
  isDiagnosticsOnlyIntegrityMode,
};
