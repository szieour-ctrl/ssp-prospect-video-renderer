require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// AWS S3
// ─────────────────────────────────────────────────────────────

const AWS_REGION =
  process.env.AWS_REGION || "us-east-2";

const AWS_S3_BUCKET =
  process.env.AWS_S3_BUCKET;

const s3 = new S3Client({
  region: AWS_REGION
});

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ssp-prospect-video-renderer",
    storage: "s3",
    region: AWS_REGION
  });
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function downloadFile(
  url,
  outputPath
) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "arraybuffer",
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status =>
      status >= 200 &&
      status < 300
  });

  const contentType =
    response.headers["content-type"] || "";

  if (
    !contentType.startsWith("image/")
  ) {
    throw new Error(
      `Expected image but received ${
        contentType ||
        "unknown content type"
      } from ${url}`
    );
  }

  const buffer =
    Buffer.from(response.data);

  if (buffer.length < 1000) {
    throw new Error(
      `Downloaded image is unexpectedly small: ${buffer.length} bytes`
    );
  }

  await fs.promises.writeFile(
    outputPath,
    buffer
  );
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

function makeSafeStreetAddress(
  propertyAddress
) {
  if (!propertyAddress) {
    return "";
  }

  const streetOnly =
    String(propertyAddress)
      .split(",")[0]
      .trim();

  return streetOnly
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getPacificRunDate(
  date = new Date()
) {
  const dateParts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Los_Angeles",
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit"
      }
    ).formatToParts(date);

  const values =
    Object.fromEntries(
      dateParts.map(part => [
        part.type,
        part.value
      ])
    );

  return `${values.year}-${values.month}-${values.day}`;
}

function makeProspectFolder(
  propertyAddress,
  date = new Date()
) {
  const safeStreetAddress =
    makeSafeStreetAddress(
      propertyAddress
    );

  if (!safeStreetAddress) {
    throw new Error(
      "property_address is required to create the prospect folder"
    );
  }

  return `${getPacificRunDate(date)}__${safeStreetAddress}`;
}

function ensureS3Configured() {
  if (!AWS_S3_BUCKET) {
    throw new Error(
      "AWS_S3_BUCKET environment variable is not configured"
    );
  }
}

function encodeS3Key(key) {
  return key
    .split("/")
    .map(segment =>
      encodeURIComponent(
        segment
      )
    )
    .join("/");
}

