const { spawn } = require("child_process");
const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`${cmd} exited ${code}\n\n${stderr}`);
      err.code = code;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function isAudioCopyCompatibilityError(stderr) {
  const lower = String(stderr || "").toLowerCase();
  return [
    "could not find tag for codec",
    "codec not currently supported in container",
    "error initializing output stream",
    "could not write header",
    "tag mp4a",
  ].some((m) => lower.includes(m));
}

function buildArgs({ audioPath, imagePath, outputPath, audioMode }) {
  const audioArgs = audioMode === "copy"
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "320k"];

  return [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    ...audioArgs,
    outputPath,
  ];
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

async function renderOneTrack({ audioPath, imagePath, outputPath }) {
  const tmpPath = String(outputPath).toLowerCase().endsWith(".mp4")
    ? `${outputPath.slice(0, -4)}.tmp.mp4`
    : `${outputPath}.tmp.mp4`;
  safeUnlink(tmpPath);

  try {
    await run(ffmpegPath, buildArgs({
      audioPath,
      imagePath,
      outputPath: tmpPath,
      audioMode: "copy",
    }));
  } catch (err) {
    if (!isAudioCopyCompatibilityError(err?.stderr)) throw err;
    safeUnlink(tmpPath);
    await run(ffmpegPath, buildArgs({
      audioPath,
      imagePath,
      outputPath: tmpPath,
      audioMode: "aac",
    }));
  }

  const stat = fs.statSync(tmpPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Invalid temporary output: ${tmpPath}`);
  }
  fs.renameSync(tmpPath, outputPath);
}

module.exports = { renderOneTrack };
