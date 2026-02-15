const {
  BINARY_CONTRACT_VERSION,
  BINARY_CONTRACT,
  getBinaryContractTarget,
} = require('../../src/main/binaries-contract');
const verifyWin = require('../../scripts/verify-win-binaries');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function assertSha256Hex(value, label) {
  assertOk(typeof value === 'string', `Contract test: ${label} must be a string.`);
  assertOk(/^[a-f0-9]{64}$/.test(value), `Contract test: ${label} must be 64-char lowercase sha256.`);
}

(function run() {
  assertOk(Number.isInteger(BINARY_CONTRACT_VERSION) && BINARY_CONTRACT_VERSION >= 1, 'Contract test: invalid contract version.');

  const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
  targets.forEach((key) => {
    const [platform, arch] = key.split('-');
    const target = getBinaryContractTarget(platform, arch);
    assertOk(Boolean(target), `Contract test: missing target ${key}.`);
    assertOk(Boolean(target.ffmpeg), `Contract test: missing ffmpeg entry for ${key}.`);
    assertOk(Boolean(target.ffprobe), `Contract test: missing ffprobe entry for ${key}.`);
    assertSha256Hex(target.ffmpeg.sha256, `${key}.ffmpeg.sha256`);
    assertSha256Hex(target.ffprobe.sha256, `${key}.ffprobe.sha256`);
    assertSha256Hex(
      target.ffmpeg.runtimeSha256 || target.ffmpeg.sha256,
      `${key}.ffmpeg.runtimeSha256`
    );
    assertSha256Hex(
      target.ffprobe.runtimeSha256 || target.ffprobe.sha256,
      `${key}.ffprobe.runtimeSha256`
    );
  });

  const winTarget = getBinaryContractTarget('win32', 'x64');
  assertOk(Boolean(winTarget), 'Contract test: missing win32-x64 target.');
  assertOk(
    verifyWin.expectedSha256['ffmpeg.exe'] === winTarget.ffmpeg.sha256,
    'Contract test: verify-win expected ffmpeg hash must match contract.'
  );
  assertOk(
    verifyWin.expectedSha256['ffprobe.exe'] === winTarget.ffprobe.sha256,
    'Contract test: verify-win expected ffprobe hash must match contract.'
  );

  assertOk(typeof BINARY_CONTRACT === 'object' && BINARY_CONTRACT !== null, 'Contract test: contract object missing.');

  console.log('OK: binary contract targets and hashes are pinned and consistent');
})();
