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
      // start_zoom = 1.0
      // max_zoom   = 1.35
      // duration   = 6 seconds
      //
      // Smoothstep ease-in/ease-out:
      //
      // t = min(frame / (6 * fps), 1)
      // ease = 3t² - 2t³
      // zoom = 1 + 0.35 * ease
      //
      // Once t reaches 1, zoom remains at 1.35.
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

          "-
