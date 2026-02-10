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
const outDir = path.join(projectRoot, "test-artifacts", "e2e");

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
  const currentTrackTmpPath = `${plannedFinalOutputs[1]}.tmp.mp4`;
  const reportPath = path.join(logsFolder, "render-report.json");

  // Simulate: track 1 done, track 2 in-progress, then cancel.
  fs.writeFileSync(plannedFinalOutputs[0], "completed");
  fs.writeFileSync(plannedFinalOutputs[1], "partial");
  fs.writeFileSync(currentTrackTmpPath, "tmp");
  fs.writeFileSync(reportPath, "{}");

  const ctx = {
    cleanedUp: false,
    cleanupStats: null,
    cleanupPromise: null,
    getActiveProcess: () => null,
    killProcessTree: () => {},
    killWaitTimeoutMs: 300,
    currentTrackTmpPath,
    tmpPaths: new Set([currentTrackTmpPath]),
    plannedFinalOutputs: new Set(plannedFinalOutputs),
    completedFinalOutputs: new Set([plannedFinalOutputs[0]]),
    stagingPaths: new Set(),
    stagingClosers: new Set(),
    outputFolder,
    createAlbumFolder: true,
    safeRmdirIfEmpty: () => {},
    logger: null,
  };

  await cleanupJob("cancel-e2e", "CANCELLED", ctx);

  assertOk(!fs.existsSync(plannedFinalOutputs[0]), "Expected completed output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(plannedFinalOutputs[1]), "Expected in-progress output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(plannedFinalOutputs[2]), "Expected planned output to be absent on CANCELLED.");
  assertOk(!fs.existsSync(currentTrackTmpPath), "Expected temporary output to be deleted on CANCELLED.");
  assertOk(!fs.existsSync(reportPath), "Expected render-report.json to not exist in export folder on CANCELLED.");
  assertOk(!fs.existsSync(outputFolder), "Expected release folder to be removed on CANCELLED.");

  console.log("OK: cancel batch cleanup removes all planned outputs and created folder");
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
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

  await runCancelBatchCleanupScenario();

  console.log("E2E render tests completed successfully");
})();
