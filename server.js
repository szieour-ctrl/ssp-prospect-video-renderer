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

// ─────────────────────────────────────────────────────────────
// CLOUDINARY
// ─────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ssp-prospect-video-renderer"
  });
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

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

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

function makeSafePublicId(value) {
  return String(value || "prospect")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─────────────────────────────────────────────────────────────
// PROSPECT VIDEO
// ─────────────────────────────────────────────────────────────

app.post("/render-prospect-video", async (req, res) => {
  const {
    before_image_url,
    after_image_url,

    before_duration = 6,
    after_duration = 8,
    transition_duration = 1,
    transition = "wipeleft",
    fps = 30,

    before_label = "ORIGINAL LISTING PHOTO",
    after_label = "SMART STAGE PRO PREVIEW",

    prospect_id = "prospect",
    agent_name = "",
    property_address = "",
    mls_number = ""
  } = req.body || {};

  if (!before_image_url || !after_image_url) {
    return res.status(400).json({
      success: false,
      error: "Missing before_image_url or after_image_url"
    });
  }

  const beforeDuration = Number(before_duration);
  const afterDuration = Number(after_duration);
  const transitionDuration = Number(transition_duration);
  const frameRate = Number(fps);

  if (!Number.isFinite(beforeDuration) || beforeDuration <= 0) {
    return res.status(400).json({
      success: false,
      error: "before_duration must be greater than 0"
    });
  }

  if (!Number.isFinite(afterDuration) || afterDuration <= 0) {
    return res.status(400).json({
      success: false,
      error: "after_duration must be greater than 0"
    });
  }

  if (!Number.isFinite(transitionDuration) || transitionDuration < 0) {
    return res.status(400).json({
      success: false,
      error: "transition_duration must be 0 or greater"
    });
  }

  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    return res.status(400).json({
      success: false,
      error: "fps must be greater than 0"
    });
  }

  if (transitionDuration >= afterDuration) {
    return res.status(400).json({
      success: false,
      error: "transition_duration must be shorter than after_duration"
    });
  }

  const safeBeforeLabel = escapeDrawtext(before_label);
  const safeAfterLabel = escapeDrawtext(after_label);
  const safeProspectId =
    makeSafePublicId(prospect_id) || "prospect";

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ssp-prospect-")
  );

  const beforePath = path.join(workDir, "before.jpg");
  const afterPath = path.join(workDir, "after.jpg");
  const outputPath = path.join(workDir, "prospect.mp4");

  try {
    console.log(
      `[PROSPECT VIDEO] Starting render for ${safeProspectId}`
    );

    await downloadFile(before_image_url, beforePath);
    await downloadFile(after_image_url, afterPath);

    const beforeFrames =
      Math.round(beforeDuration * frameRate);

    const afterFrames =
      Math.round(afterDuration * frameRate);

    const outputDuration =
      beforeDuration +
      afterDuration -
      transitionDuration;

    const filter = [
      `[0:v]
       scale=1920:1080:force_original_aspect_ratio=decrease,
       pad=1920:1080:(ow-iw)/2:(oh-ih)/2,
       setsar=1,
       zoompan=
       z='min(zoom+0.0007,1.05)':
       x='iw/2-(iw/zoom/2)':
       y='ih/2-(ih/zoom/2)':
       d=${beforeFrames}:
       s=1920x1080:
       fps=${frameRate},
       drawtext=
       text='${safeBeforeLabel}':
       fontcolor=white:
       fontsize=42:
       box=1:
       boxcolor=black@0.55:
       boxborderw=18:
       x=60:
       y=h-th-60
       [beforev]`,

      `[1:v]
       scale=1920:1080:force_original_aspect_ratio=decrease,
       pad=1920:1080:(ow-iw)/2:(oh-ih)/2,
       setsar=1,
       zoompan=
       z='min(zoom+0.0003,1.02)':
       x='iw/2-(iw/zoom/2)':
       y='ih/2-(ih/zoom/2)':
       d=${afterFrames}:
       s=1920x1080:
       fps=${frameRate},
       drawtext=
       text='${safeAfterLabel}':
       fontcolor=white:
       fontsize=42:
       box=1:
       boxcolor=black@0.55:
       boxborderw=18:
       x=60:
       y=h-th-60
       [afterv]`,

      `[beforev][afterv]
       xfade=
       transition=${transition}:
       duration=${transitionDuration}:
       offset=${beforeDuration}
       [outv]`
    ]
      .join(";")
      .replace(/\s*\n\s*/g, "");

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

    const upload =
      await cloudinary.uploader.upload(
        outputPath,
        {
          resource_type: "video",
          folder: "ssp-prospects",
          public_id: safeProspectId,
          overwrite: true
        }
      );

    return res.json({
      success: true,

      video_url: upload.secure_url,

      public_id: upload.public_id,

      prospect: {
        prospect_id,
        agent_name,
        property_address,
        mls_number
      },

      render: {
        before_duration: beforeDuration,
        after_duration: afterDuration,
        transition,
        transition_duration: transitionDuration,
        fps: frameRate,
        before_label,
        after_label,
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

// ─────────────────────────────────────────────────────────────
// PROSPECT EMAIL THUMBNAIL
// ─────────────────────────────────────────────────────────────

app.post(
  "/render-prospect-thumbnail",
  async (req, res) => {
    const {
      before_image_url,
      after_image_url,

      before_label = "ORIGINAL LISTING PHOTO",
      after_label = "SMART STAGE PRO PREVIEW",

      prospect_id = "prospect",
      agent_name = "",
      property_address = "",
      mls_number = ""
    } = req.body || {};

    if (!before_image_url || !after_image_url) {
      return res.status(400).json({
        success: false,
        error:
          "Missing before_image_url or after_image_url"
      });
    }

    // IMPORTANT:
    // These variables are initialized BEFORE
    // the FFmpeg filter is constructed.

    const safeBeforeLabel =
      escapeDrawtext(before_label);

    const safeAfterLabel =
      escapeDrawtext(after_label);

    const safeProspectId =
      makeSafePublicId(prospect_id) || "prospect";

    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ssp-thumb-")
    );

    const beforePath =
      path.join(workDir, "before.jpg");

    const afterPath =
      path.join(workDir, "after.jpg");

    const outputPath =
      path.join(workDir, "thumbnail.jpg");

    try {
      console.log(
        `[PROSPECT THUMBNAIL] Starting render for ${safeProspectId}`
      );

      await downloadFile(
        before_image_url,
        beforePath
      );

      await downloadFile(
        after_image_url,
        afterPath
      );

      const filter = [
        `[0:v]
         scale=960:1080:force_original_aspect_ratio=decrease,
         pad=960:1080:(ow-iw)/2:(oh-ih)/2,
         setsar=1
         [before]`,

        `[1:v]
         scale=960:1080:force_original_aspect_ratio=decrease,
         pad=960:1080:(ow-iw)/2:(oh-ih)/2,
         setsar=1
         [after]`,

        `[before][after]
         hstack=inputs=2,

         drawbox=
         x=958:
         y=0:
         w=4:
         h=1080:
         color=white@0.95:
         t=fill,

         drawbox=
         x=(w/2)-82:
         y=(h/2)-82:
         w=164:
         h=164:
         color=black@0.38:
         t=fill,

         drawtext=
         text='>':
         fontcolor=white:
         fontsize=112:
         x=(w-tw)/2:
         y=(h-th)/2-10,

         drawtext=
         text='${safeBeforeLabel}':
         fontcolor=white:
         fontsize=34:
         box=1:
         boxcolor=black@0.55:
         boxborderw=14:
         x=40:
         y=h-th-40,

         drawtext=
         text='${safeAfterLabel}':
         fontcolor=white:
         fontsize=34:
         box=1:
         boxcolor=black@0.55:
         boxborderw=14:
         x=w-tw-40:
         y=h-th-40

         [out]`
      ]
        .join(";")
        .replace(/\s*\n\s*/g, "");

      await execFileAsync(
        "ffmpeg",
        [
          "-y",

          "-i",
          beforePath,

          "-i",
          afterPath,

          "-filter_complex",
          filter,

          "-map",
          "[out]",

          "-frames:v",
          "1",

          "-q:v",
          "2",

          outputPath
        ],
        {
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      const upload =
        await cloudinary.uploader.upload(
          outputPath,
          {
            resource_type: "image",
            folder: "ssp-prospects",

            public_id:
              `${safeProspectId}-thumbnail`,

            overwrite: true
          }
        );

      return res.json({
        success: true,

        image_url:
          upload.secure_url,

        public_id:
          upload.public_id,

        prospect: {
          prospect_id,
          agent_name,
          property_address,
          mls_number
        },

        thumbnail: {
          width: 1920,
          height: 1080,
          before_label,
          after_label
        }
      });
    } catch (error) {
      console.error(
        "[PROSPECT THUMBNAIL] Render failed:",
        error.stderr ||
          error.message ||
          error
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
          "[PROSPECT THUMBNAIL] Cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(
    `SSP Prospect Video Renderer listening on port ${PORT}`
  );
});
