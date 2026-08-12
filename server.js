require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const cloudinary = require("cloudinary").v2;

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ssp-prospect-video-renderer"
  });
});

async function downloadFile(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream"
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.post("/render-prospect-video", async (req, res) => {
  const {
    before_image_url,
    after_image_url
  } = req.body || {};

  if (!before_image_url || !after_image_url) {
    return res.status(400).json({
      success: false,
      error: "Missing before_image_url or after_image_url"
    });
  }

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ssp-prospect-")
  );

  const beforePath = path.join(workDir, "before.jpg");
  const afterPath = path.join(workDir, "after.jpg");
  const outputPath = path.join(workDir, "prospect.mp4");

  try {
    await downloadFile(before_image_url, beforePath);
    await downloadFile(after_image_url, afterPath);

    const filter = [
      "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
      "zoompan=z='min(zoom+0.0007,1.05)':" +
      "x='iw/2-(iw/zoom/2)':" +
      "y='ih/2-(ih/zoom/2)':" +
      "d=180:s=1920x1080:fps=30[beforev]",

      "[1:v]scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
      "zoompan=z='min(zoom+0.0003,1.02)':" +
      "x='iw/2-(iw/zoom/2)':" +
      "y='ih/2-(ih/zoom/2)':" +
      "d=240:s=1920x1080:fps=30[afterv]",

      "[beforev][afterv]" +
      "xfade=transition=wipeleft:duration=1:offset=6[outv]"
    ].join(";");

    await execFileAsync("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", beforePath,
      "-loop", "1",
      "-i", afterPath,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-t", "14",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      outputPath
    ]);

    const upload = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      folder: "ssp-prospects"
    });

    return res.json({
      success: true,
      video_url: upload.secure_url,
      public_id: upload.public_id
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    fs.rmSync(workDir, {
      recursive: true,
      force: true
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `SSP Prospect Video Renderer listening on port ${PORT}`
  );
});
