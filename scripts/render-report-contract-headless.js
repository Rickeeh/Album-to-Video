#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

function fail(message) {
  const err = new Error(message);
  err.code = "RENDER_REPORT_CONTRACT_FAILED";
  throw err;
}

function extractObjectLiteral(source, marker) {
  const markerIdx = source.indexOf(marker);
  if (markerIdx < 0) return null;
  const openIdx = source.indexOf("{", markerIdx + marker.length);
  if (openIdx < 0) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIdx, i + 1);
      }
    }
  }

  return null;
}

function loadTrackReportBuilder(mainSourcePath) {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const marker = "const trackReport =";
  const objectLiteral = extractObjectLiteral(source, marker);
  if (!objectLiteral) {
    fail("render-report contract: failed to extract trackReport object literal from main.js");
  }

  const script = `
function buildTrackReport({ audioPath, trackPlan, outputFinalPath, partialPath, initialModelInfo }) {
  return ${objectLiteral};
}
module.exports = { buildTrackReport };
`;

  const context = {
    module: { exports: {} },
    exports: {},
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "main-track-report-contract.vm.js" });

  const fn = context.module?.exports?.buildTrackReport;
  if (typeof fn !== "function") {
    fail("render-report contract: extracted trackReport builder is not callable");
  }
  return fn;
}

function buildHeadlessContractReport(mainSourcePath) {
  const buildTrackReport = loadTrackReportBuilder(mainSourcePath);
  const syntheticTracks = [
    {
      audioPath: "/tmp/input-aac.m4a",
      trackPlan: {
        durationSec: 300,
        probeCodecName: "aac",
        ffmpegArgsBase: ["-i", "/tmp/input-aac.m4a"],
        audioMode: "copy",
      },
      outputFinalPath: "/tmp/out-aac.mp4",
      partialPath: "/tmp/out-aac.mp4.partial",
      initialModelInfo: { progressModel: "MEDIA" },
    },
    {
      audioPath: "/tmp/input-unknown.wav",
      trackPlan: {
        durationSec: 120,
        probeCodecName: null,
        ffmpegArgsBase: ["-i", "/tmp/input-unknown.wav"],
        audioMode: "aac",
      },
      outputFinalPath: "/tmp/out-unknown.mp4",
      partialPath: "/tmp/out-unknown.mp4.partial",
      initialModelInfo: { progressModel: "WALLCLOCK" },
    },
  ];

  const tracks = syntheticTracks.map((entry) => buildTrackReport(entry));
  return {
    schemaFamily: "renderReport",
    schemaVersion: 1,
    tracks,
  };
}

function validateProbeCodecNameContract(report) {
  const tracks = Array.isArray(report?.tracks) ? report.tracks : [];
  if (!tracks.length) {
    fail("render-report contract: expected at least one track in report");
  }

  tracks.forEach((track, idx) => {
    if (!Object.prototype.hasOwnProperty.call(track || {}, "probeCodecName")) {
      fail(`render-report contract: track ${idx} missing probeCodecName key`);
    }
    const value = track ? track.probeCodecName : undefined;
    const valueType = typeof value;
    if (!(value === null || valueType === "string")) {
      fail(`render-report contract: track ${idx} probeCodecName must be string|null`);
    }
  });
}

function runHeadlessRenderReportContract({ projectRoot = path.resolve(__dirname, ".."), outPath = null } = {}) {
  const mainSourcePath = path.join(projectRoot, "main.js");
  const report = buildHeadlessContractReport(mainSourcePath);
  validateProbeCodecNameContract(report);

  const targetPath = outPath
    ? path.resolve(outPath)
    : path.join(os.tmpdir(), `render-report-contract-${process.pid}-${Date.now()}.json`);

  fs.writeFileSync(targetPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  validateProbeCodecNameContract(parsed);

  return {
    reportPath: targetPath,
    trackCount: parsed.tracks.length,
  };
}

if (require.main === module) {
  try {
    const result = runHeadlessRenderReportContract();
    console.log("OK: render-report probeCodecName contract is provable in headless mode");
    console.log(`OK: artifact ${result.reportPath}`);
  } catch (err) {
    console.error(err?.stack || String(err));
    process.exit(1);
  }
}

module.exports = {
  extractObjectLiteral,
  loadTrackReportBuilder,
  buildHeadlessContractReport,
  validateProbeCodecNameContract,
  runHeadlessRenderReportContract,
};
