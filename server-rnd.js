require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

const SERVICE_NAME = "ssp-luxury-parallax-pivot-rnd";
const SERVICE_VERSION = "0.2.0";

const s3 = new S3Client({ region: AWS_REGION });

function makeSafePublicId(value) {
  return String(value || "motion-test")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeSafeStreetAddress(propertyAddress) {
  if (!propertyAddress) return "";

  return String(propertyAddress)
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeProspectFolder(prospectId, propertyAddress) {
  const safeProspectId =
    makeSafePublicId(prospectId) || "motion-test";

  const safeStreetAddress =
    makeSafeStreetAddress(propertyAddress);

  return safeStreetAddress
    ? `${safeProspectId}_${safeStreetAddress}`
    : safeProspectId;
}

function buildS3Url(key) {
  const encoded = key
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encoded}`;
}

async function downloadImage(url, outputPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "arraybuffer",
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status =>
      status >= 200 && status < 300
  });

  const contentType =
    response.headers["content-type"] || "";

  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Expected image but received ${
        contentType || "unknown content type"
      }`
    );
  }

  const buffer = Buffer.from(response.data);

  if (buffer.length < 1000) {
    throw new Error(
      `Downloaded image is unexpectedly small: ${buffer.length} bytes`
    );
  }

  await fs.promises.writeFile(outputPath, buffer);
}

async function uploadVideo(filePath, key) {
  if (!AWS_S3_BUCKET) {
    throw new Error(
      "AWS_S3_BUCKET environment variable is not configured"
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000"
    })
  );

  return {
    url: buildS3Url(key),
    key
  };
}

function validateMotion({
  start_zoom,
  end_zoom,
  start_x,
  end_x,
  start_y,
  end_y,
  duration,
  fps,
  easing
}) {
  const numbers = {
    start_zoom,
    end_zoom,
    start_x,
    end_x,
    start_y,
    end_y,
    duration,
    fps
  };

  for (const [name, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value)) {
      return `${name} must be a finite number`;
    }
  }

  if (duration <= 0) {
    return "duration must be greater than 0";
  }

  if (fps <= 0) {
    return "fps must be greater than 0";
  }

  if (start_zoom <= 0 || end_zoom <= 0) {
    return "start_zoom and end_zoom must be greater than 0";
  }

  for (const [name, value] of Object.entries({
    start_x,
    end_x,
    start_y,
    end_y
  })) {
    if (value < 0 || value > 1) {
      return `${name} must be between 0 and 1`;
    }
  }

  if (!["linear", "smoothstep"].includes(easing)) {
    return "easing must be linear or smoothstep";
  }

  return null;
}

function validatePivotMotion({
  start_zoom,
  zoom_delta,
  drift_strength,
  vertical_drift_ratio,
  pivot_side,
  pivot_strength,
  vertical_spread,
  duration,
  fps
}) {
  const numbers = {
    start_zoom,
    zoom_delta,
    drift_strength,
    vertical_drift_ratio,
    pivot_strength,
    vertical_spread,
    duration,
    fps
  };

  for (const [name, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value)) {
      return `${name} must be a finite number`;
    }
  }

  if (duration <= 0) {
    return "duration must be greater than 0";
  }

  if (fps <= 0) {
    return "fps must be greater than 0";
  }

  if (start_zoom <= 0) {
    return "start_zoom must be greater than 0";
  }

  if (!["left", "right"].includes(pivot_side)) {
    return "pivot_side must be left or right";
  }

  if (pivot_strength < 0 || pivot_strength > 0.08) {
    return "pivot_strength must be between 0 and 0.08";
  }

  if (vertical_spread < 0 || vertical_spread > 1) {
    return "vertical_spread must be between 0 and 1";
  }

  return null;
}

