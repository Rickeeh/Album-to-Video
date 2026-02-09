const { spawn } = require("child_process");
const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited ${code}\n\n${stderr}`));
    });
  });
}

async function renderOneTrack({ audioPath, imagePath, outputPath }) {
  const tmpPath = String(outputPath).toLowerCase().endsWith(".mp4")
    ? `${outputPath.slice(0, -4)}.tmp.mp4`
    : `${outputPath}.tmp.mp4`;
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {}

  // Para testes e2e: encode de áudio seguro para MP4 (robusto para wav/mp3/etc)
  await run(ffmpegPath, [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-c:v",
    "libx264",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    tmpPath,
  ]);

  const stat = fs.statSync(tmpPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Invalid temporary output: ${tmpPath}`);
  }
  fs.renameSync(tmpPath, outputPath);
}

module.exports = { renderOneTrack };
