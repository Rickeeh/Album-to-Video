const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const projectRoot = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
const start = mainSource.indexOf('const MP4_COPY_COMPATIBLE_AUDIO_CODECS');
const end = mainSource.indexOf('function uniqueOutputPath', start);

if (start < 0 || end < 0 || end <= start) {
  fail('MP4 copy policy test: failed to extract isMp4CopyCompatible from main.js.');
}

const snippet = mainSource.slice(start, end);
const script = `${snippet}\nmodule.exports = { isMp4CopyCompatible };`;
const context = {
  module: { exports: {} },
  exports: {},
  String,
  Set,
};
vm.createContext(context);
vm.runInContext(script, context, { filename: 'main-mp4-copy-policy.vm.js' });

const { isMp4CopyCompatible } = context.module.exports;
if (typeof isMp4CopyCompatible !== 'function') {
  fail('MP4 copy policy test: isMp4CopyCompatible is not a function.');
}

['aac', 'alac', 'mp3', 'ac3', 'eac3', 'mp2'].forEach((codec) => {
  assert.strictEqual(
    isMp4CopyCompatible(codec),
    true,
    `MP4 copy policy test: expected codec "${codec}" to be copy-compatible.`
  );
});

['flac', 'vorbis', 'opus', 'pcm_s16le', 'pcm_f32le', 'wavpack'].forEach((codec) => {
  assert.strictEqual(
    isMp4CopyCompatible(codec),
    false,
    `MP4 copy policy test: expected codec "${codec}" to be NOT copy-compatible.`
  );
});

assert.strictEqual(isMp4CopyCompatible(null), false, 'MP4 copy policy test: expected null => false.');
assert.strictEqual(isMp4CopyCompatible(undefined), false, 'MP4 copy policy test: expected undefined => false.');
assert.strictEqual(isMp4CopyCompatible(''), false, 'MP4 copy policy test: expected empty string => false.');

console.log('OK: MP4 copy compatibility policy remains strict and deterministic');
