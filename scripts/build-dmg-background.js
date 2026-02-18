const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'build-resources', 'dmg-background.png');
const MARK_PNG = path.join(ROOT, 'assets', 'icons', 'png', 'icon-512.png');
const WORDMARK_SVG = path.join(ROOT, 'assets', 'brand', 'frender-wordmark.svg');

const WIDTH = 720;
const HEIGHT = 450;

const ICON_APP_X = 189;
const ICON_APPS_X = 469;
const ICON_Y = 229;
const MID_X = Math.round((ICON_APP_X + ICON_APPS_X) / 2);

function buildBaseSvg() {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <radialGradient id="bg" cx="0.30" cy="0.22" r="0.92">
        <stop offset="0%" stop-color="#0e1f3a"/>
        <stop offset="60%" stop-color="#080d18"/>
        <stop offset="100%" stop-color="#060a14"/>
      </radialGradient>
      <radialGradient id="ambientCenter" cx="0.50" cy="0.56" r="0.52">
        <stop offset="0%" stop-color="#1b4f9d" stop-opacity="0.12"/>
        <stop offset="74%" stop-color="#0c2549" stop-opacity="0.03"/>
        <stop offset="100%" stop-color="#0b1d39" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="brandHaze" cx="0.13" cy="0.16" r="0.30">
        <stop offset="0%" stop-color="#1a3b6f" stop-opacity="0.10"/>
        <stop offset="70%" stop-color="#12305a" stop-opacity="0.02"/>
        <stop offset="100%" stop-color="#0d2245" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="installHalo" cx="0.49" cy="0.54" r="0.38">
        <stop offset="0%" stop-color="#2a5ca8" stop-opacity="0.08"/>
        <stop offset="70%" stop-color="#1a427f" stop-opacity="0.02"/>
        <stop offset="100%" stop-color="#11305e" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="arrowStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#bad4ff" stop-opacity="0.48"/>
        <stop offset="50%" stop-color="#e1ecff" stop-opacity="0.66"/>
        <stop offset="100%" stop-color="#bad4ff" stop-opacity="0.48"/>
      </linearGradient>
    </defs>

    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#ambientCenter)"/>
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#brandHaze)"/>

    <ellipse cx="356" cy="245" rx="250" ry="132" fill="url(#installHalo)"/>

    <g opacity="0.014" stroke="#6ea9ff" fill="none">
      <circle cx="76" cy="68" r="56" stroke-width="1.1"/>
      <circle cx="76" cy="68" r="80" stroke-width="0.9"/>
      <circle cx="76" cy="68" r="104" stroke-width="0.7"/>
    </g>

    <g opacity="0.64" stroke="url(#arrowStroke)" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M ${MID_X - 24} ${ICON_Y} L ${MID_X + 24} ${ICON_Y}" stroke-width="4"/>
      <path d="M ${MID_X + 24} ${ICON_Y} L ${MID_X + 13} ${ICON_Y - 9}" stroke-width="4"/>
      <path d="M ${MID_X + 24} ${ICON_Y} L ${MID_X + 13} ${ICON_Y + 9}" stroke-width="4"/>
    </g>
  </svg>`;
}

function buildNoiseOverlay(width, height, alphaMax = 2) {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  let seed = 2463534242;

  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967295;
  };

  for (let i = 0; i < data.length; i += 4) {
    const value = 120 + Math.floor(rnd() * 24);
    const alpha = Math.floor(rnd() * (alphaMax + 1));
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = alpha;
  }

  return { data, info: { width, height, channels } };
}

async function main() {
  if (!fs.existsSync(WORDMARK_SVG) || !fs.existsSync(MARK_PNG)) {
    throw new Error(`Missing brand assets: ${WORDMARK_SVG} or ${MARK_PNG}`);
  }

  const base = await sharp(Buffer.from(buildBaseSvg()))
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const mark = await sharp(MARK_PNG)
    .resize({ width: 44, height: 44 })
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const wordmark = await sharp(WORDMARK_SVG)
    .resize({ width: 94 })
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const wordMeta = await sharp(wordmark).metadata();
  const brandX = 18;
  const brandY = 20;
  const markSize = 44;
  const wordY = brandY + Math.floor((markSize - (wordMeta.height || 24)) / 2);

  const noise = buildNoiseOverlay(WIDTH, HEIGHT, 2);

  await sharp(base)
    .composite([
      { input: mark, left: brandX, top: brandY, blend: 'over', opacity: 0.95 },
      { input: wordmark, left: brandX + markSize + 8, top: wordY, blend: 'over', opacity: 0.93 },
      { input: noise.data, raw: noise.info, blend: 'overlay', opacity: 0.16 },
    ])
    .flatten({ background: '#060a14' })
    .removeAlpha()
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(OUT_PATH);

  console.log(`DMG background generated: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
