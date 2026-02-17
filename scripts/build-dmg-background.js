const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'build-resources', 'dmg-background.png');
const LOCKUP_SVG = path.join(ROOT, 'assets', 'brand', 'frender-lockup.svg');

const WIDTH = 720;
const HEIGHT = 450;

const ICON_APP_X = 189;
const ICON_APPS_X = 469;
const ICON_Y = 235;
const MID_X = Math.round((ICON_APP_X + ICON_APPS_X) / 2);

function buildBaseSvg() {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#060f21"/>
        <stop offset="58%" stop-color="#07162c"/>
        <stop offset="100%" stop-color="#071227"/>
      </linearGradient>
      <radialGradient id="brandGlow" cx="0.12" cy="0.14" r="0.55">
        <stop offset="0%" stop-color="#14315a" stop-opacity="0.12"/>
        <stop offset="55%" stop-color="#0f2850" stop-opacity="0.03"/>
        <stop offset="100%" stop-color="#0a1b38" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="installZone" cx="0.46" cy="0.50" r="0.43">
        <stop offset="0%" stop-color="#123055" stop-opacity="0.10"/>
        <stop offset="76%" stop-color="#0d2443" stop-opacity="0.03"/>
        <stop offset="100%" stop-color="#0b1c37" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="arrowStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#bad4ff" stop-opacity="0.38"/>
        <stop offset="50%" stop-color="#dbe9ff" stop-opacity="0.56"/>
        <stop offset="100%" stop-color="#bad4ff" stop-opacity="0.38"/>
      </linearGradient>
      <filter id="labelBlur" x="-40%" y="-120%" width="180%" height="340%">
        <feGaussianBlur stdDeviation="2"/>
      </filter>
    </defs>

    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#brandGlow)"/>
    <rect x="110" y="128" width="440" height="210" rx="36" fill="url(#installZone)"/>

    <g opacity="0.03" stroke="#4b86d7" fill="none">
      <circle cx="92" cy="78" r="66" stroke-width="1.4"/>
      <circle cx="92" cy="78" r="94" stroke-width="1"/>
      <circle cx="92" cy="78" r="122" stroke-width="0.8"/>
    </g>

    <g opacity="0.53" stroke="url(#arrowStroke)" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M ${MID_X - 24} ${ICON_Y} L ${MID_X + 24} ${ICON_Y}" stroke-width="4"/>
      <path d="M ${MID_X + 24} ${ICON_Y} L ${MID_X + 13} ${ICON_Y - 9}" stroke-width="4"/>
      <path d="M ${MID_X + 24} ${ICON_Y} L ${MID_X + 13} ${ICON_Y + 9}" stroke-width="4"/>
    </g>

    <rect x="${ICON_APP_X - 66}" y="325" width="132" height="21" rx="10.5" fill="#edf5ff" fill-opacity="0.09" filter="url(#labelBlur)"/>
    <rect x="${ICON_APPS_X - 70}" y="325" width="140" height="21" rx="10.5" fill="#edf5ff" fill-opacity="0.09" filter="url(#labelBlur)"/>
  </svg>`;
}

function buildNoiseOverlay(width, height, alphaMax = 3) {
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
  if (!fs.existsSync(LOCKUP_SVG)) {
    throw new Error(`Missing lockup SVG: ${LOCKUP_SVG}`);
  }

  const base = await sharp(Buffer.from(buildBaseSvg()))
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const lockup = await sharp(LOCKUP_SVG)
    .resize({ width: 138 })
    .toColourspace('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  const noise = buildNoiseOverlay(WIDTH, HEIGHT, 3);

  await sharp(base)
    .composite([
      { input: lockup, left: 12, top: 18, blend: 'over', opacity: 0.92 },
      { input: noise.data, raw: noise.info, blend: 'overlay', opacity: 0.24 },
    ])
    .flatten({ background: '#071227' })
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
