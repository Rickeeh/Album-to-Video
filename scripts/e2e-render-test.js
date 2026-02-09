const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { renderOneTrack } = require("../engine/renderAlbum");

const output = path.join(__dirname, "out.mp4");

(async () => {
  if (fs.existsSync(output)) fs.unlinkSync(output);

  await renderOneTrack({
    audioPath: path.join(__dirname, "../fixtures/test.wav"),
    imagePath: path.join(__dirname, "../fixtures/test.jpg"),
    outputPath: output
  });

  if (!fs.existsSync(output)) {
    console.error("Output video not created");
    process.exit(1);
  }

  const probe = spawnSync(
    require("@ffprobe-installer/ffprobe").path,
    ["-v", "error", "-show_streams", output],
    { encoding: "utf8" }
  );

  if (!probe.stdout.includes("codec_type=audio")) {
    console.error("No audio stream found");
    process.exit(1);
  }

  if (!probe.stdout.includes("codec_type=video")) {
    console.error("No video stream found");
    process.exit(1);
  }

  console.log("E2E render test OK");
})();

