const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');
const OUT_DIR = path.join(BRAND_DIR, 'test-renders');

const SOURCES = [
  { key: 'mark', file: 'frender-mark.svg' },
  { key: 'mono', file: 'frender-mark-mono.svg' },
];

const SIZES = [16, 32, 64, 128, 256, 512];
const CONTEXTS = [
  { key: 'macos-dock-light', bg: '#ffffff' },
  { key: 'macos-dock-dark', bg: '#1e1e1e' },
  { key: 'windows-taskbar', bg: '#0c0f14' },
];
const HEADER_HEIGHTS = [24, 32];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

async function renderSquarePng(svgPath, size) {
  return sharp(svgPath).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

function countSegmentsFromAlpha(alphaValues, threshold) {
  let segments = 0;
  let inSegment = false;
  for (const value of alphaValues) {
    const active = value >= threshold;
    if (active && !inSegment) {
      segments += 1;
      inSegment = true;
    } else if (!active && inSegment) {
      inSegment = false;
    }
  }
  return segments;
}

function minGapBetweenSegments(alphaValues, threshold) {
  const gaps = [];
  let inSegment = false;
  let currentGap = 0;

  for (const value of alphaValues) {
    const active = value >= threshold;
    if (active) {
      if (!inSegment && currentGap > 0) {
        gaps.push(currentGap);
      }
      inSegment = true;
      currentGap = 0;
    } else if (inSegment) {
      inSegment = false;
      currentGap = 1;
    } else if (currentGap > 0) {
      currentGap += 1;
    }
  }
  return gaps.length ? Math.min(...gaps) : 0;
}

async function analyzeLegibility(pngBuffer) {
  const image = sharp(pngBuffer);
  const { width, height } = await image.metadata();
  const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const y = Math.floor(height / 2);
  const xStart = Math.floor(width * 0.2);
  const xEnd = Math.ceil(width * 0.8);
  const alphaSlice = [];
  let partialAlpha = 0;
  let nonTransparent = 0;

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const idx = (row * width + col) * 4;
      const a = data[idx + 3];
      if (a > 0) nonTransparent += 1;
      if (a > 0 && a < 255) partialAlpha += 1;
    }
  }

  for (let x = xStart; x < xEnd; x += 1) {
    const idx = (y * width + x) * 4;
    alphaSlice.push(data[idx + 3]);
  }

  const segmentCount = countSegmentsFromAlpha(alphaSlice, 160);
  const minGapPx = minGapBetweenSegments(alphaSlice, 160);
  const topCenterAlpha = data[(1 * width + Math.floor(width / 2)) * 4 + 3];
  const antiAliasRatio = nonTransparent ? partialAlpha / nonTransparent : 0;
  let currentSoftRun = 0;
  let maxSoftRun = 0;

  for (const alpha of alphaSlice) {
    if (alpha > 0 && alpha < 255) {
      currentSoftRun += 1;
      if (currentSoftRun > maxSoftRun) maxSoftRun = currentSoftRun;
    } else {
      currentSoftRun = 0;
    }
  }

  return {
    width,
    height,
    segmentCount,
    minGapPx,
    topCenterAlpha,
    antiAliasRatio: Number(antiAliasRatio.toFixed(3)),
    softEdgeMaxRunPx: maxSoftRun,
    passes: {
      barsSeparatedAt16: segmentCount >= 4 && minGapPx >= 1,
      baseShapeVisible: topCenterAlpha > 0,
      antiAliasingReasonable: maxSoftRun <= 8,
    },
  };
}

async function writeRenderMatrix(sourceKey, svgPath) {
  const sourceDir = path.join(OUT_DIR, sourceKey);
  ensureDir(sourceDir);

  const report = { sizes: {}, contexts: [], header: [] };

  for (const size of SIZES) {
    const pngBuffer = await renderSquarePng(svgPath, size);
    fs.writeFileSync(path.join(sourceDir, `${sourceKey}-${size}.png`), pngBuffer);
    if (size === 16) {
      report.sizes[size] = await analyzeLegibility(pngBuffer);
    }
  }

  for (const ctx of CONTEXTS) {
    const canvasSize = 256;
    const iconSize = 112;
    const iconBuffer = await renderSquarePng(svgPath, iconSize);
    const composite = await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 4,
        background: ctx.bg,
      },
    })
      .composite([
        {
          input: iconBuffer,
          left: Math.floor((canvasSize - iconSize) / 2),
          top: Math.floor((canvasSize - iconSize) / 2),
        },
      ])
      .png({ compressionLevel: 9 })
      .toBuffer();

    const filename = `${sourceKey}-${ctx.key}.png`;
    fs.writeFileSync(path.join(sourceDir, filename), composite);
    report.contexts.push({ context: ctx.key, file: filename, background: ctx.bg });
  }

  for (const headerHeight of HEADER_HEIGHTS) {
    const iconBuffer = await renderSquarePng(svgPath, headerHeight);
    const iconBase64 = iconBuffer.toString('base64');
    const headerSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="420" height="72" viewBox="0 0 420 72">
        <rect x="0" y="0" width="420" height="72" fill="#0c0f14" />
        <image x="16" y="${Math.floor((72 - headerHeight) / 2)}" width="${headerHeight}" height="${headerHeight}" href="data:image/png;base64,${iconBase64}" />
        <text x="${16 + headerHeight + 12}" y="45" fill="#f1f5ff" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700">fRender</text>
      </svg>
    `;
    const filename = `${sourceKey}-header-${headerHeight}.png`;
    const output = await sharp(Buffer.from(headerSvg)).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(path.join(sourceDir, filename), output);
    report.header.push({ height: headerHeight, file: filename });
  }

  return report;
}

async function main() {
  cleanDir(OUT_DIR);

  const matrix = {
    generatedAtUtc: new Date().toISOString(),
    sizes: SIZES,
    contexts: CONTEXTS,
    headerHeights: HEADER_HEIGHTS,
    sources: {},
  };

  for (const source of SOURCES) {
    const svgPath = path.join(BRAND_DIR, source.file);
    if (!fs.existsSync(svgPath)) {
      throw new Error(`Missing source SVG: ${svgPath}`);
    }
    matrix.sources[source.key] = await writeRenderMatrix(source.key, svgPath);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'validation-report.json'),
    `${JSON.stringify(matrix, null, 2)}\n`,
    'utf8'
  );

  console.log(`Logo validation renders written to: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
