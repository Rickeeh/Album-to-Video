const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const { renderOneTrack } = require("../../engine/renderAlbum");
const { cleanupJob } = require("../../src/main/cleanup");

const ffprobePath = require("@ffprobe-installer/ffprobe").path;

const audioFiles = ["test.wav", "test.mp3"];
const imageFiles = ["test.jpg"];

const projectRoot = path.join(__dirname, "..", "..");
const fixturesDir = path.join(projectRoot, "fixtures");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "album-to-video-render-e2e-"));

function assertExists(p) {
  if (!fs.existsSync(p)) {
    console.error("Missing fixture:", p);
    process.exit(1);
  }
}

function assertOk(condition, message) {
  if (condition) return;
  console.error(message);
  process.exit(1);
}

function safeRmdirIfEmpty(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    const removable = new Set([".DS_Store", "Thumbs.db"]);
    entries
      .filter((name) => removable.has(name) || name.startsWith("._"))
      .forEach((name) => {
        try { fs.unlinkSync(path.join(dirPath, name)); } catch {}
      });
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  } catch {}
}

async function runCancelBatchCleanupScenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "album-to-video-cancel-e2e-"));
  const outputFolder = path.join(root, "Release");
  const logsFolder = path.join(outputFolder, "Logs");
  fs.mkdirSync(logsFolder, { recursive: true });

  const plannedFinalOutputs = [
    path.join(outputFolder, "01. Completed.mp4"),
    path.join(outputFolder, "02. InProgress.mp4"),
    path.join(outputFolder, "03. Planned.mp4"),
  ];
  const currentTrackPartialPath = `${plannedFinalOutputs[1]}.partial`;
  const reportPath = path.join(logsFolder, "render-report.json");

  // Simulate: track 1 done, track 2 in-progress, then cancel.
  fs.writeFileSync(plannedFinalOutputs[0], "completed");
  fs.writeFileSync(plannedFinalOutputs[1], "partial");
  fs.writeFileSync(currentTrackPartialPath, "tmp");
  fs.writeFileSync(reportPath, "{}");

  const ctx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => null,
    killProcessTree: () => {},
    killWaitTimeoutMs: 300,
    currentTrackPartialPath,
    partialPaths: new Set([currentTrackPartialPath]),
    currentTrackTmpPath: currentTrackPartialPath,
    tmpPaths: new Set([currentTrackPartialPath]),
    plannedFinalOutputs: new Set(plannedFinalOutputs),
    completedFinalOutputs: new Set([plannedFinalOutputs[0]]),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder,
    createAlbumFolder: true,
    safeRmdirIfEmpty,
    logger: null,
  };

  await cleanupJob("cancel-e2e", "CANCELLED", ctx);

  assertOk(!fs.existsSync(plannedFinalOutputs[0]), "Expected completed output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(plannedFinalOutputs[1]), "Expected in-progress output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(plannedFinalOutputs[2]), "Expected planned output to be absent on CANCELLED.");
  assertOk(!fs.existsSync(currentTrackPartialPath), "Expected partial output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(reportPath), "Expected render-report.json to not exist in export folder on CANCELLED.");
  assertOk(!fs.existsSync(outputFolder), "Expected release folder to be removed on CANCELLED.");

  console.log("OK: cancel batch cleanup removes all planned outputs and created folder");
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const mainSource = fs.readFileSync(path.join(projectRoot, "main.js"), "utf8");
  assertOk(
    mainSource.includes("probeCodecName: trackPlan.probeCodecName ?? null"),
    "Expected track report to include probeCodecName observability field."
  );
  for (const audio of audioFiles) {
    for (const image of imageFiles) {
      const audioPath = path.join(fixturesDir, audio);
      const imagePath = path.join(fixturesDir, image);
      const output = path.join(outDir, `out-${audio}-${image}.mp4`);

      assertExists(audioPath);
      assertExists(imagePath);

      if (fs.existsSync(output)) fs.unlinkSync(output);

      await renderOneTrack({
        audioPath,
        imagePath,
        outputPath: output
      });

      if (!fs.existsSync(output)) {
        console.error("Output video not created:", output);
        process.exit(1);
      }
      const partialOutput = `${output}.partial`;
      if (fs.existsSync(partialOutput)) {
        console.error("Partial output should not remain after success:", partialOutput);
        process.exit(1);
      }

      const probe = spawnSync(
        ffprobePath,
        ["-v", "error", "-show_streams", output],
        { encoding: "utf8" }
      );

      if (!probe.stdout.includes("codec_type=audio")) {
        console.error("No audio stream found in", output);
        process.exit(1);
      }

      if (!probe.stdout.includes("codec_type=video")) {
        console.error("No video stream found in", output);
        process.exit(1);
      }

      console.log(`OK: ${audio} + ${image}`);
    }
  }

  const danglingPartials = fs.readdirSync(outDir).filter((name) => name.endsWith(".partial"));
  assertOk(
    danglingPartials.length === 0,
    `Expected no .partial artifacts after success run (found ${danglingPartials.length}).`
  );

  await runCancelBatchCleanupScenario();

  console.log("E2E render tests completed successfully");
})();
