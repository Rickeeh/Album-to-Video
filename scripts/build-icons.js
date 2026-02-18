const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const ROOT = path.resolve(__dirname, '..');
const SRC_MARK = path.join(ROOT, 'assets', 'brand', 'frender-mark.svg');
const ICONS_DIR = path.join(ROOT, 'assets', 'icons');
const PNG_DIR = path.join(ICONS_DIR, 'png');
const LEGACY_ICONSET_DIR = path.join(ICONS_DIR, 'icon.iconset');
const BUILD_RESOURCES_DIR = path.join(ROOT, 'build-resources');

const PNG_SIZES = [16, 32, 64, 128, 256, 512, 1024];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

async function writePng(size) {
  const outPath = path.join(PNG_DIR, `icon-${size}.png`);
  const buffer = await sharp(SRC_MARK)
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function buildIcns(masterPng) {
  const output = png2icons.createICNS(masterPng, png2icons.BILINEAR, 0);
  if (!output) throw new Error('Unable to generate ICNS output.');
  const icnsPath = path.join(ICONS_DIR, 'icon.icns');
  fs.writeFileSync(icnsPath, output);
  fs.copyFileSync(icnsPath, path.join(BUILD_RESOURCES_DIR, 'icon.icns'));
}

function buildIco(masterPng) {
  const icoBuffer = png2icons.createICO(masterPng, png2icons.BICUBIC2, 0, false, true);
  if (!icoBuffer) throw new Error('Unable to generate ICO output.');
  const icoPath = path.join(ICONS_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  fs.copyFileSync(icoPath, path.join(BUILD_RESOURCES_DIR, 'icon.ico'));
}

async function main() {
  if (!fs.existsSync(SRC_MARK)) {
    throw new Error(`Missing SVG source: ${SRC_MARK}`);
  }

  ensureDir(ICONS_DIR);
  ensureDir(BUILD_RESOURCES_DIR);
  cleanDir(PNG_DIR);
  fs.rmSync(LEGACY_ICONSET_DIR, { recursive: true, force: true });

  for (const size of PNG_SIZES) {
    await writePng(size);
  }

  const masterPng = fs.readFileSync(path.join(PNG_DIR, 'icon-1024.png'));
  buildIcns(masterPng);
  buildIco(masterPng);

  console.log('Icon pipeline complete.');
  console.log(`Source: ${SRC_MARK}`);
  console.log(`PNG dir: ${PNG_DIR}`);
  console.log(`ICNS: ${path.join(BUILD_RESOURCES_DIR, 'icon.icns')}`);
  console.log(`ICO: ${path.join(BUILD_RESOURCES_DIR, 'icon.ico')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