function buildMotionFilter({
  start_zoom,
  end_zoom,
  start_x,
  end_x,
  start_y,
  end_y,
  duration,
  fps,
  easing
}) {
  const frames =
    Math.max(2, Math.round(duration * fps));

  const lastFrame = frames - 1;

  const progress =
    easing === "smoothstep"
      ? `(3*pow(min(on/${lastFrame},1),2)-2*pow(min(on/${lastFrame},1),3))`
      : `min(on/${lastFrame},1)`;

  const zoomDelta =
    end_zoom - start_zoom;

  const xDelta =
    end_x - start_x;

  const yDelta =
    end_y - start_y;

  return (
    `[0:v]` +
    `scale=3840:2160:force_original_aspect_ratio=increase,` +
    `crop=3840:2160,` +
    `setsar=1,` +
    `zoompan=` +
    `z='${start_zoom}+${zoomDelta}*${progress}':` +
    `x='(iw-iw/zoom)*(${start_x}+${xDelta}*${progress})':` +
    `y='(ih-ih/zoom)*(${start_y}+${yDelta}*${progress})':` +
    `d=${frames}:` +
    `s=1920x1080:` +
    `fps=${fps}` +
    `[outv]`
  );
}

function buildLuxuryPivotFilter({
  start_zoom,
  zoom_delta,
  drift_strength,
  vertical_drift_ratio,
  pivot_side,
  pivot_strength,
  vertical_spread,
  duration,
  fps
}) {
  const frames =
    Math.max(2, Math.round(duration * fps));

  const lastFrame =
    frames - 1;

  /*
    Luxury Parallax + Pivot v1

    t_in = ease_in(t)
    zoom = start_zoom + zoom_delta * t_in

    overscan = 1 - 1 / zoom
    drift = overscan * drift_strength

    pan_x = drift * t_in
    pan_y = -drift * vertical_drift_ratio * t_in

    pivot = overscan * pivot_strength * t_in
  */

  const t =
    `min(on/${lastFrame},1)`;

  const tIn =
    `pow(${t},2)`;

  const zoom =
    `(${start_zoom}+${zoom_delta}*${tIn})`;

  const overscan =
    `(1-1/${zoom})`;

  const drift =
    `(${overscan}*${drift_strength})`;

  const panX =
    `(${drift}*${tIn})`;

  const panY =
    `(-${drift}*${vertical_drift_ratio}*${tIn})`;

  const pivot =
    `(${overscan}*${pivot_strength}*${tIn})`;

  const W = 3840;
  const H = 2160;

  let x0 = "0";
  let y0 = "0";

  let x1 = String(W);
  let y1 = "0";

  let x2 = "0";
  let y2 = String(H);

  let x3 = String(W);
  let y3 = String(H);

  if (pivot_side === "left") {
    /*
      Left edge is the visual hinge.

      Right side expands outward.
    */

    x1 =
      `${W}+${W}*${pivot}`;

    y1 =
      `0-${H}*${pivot}*${vertical_spread}`;

    x3 =
      `${W}+${W}*${pivot}`;

    y3 =
      `${H}+${H}*${pivot}*${vertical_spread}`;
  } else {
    /*
      Right edge is the visual hinge.

      Left side expands outward.
    */

    x0 =
      `0-${W}*${pivot}`;

    y0 =
      `0-${H}*${pivot}*${vertical_spread}`;

    x2 =
      `0-${W}*${pivot}`;

    y2 =
      `${H}+${H}*${pivot}*${vertical_spread}`;
  }

  return (
    `[0:v]` +

    `scale=4200:2363:force_original_aspect_ratio=increase,` +
    `crop=4200:2363,` +
    `setsar=1,` +
    `crop=3840:2160,` +

    `perspective=` +
    `x0='${x0}':` +
    `y0='${y0}':` +
    `x1='${x1}':` +
    `y1='${y1}':` +
    `x2='${x2}':` +
    `y2='${y2}':` +
    `x3='${x3}':` +
    `y3='${y3}':` +
    `eval=frame:` +
    `interpolation=linear,` +

    `zoompan=` +
    `z='${zoom}':` +
    `x='(iw-iw/zoom)*(0.5+${panX})':` +
    `y='(ih-ih/zoom)*(0.5+${panY})':` +
    `d=${frames}:` +
    `s=1920x1080:` +
    `fps=${fps}` +

    `[outv]`
  );
}

