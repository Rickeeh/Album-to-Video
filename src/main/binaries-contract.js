const BINARY_CONTRACT_VERSION = 1;

const BINARY_CONTRACT = Object.freeze({
  'darwin-arm64': Object.freeze({
    ffmpeg: Object.freeze({
      relPath: 'darwin-arm64/ffmpeg',
      sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
      repoSha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
      runtimeSha256: '778d9f5486ef929193c3627758bc4b7e896496713e930bc9120a0bd7969e2a59',
      required: true,
    }),
    ffprobe: Object.freeze({
      relPath: 'darwin-arm64/ffprobe',
      sha256: 'c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff',
      repoSha256: 'c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff',
      runtimeSha256: 'e10aae0a80ccdbfed9f68d22cc3ddd4040d7c643da846f06a2aa513609af377d',
      required: true,
    }),
  }),
  'darwin-x64': Object.freeze({
    ffmpeg: Object.freeze({
      relPath: 'darwin-x64/ffmpeg',
      sha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
      repoSha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
      runtimeSha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
      required: true,
    }),
    ffprobe: Object.freeze({
      relPath: 'darwin-x64/ffprobe',
      sha256: '424ce5e9271085240e90bd27f9e3f0ce280d388ea4379a211f76b64fcc07ce33',
      repoSha256: '424ce5e9271085240e90bd27f9e3f0ce280d388ea4379a211f76b64fcc07ce33',
      runtimeSha256: '424ce5e9271085240e90bd27f9e3f0ce280d388ea4379a211f76b64fcc07ce33',
      required: true,
    }),
  }),
  'win32-x64': Object.freeze({
    ffmpeg: Object.freeze({
      relPath: 'win32/ffmpeg.exe',
      sha256: '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d',
      repoSha256: '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d',
      runtimeSha256: '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d',
      required: true,
    }),
    ffprobe: Object.freeze({
      relPath: 'win32/ffprobe.exe',
      sha256: '192a1d6899059765ac8c39764fc3148d4e6049955956dc2029f81f4bd6a8972d',
      repoSha256: '192a1d6899059765ac8c39764fc3148d4e6049955956dc2029f81f4bd6a8972d',
      runtimeSha256: '192a1d6899059765ac8c39764fc3148d4e6049955956dc2029f81f4bd6a8972d',
      required: true,
    }),
  }),
});

function getBinaryContractKey(platform = process.platform, arch = process.arch) {
  return `${String(platform)}-${String(arch)}`;
}

function getBinaryContractTarget(platform = process.platform, arch = process.arch) {
  return BINARY_CONTRACT[getBinaryContractKey(platform, arch)] || null;
}

function listBinaryContractKeys() {
  return Object.keys(BINARY_CONTRACT).sort();
}

function getExpectedHashMapForTarget(platform = process.platform, arch = process.arch) {
  const target = getBinaryContractTarget(platform, arch);
  if (!target) return null;

  const out = {};
  if (target.ffmpeg?.runtimeSha256 || target.ffmpeg?.sha256) {
    out.ffmpeg = target.ffmpeg.runtimeSha256 || target.ffmpeg.sha256;
  }
  if (target.ffprobe?.runtimeSha256 || target.ffprobe?.sha256) {
    out.ffprobe = target.ffprobe.runtimeSha256 || target.ffprobe.sha256;
  }
  return out;
}

module.exports = {
  BINARY_CONTRACT_VERSION,
  BINARY_CONTRACT,
  getBinaryContractKey,
  getBinaryContractTarget,
  listBinaryContractKeys,
  getExpectedHashMapForTarget,
};
