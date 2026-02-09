const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { renderOneTrack } = require("../../engine/renderAlbum");

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

  console.log("E2E render tests completed successfully");
})();