async function renderMotionClip(params) {
  const workDir =
    fs.mkdtempSync(
      path.join(os.tmpdir(), "ssp-rnd-")
    );

  const inputPath =
    path.join(workDir, "input.jpg");

  const outputPath =
    path.join(workDir, "motion.mp4");

  try {
    await downloadImage(
      params.image_url,
      inputPath
    );

    const filter =
      buildMotionFilter(params);

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-loop", "1",
        "-i", inputPath,

        "-filter_complex", filter,
        "-map", "[outv]",

        "-t", String(params.duration),

        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",

        "-r", String(params.fps),

        outputPath
      ],
      {
        maxBuffer: 20 * 1024 * 1024
      }
    );

    const folder =
      makeProspectFolder(
        params.prospect_id,
        params.property_address
      );

    const outputName =
      makeSafePublicId(
        params.output_name || "custom-motion"
      ) || "custom-motion";

    const key =
      `ssp-prospects/${folder}/tests/${outputName}.mp4`;

    return await uploadVideo(
      outputPath,
      key
    );
  } finally {
    fs.rmSync(
      workDir,
      {
        recursive: true,
        force: true
      }
    );
  }
}

async function renderLuxuryPivotClip(params) {
  const workDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "ssp-pivot-rnd-"
      )
    );

  const inputPath =
    path.join(
      workDir,
      "input.jpg"
    );

  const outputPath =
    path.join(
      workDir,
      "pivot.mp4"
    );

  try {
    await downloadImage(
      params.image_url,
      inputPath
    );

    const filter =
      buildLuxuryPivotFilter(params);

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-loop", "1",
        "-i", inputPath,

        "-filter_complex", filter,
        "-map", "[outv]",

        "-t", String(params.duration),

        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",

        "-r", String(params.fps),

        outputPath
      ],
      {
        maxBuffer: 20 * 1024 * 1024
      }
    );

    const folder =
      makeProspectFolder(
        params.prospect_id,
        params.property_address
      );

    const outputName =
      makeSafePublicId(
        params.output_name ||
        "luxury-parallax-pivot"
      ) ||
      "luxury-parallax-pivot";

    const key =
      `ssp-prospects/${folder}/tests/${outputName}.mp4`;

    return await uploadVideo(
      outputPath,
      key
    );
  } finally {
    fs.rmSync(
      workDir,
      {
        recursive: true,
        force: true
      }
    );
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    mode: "railway-rnd-test",
    storage: "s3",
    s3_configured: Boolean(AWS_S3_BUCKET),
    region: AWS_REGION,

    routes: [
      "GET /health",
      "POST /test-cinematic-motion",
      "POST /test-cinematic-motion-custom",
      "POST /test-luxury-parallax-pivot"
    ]
  });
});

app.post(
  "/test-cinematic-motion",
  async (req, res) => {
    const presets = {
      cinematic_push_right: {
        start_zoom: 1.02,
        end_zoom: 1.30,

        start_x: 0.34,
        end_x: 0.62,

        start_y: 0.55,
        end_y: 0.48,

        easing: "linear"
      }
    };

    const {
      image_url,
      preset = "cinematic_push_right",
      duration = 5,
      fps = 30,
      prospect_id = "motion-test",
      property_address = ""
    } = req.body || {};

    if (!image_url) {
      return res.status(400).json({
        success: false,
        error: "Missing image_url"
      });
    }

    if (!presets[preset]) {
      return res.status(400).json({
        success: false,
        error: `Unknown preset: ${preset}`
      });
    }

    const p =
      presets[preset];

    const params = {
      image_url,
      output_name: preset,
      prospect_id,
      property_address,

      duration: Number(duration),
      fps: Number(fps),

      ...p
    };

    const error =
      validateMotion(params);

    if (error) {
      return res.status(400).json({
        success: false,
        error
      });
    }

    try {
      const upload =
        await renderMotionClip(params);

      return res.json({
        success: true,
        video_url: upload.url,
        public_id: upload.key,

        render: {
          route:
            "/test-cinematic-motion",

          preset,

          duration:
            params.duration,

          fps:
            params.fps,

          easing:
            params.easing,

          start_zoom:
            params.start_zoom,

          end_zoom:
            params.end_zoom,

          start_focal_position: {
            x: params.start_x,
            y: params.start_y
          },

          end_focal_position: {
            x: params.end_x,
            y: params.end_y
          },

          width: 1920,
          height: 1080
        }
      });
    } catch (error) {
      console.error(
        "[RND PRESET] Render failed:",
        error.stderr ||
        error.message ||
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Preset render failed"
      });
    }
  }
);