function buildS3Url(key) {
  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeS3Key(
    key
  )}`;
}

async function uploadFileToS3({
  filePath,
  key,
  contentType
}) {
  ensureS3Configured();

  await s3.send(
    new PutObjectCommand({
      Bucket:
        AWS_S3_BUCKET,

      Key:
        key,

      Body:
        fs.createReadStream(
          filePath
        ),

      ContentType:
        contentType,

      CacheControl:
        "public, max-age=31536000"
    })
  );

  return {
    url:
      buildS3Url(key),

    key
  };
}

// ─────────────────────────────────────────────────────────────
// PROSPECT VIDEO
// ─────────────────────────────────────────────────────────────

app.post(
  "/render-prospect-video",
  async (req, res) => {
    const {
      before_image_url,
      after_image_url,

      before_duration = 3,
      after_duration = 11,
      transition_duration = 1,
      transition = "wipeleft",
      fps = 30,

      before_label =
        "ORIGINAL LISTING PHOTO",

      after_label =
        "SMART STAGE PRO PREVIEW",

      prospect_id =
        "prospect",

      agent_name =
        "",

      property_address =
        "",

      mls_number =
        ""
    } = req.body || {};

    if (
      !before_image_url ||
      !after_image_url ||
      !property_address
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Missing before_image_url, after_image_url, or property_address"
        });
    }

    const beforeDuration =
      Number(
        before_duration
      );

    const afterDuration =
      Number(
        after_duration
      );

    const transitionDuration =
      Number(
        transition_duration
      );

    const frameRate =
      Number(fps);

    if (
      !Number.isFinite(
        beforeDuration
      ) ||
      beforeDuration <= 0
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "before_duration must be greater than 0"
        });
    }

    if (
      !Number.isFinite(
        afterDuration
      ) ||
      afterDuration <= 0
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "after_duration must be greater than 0"
        });
    }

    if (
      !Number.isFinite(
        transitionDuration
      ) ||
      transitionDuration < 0
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "transition_duration must be 0 or greater"
        });
    }

    if (
      !Number.isFinite(
        frameRate
      ) ||
      frameRate <= 0
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "fps must be greater than 0"
        });
    }

    if (
      transitionDuration >=
      afterDuration
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "transition_duration must be shorter than after_duration"
        });
    }

    const safeBeforeLabel =
      escapeDrawtext(
        before_label
      );

    const safeAfterLabel =
      escapeDrawtext(
        after_label
      );

    const prospectFolder =
      makeProspectFolder(
        property_address
      );

    const prospectRunDate =
      prospectFolder.slice(0, 10);

    const prospectStoragePrefix =
      `ssp-prospects/${prospectFolder}/`;

    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ssp-prospect-"
        )
      );

    const beforePath =
      path.join(
        workDir,
        "before.jpg"
      );

    const afterPath =
      path.join(
        workDir,
        "after.jpg"
      );

    const outputPath =
      path.join(
        workDir,
        "prospect.mp4"
      );

    try {
      console.log(
        `[PROSPECT VIDEO] Starting render for ${prospectFolder}`
      );

      await downloadFile(
        before_image_url,
        beforePath
      );

      await downloadFile(
        after_image_url,
        afterPath
      );

      const beforeFrames =
        Math.round(
          beforeDuration *
            frameRate
        );

      const afterFrames =
        Math.round(
          afterDuration *
            frameRate
        );

      const outputDuration =
        beforeDuration +
        afterDuration -
        transitionDuration;

      // ───────────────────────────────────────────────────────
      // STAGED IMAGE KEN BURNS
      //
      // Same basic motion profile as PRO Plus:
      //
      // start_zoom = 1.0
      // max_zoom   = 1.5
      // duration   = 6 seconds
      //
      // Smoothstep ease-in/ease-out:
      //
      // t = min(frame / (6 * fps), 1)
      // ease = 3t² - 2t³
      // zoom = 1 + 0.5 * ease
      //
      // Once t reaches 1, zoom remains at 1.5.
      // ───────────────────────────────────────────────────────

      const kenBurnsFrames =
        6 * frameRate;

      const filter = [
        `[0:v]
         scale=1920:1080:force_original_aspect_ratio=decrease,
         pad=1920:1080:(ow-iw)/2:(oh-ih)/2,
         setsar=1,

         zoompan=
         z='min(zoom+0.00012,1.012)':
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
         z='1+0.35*(3*pow(min(on/${kenBurnsFrames},1),2)-2*pow(min(on/${kenBurnsFrames},1),3))':
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
        .replace(
          /\s*\n\s*/g,
          ""
        );

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
          String(
            outputDuration
          ),

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
          String(
            frameRate
          ),

          outputPath
        ],
        {
          maxBuffer:
            20 *
            1024 *
            1024
        }
      );

      const videoKey =
        `ssp-prospects/${prospectFolder}/video.mp4`;

      const upload =
        await uploadFileToS3({
          filePath:
            outputPath,

          key:
            videoKey,

          contentType:
            "video/mp4"
        });

      console.log(
        `[PROSPECT VIDEO] Uploaded to S3: ${upload.key}`
      );

      return res.json({
        success:
          true,

        video_url:
          upload.url,

        public_id:
          upload.key,

        prospect: {
          prospect_id,
          agent_name,
          property_address,
          mls_number,
          run_date:
            prospectRunDate,
          folder_name:
            prospectFolder,
          storage_prefix:
            prospectStoragePrefix
        },

        render: {
          before_duration:
            beforeDuration,

          after_duration:
            afterDuration,

          transition,

          transition_duration:
            transitionDuration,

          fps:
            frameRate,

          before_label,

          after_label,

          output_duration:
            outputDuration,

          staged_motion:
            "ken_burns_push_in",

          ken_burns_duration:
            6,

          ken_burns_start_zoom:
            1.0,

          ken_burns_end_zoom:
            1.5,

          width:
            1920,

          height:
            1080
        }
      });
    } catch (error) {
      console.error(
        "[PROSPECT VIDEO] Render failed:",
        error.stderr ||
          error.message ||
          error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "Prospect video rendering failed"
        });
    } finally {
      try {
        fs.rmSync(
          workDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      } catch (
        cleanupError
      ) {
        console.error(
          "[PROSPECT VIDEO] Cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────
// PROSPECT EMAIL THUMBNAIL
// MATCHED FILL + CENTER CROP
// ─────────────────────────────────────────────────────────────

app.post(
  "/render-prospect-thumbnail",
  async (req, res) => {
    const {
      before_image_url,
      after_image_url,

      before_label =
        "ORIGINAL LISTING PHOTO",

      after_label =
        "SMART STAGE PRO PREVIEW",

      prospect_id =
        "prospect",

      agent_name =
        "",

      property_address =
        "",

      mls_number =
        ""
    } = req.body || {};

    if (
      !before_image_url ||
      !after_image_url ||
      !property_address
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Missing before_image_url, after_image_url, or property_address"
        });
    }

    const safeBeforeLabel =
      escapeDrawtext(
        before_label
      );

    const safeAfterLabel =
      escapeDrawtext(
        after_label
      );

    const prospectFolder =
      makeProspectFolder(
        property_address
      );

    const prospectRunDate =
      prospectFolder.slice(0, 10);

    const prospectStoragePrefix =
      `ssp-prospects/${prospectFolder}/`;

    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ssp-thumb-"
        )
      );

    const beforePath =
      path.join(
        workDir,
        "before.jpg"
      );

    const afterPath =
      path.join(
        workDir,
        "after.jpg"
      );

    const outputPath =
      path.join(
        workDir,
        "thumbnail.jpg"
      );

    try {
      console.log(
        `[PROSPECT THUMBNAIL] Starting render for ${prospectFolder}`
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
         scale=960:1080:force_original_aspect_ratio=increase,
         crop=960:1080,
         setsar=1
         [before]`,

        `[1:v]
         scale=960:1080:force_original_aspect_ratio=increase,
         crop=960:1080,
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
         x=(w/2)-80:
         y=(h/2)-80:
         w=160:
         h=160:
         color=black@0.45:
         t=fill,

         drawtext=
         text='▶':
         fontcolor=white:
         fontsize=96:
         x=(w-tw)/2+6:
         y=(h-th)/2-4,

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
        .replace(
          /\s*\n\s*/g,
          ""
        );

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
            20 *
            1024 *
            1024
        }
      );

      const thumbnailKey =
        `ssp-prospects/${prospectFolder}/thumbnail.jpg`;

      const upload =
        await uploadFileToS3({
          filePath:
            outputPath,

          key:
            thumbnailKey,

          contentType:
            "image/jpeg"
        });

      console.log(
        `[PROSPECT THUMBNAIL] Uploaded to S3: ${upload.key}`
      );

      return res.json({
        success:
          true,

        image_url:
          upload.url,

        public_id:
          upload.key,

        prospect: {
          prospect_id,
          agent_name,
          property_address,
          mls_number,
          run_date:
            prospectRunDate,
          folder_name:
            prospectFolder,
          storage_prefix:
            prospectStoragePrefix
        },

        thumbnail: {
          width:
            1920,

          height:
            1080,

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

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "Prospect thumbnail rendering failed"
        });
    } finally {
      try {
        fs.rmSync(
          workDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      } catch (
        cleanupError
      ) {
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

app.listen(
  PORT,
  () => {
    console.log(
      `SSP Prospect Video Renderer listening on port ${PORT}`
    );

    console.log(
      `[S3] Region: ${AWS_REGION}`
    );

    console.log(
      `[S3] Bucket: ${
        AWS_S3_BUCKET ||
        "NOT CONFIGURED"
      }`
    );
  }
);
