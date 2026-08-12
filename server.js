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

// ── CLOUDINARY ─────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ssp-prospect-video-renderer"
  });
});

// ── DOWNLOAD HELPER ────────────────────────────────────────────────────────

async function downloadFile(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 30000
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);

    response.data.pipe(writer);

    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// ── PROSPECT VIDEO RENDER ENDPOINT ─────────────────────────────────────────

app.post("/render-prospect-video", async (req, res) => {
  const {
    before_image_url,
    after_image_url,

    // Timing controls
    before_duration = 6,
    after_duration = 8,
    transition_duration = 1,

    // Transition control
    transition = "wipeleft",

    // Video settings
    fps = 30
  } = req.body || {};

  // ── VALIDATION ───────────────────────────────────────────────────────────

  if (!before_image_url || !after_image_url) {
    return res.status(400).json({
      success: false,
      error: "Missing before_image_url or after_image_url"
    });
  }

  if (
    !Number.isFinite(Number(before_duration)) ||
    Number(before_duration) <= 0
  ) {
    return res.status(400).json({
      success: false,
      error: "before_duration must be greater than 0"
    });
  }

  if (
    !Number.isFinite(Number(after_duration)) ||
    Number(after_duration) <= 0
  ) {
    return res.status(400).json({
      success: false,
      error: "after_duration must be greater than 0"
    });
  }

  if (
    !Number.isFinite(Number(transition_duration)) ||
    Number(transition_duration) < 0
  ) {
    return res.status(400).json({
      success: false,
      error: "transition_duration must be 0 or greater"
    });
  }

  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) {
    return res.status(400).json({
      success: false,
      error: "fps must be greater than 0"
    });
  }

  const beforeDuration = Number(before_duration);
  const afterDuration = Number(after_duration);
  const transitionDuration = Number(transition_duration);
  const frameRate = Number(fps);

  // xfade requires the second clip to continue long enough after the
  // transition begins.
  if (transitionDuration >= afterDuration) {
    return res.status(400).json({
      success: false,
      error: "transition_duration must be shorter than after_duration"
    });
  }

  // ── WORK DIRECTORY ───────────────────────────────────────────────────────

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ssp-prospect-")
  );

  const beforePath = path.join(workDir, "before.jpg");
  const afterPath = path.join(workDir, "after.jpg");
  const outputPath = path.join(workDir, "prospect.mp4");

  try {
    console.log("[PROSPECT VIDEO] Downloading source images...");

    await downloadFile(before_image_url, beforePath);
    await downloadFile(after_image_url, afterPath);

    console.log("[PROSPECT VIDEO] Images downloaded.");

    // ── FRAME COUNTS ────────────────────────────────────────────────────────

    const beforeFrames = Math.round(
      beforeDuration * frameRate
    );

    const afterFrames = Math.round(
      afterDuration * frameRate
    );

    // The total visible runtime after using xfade is:
    //
    // before_duration + after_duration - transition_duration
    //
    // because the transition overlaps the two clips.
    const outputDuration =
      beforeDuration +
      afterDuration -
      transitionDuration;

    // ── FFMPEG FILTER ───────────────────────────────────────────────────────
    //
    // BEFORE:
    // Slow 5% Ken Burns push.
    //
    // AFTER:
    // Very subtle 2% push.
    //
    // Then:
    // deterministic xfade transition.

   const filter = [
  "[0:v]" +
    "scale=1920:1080:force_original_aspect_ratio=decrease," +
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
    "setsar=1," +
    "zoompan=" +
      "z='min(zoom+0.0007,1.05)':" +
      "x='iw/2-(iw/zoom/2)':" +
      "y='ih/2-(ih/zoom/2)':" +
      `d=${beforeFrames}:` +
      "s=1920x1080:" +
      `fps=${frameRate}," +
    "drawtext=" +
      "text='ORIGINAL PHOTO':" +
      "fontcolor=white:" +
      "fontsize=42:" +
      "box=1:" +
      "boxcolor=black@0.55:" +
      "boxborderw=18:" +
      "x=60:" +
      "y=h-th-60" +
    "[beforev]",

  "[1:v]" +
    "scale=1920:1080:force_original_aspect_ratio=decrease," +
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
    "setsar=1," +
    "zoompan=" +
      "z='min(zoom+0.0003,1.02)':" +
      "x='iw/2-(iw/zoom/2)':" +
      "y='ih/2-(ih/zoom/2)':" +
      `d=${afterFrames}:` +
      "s=1920x1080:" +
      `fps=${frameRate}," +
    "drawtext=" +
      "text='VIRTUALLY STAGED':" +
      "fontcolor=white:" +
      "fontsize=42:" +
      "box=1:" +
      "boxcolor=black@0.55:" +
      "boxborderw=18:" +
      "x=60:" +
      "y=h-th-60" +
    "[afterv]",

  "[beforev][afterv]" +
    `xfade=` +
    `transition=${transition}:` +
    `duration=${transitionDuration}:` +
    `offset=${beforeDuration}` +
    "[outv]"
].join(";");

    console.log(
      `[PROSPECT VIDEO] Rendering: before=${beforeDuration}s ` +
      `after=${afterDuration}s ` +
      `transition=${transition} ` +
      `transitionDuration=${transitionDuration}s ` +
      `fps=${frameRate}`
    );

    // ── FFMPEG RENDER ───────────────────────────────────────────────────────

    await execFileAsync(
      "ffmpeg",
      [
        "-y",

        "-loop",
        "1",
        "-i",
        beforePath,

        "-loop",
        "1",
        "-i",
        afterPath,

        "-filter_complex",
        filter,

        "-map",
        "[outv]",

        "-t",
        String(outputDuration),

        "-c:v",
        "libx264",

        "-preset",
        "medium",

        "-crf",
        "18",

        "-pix_fmt",
        "yuv420p",

        "-movflags",
        "+faststart",

        "-r",
        String(frameRate),

        outputPath
      ],
      {
        maxBuffer: 20 * 1024 * 1024
      }
    );

    console.log("[PROSPECT VIDEO] FFmpeg render complete.");

    // ── CLOUDINARY UPLOAD ───────────────────────────────────────────────────

    const upload = await cloudinary.uploader.upload(
      outputPath,
      {
        resource_type: "video",
        folder: "ssp-prospects"
      }
    );

    console.log(
      `[PROSPECT VIDEO] Uploaded: ${upload.secure_url}`
    );

    // ── RESPONSE ────────────────────────────────────────────────────────────

    return res.json({
      success: true,

      video_url: upload.secure_url,
      public_id: upload.public_id,

      render: {
        before_duration: beforeDuration,
        after_duration: afterDuration,
        transition,
        transition_duration: transitionDuration,
        fps: frameRate,
        output_duration: outputDuration,
        width: 1920,
        height: 1080
      }
    });
  } catch (error) {
    console.error(
      "[PROSPECT VIDEO] Render failed:",
      error.stderr || error.message || error
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    try {
      fs.rmSync(workDir, {
        recursive: true,
        force: true
      });
    } catch (cleanupError) {
      console.error(
        "[PROSPECT VIDEO] Cleanup failed:",
        cleanupError.message
      );
    }
  }
});

// ── SERVER ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(
    `SSP Prospect Video Renderer listening on port ${PORT}`
  );
});