app.post(
  "/test-cinematic-motion-custom",
  async (req, res) => {
    const {
      image_url,
      output_name = "custom-motion",

      duration = 5,
      fps = 30,

      easing = "linear",

      start_zoom,
      end_zoom,

      start_x,
      end_x,

      start_y,
      end_y,

      prospect_id = "motion-test",
      property_address = ""
    } = req.body || {};

    if (!image_url) {
      return res.status(400).json({
        success: false,
        error: "Missing image_url"
      });
    }

    const params = {
      image_url,
      output_name,

      prospect_id,
      property_address,

      duration:
        Number(duration),

      fps:
        Number(fps),

      easing,

      start_zoom:
        Number(start_zoom),

      end_zoom:
        Number(end_zoom),

      start_x:
        Number(start_x),

      end_x:
        Number(end_x),

      start_y:
        Number(start_y),

      end_y:
        Number(end_y)
    };

    const error =
      validateMotion(params);

    if (error) {
      return res.status(400).json({
        success: false,
        error
      });
    }

    try {
      const upload =
        await renderMotionClip(params);

      return res.json({
        success: true,
        video_url: upload.url,
        public_id: upload.key,

        render: {
          route:
            "/test-cinematic-motion-custom",

          output_name,

          duration:
            params.duration,

          fps:
            params.fps,

          easing,

          start_zoom:
            params.start_zoom,

          end_zoom:
            params.end_zoom,

          start_focal_position: {
            x: params.start_x,
            y: params.start_y
          },

          end_focal_position: {
            x: params.end_x,
            y: params.end_y
          },

          width: 1920,
          height: 1080
        }
      });
    } catch (error) {
      console.error(
        "[RND CUSTOM] Render failed:",
        error.stderr ||
        error.message ||
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Custom render failed"
      });
    }
  }
);

app.post(
  "/test-luxury-parallax-pivot",
  async (req, res) => {
    const {
      image_url,

      output_name =
        "luxury-parallax-pivot",

      duration = 5,
      fps = 30,

      start_zoom = 1.0,
      zoom_delta = 0.15,

      drift_strength = 0.30,
      vertical_drift_ratio = 0.60,

      pivot_side = "left",
      pivot_strength = 0.03,
      vertical_spread = 0.30,

      prospect_id = "motion-test",
      property_address = ""
    } = req.body || {};

    if (!image_url) {
      return res.status(400).json({
        success: false,
        error: "Missing image_url"
      });
    }

    const params = {
      image_url,
      output_name,

      duration:
        Number(duration),

      fps:
        Number(fps),

      start_zoom:
        Number(start_zoom),

      zoom_delta:
        Number(zoom_delta),

      drift_strength:
        Number(drift_strength),

      vertical_drift_ratio:
        Number(vertical_drift_ratio),

      pivot_side,

      pivot_strength:
        Number(pivot_strength),

      vertical_spread:
        Number(vertical_spread),

      prospect_id,
      property_address
    };

    const error =
      validatePivotMotion(params);

    if (error) {
      return res.status(400).json({
        success: false,
        error
      });
    }

    try {
      const upload =
        await renderLuxuryPivotClip(
          params
        );

      return res.json({
        success: true,
        video_url: upload.url,
        public_id: upload.key,

        render: {
          route:
            "/test-luxury-parallax-pivot",

          output_name:
            params.output_name,

          duration:
            params.duration,

          fps:
            params.fps,

          start_zoom:
            params.start_zoom,

          zoom_delta:
            params.zoom_delta,

          drift_strength:
            params.drift_strength,

          vertical_drift_ratio:
            params.vertical_drift_ratio,

          pivot_side:
            params.pivot_side,

          pivot_strength:
            params.pivot_strength,

          vertical_spread:
            params.vertical_spread,

          width: 1920,
          height: 1080
        }
      });
    } catch (error) {
      console.error(
        "[RND PIVOT] Render failed:",
        error.stderr ||
        error.message ||
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Luxury Parallax Pivot render failed"
      });
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `${SERVICE_NAME} v${SERVICE_VERSION} listening on port ${PORT}`
    );

    console.log(
      `[RND] Custom route: /test-cinematic-motion-custom`
    );

    console.log(
      `[RND] Pivot route: /test-luxury-parallax-pivot`
    );

    console.log(
      `[S3] Region: ${AWS_REGION}`
    );

    console.log(
      `[S3] Bucket: ${
        AWS_S3_BUCKET || "NOT CONFIGURED"
      }`
    );
  }
);
