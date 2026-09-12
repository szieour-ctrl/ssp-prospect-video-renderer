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

const SERVICE_NAME = "ssp-ken-burns-rnd";
const SERVICE_VERSION = "0.4.0";

const s3 = new S3Client({
  region: AWS_REGION
});

// ─────────────────────────────────────────────────────────────
// BASIC HELPERS
// ─────────────────────────────────────────────────────────────

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
    makeSafePublicId(prospectId) ||
    "motion-test";

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

// ─────────────────────────────────────────────────────────────
// DOWNLOAD / UPLOAD
// ─────────────────────────────────────────────────────────────

async function downloadImage(url, outputPath) {
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

  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Expected image but received ${
        contentType || "unknown content type"
      }`
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

// ─────────────────────────────────────────────────────────────
// MOTION VALIDATION
// ─────────────────────────────────────────────────────────────

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

  if (
    start_zoom <= 0 ||
    end_zoom <= 0
  ) {
    return "start_zoom and end_zoom must be greater than 0";
  }

  for (
    const [name, value]
    of Object.entries({
      start_x,
      end_x,
      start_y,
      end_y
    })
  ) {
    if (
      value < 0 ||
      value > 1
    ) {
      return `${name} must be between 0 and 1`;
    }
  }

  if (
    ![
      "linear",
      "smoothstep"
    ].includes(easing)
  ) {
    return "easing must be linear or smoothstep";
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// MOTION FILTER
// ─────────────────────────────────────────────────────────────

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
    Math.max(
      2,
      Math.round(
        duration * fps
      )
    );

  const lastFrame =
    frames - 1;

  const progress =
    easing === "smoothstep"
      ? `(3*pow(min(on/${lastFrame},1),2)-2*pow(min(on/${lastFrame},1),3))`
      : `min(on/${lastFrame},1)`;

  const zoomDelta =
    end_zoom -
    start_zoom;

  const xDelta =
    end_x -
    start_x;

  const yDelta =
    end_y -
    start_y;

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

// ─────────────────────────────────────────────────────────────
// RENDER ONE MOTION SEGMENT TO LOCAL FILE
// ─────────────────────────────────────────────────────────────

async function renderMotionClipToFile({
  inputPath,
  outputPath,
  ...params
}) {
  const filter =
    buildMotionFilter(params);

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-map",
      "[outv]",
      "-t",
      String(params.duration),
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
      String(params.fps),
      outputPath
    ],
    {
      maxBuffer:
        20 *
        1024 *
        1024
    }
  );

  return outputPath;
}

// ─────────────────────────────────────────────────────────────
// EXISTING SINGLE-MOTION RENDER + UPLOAD
// ─────────────────────────────────────────────────────────────

async function renderMotionClip(params) {
  const workDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "ssp-rnd-"
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
      "motion.mp4"
    );

  try {
    await downloadImage(
      params.image_url,
      inputPath
    );

    await renderMotionClipToFile({
      inputPath,
      outputPath,
      ...params
    });

    const folder =
      makeProspectFolder(
        params.prospect_id,
        params.property_address
      );

    const outputName =
      makeSafePublicId(
        params.output_name ||
        "custom-motion"
      ) ||
      "custom-motion";

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

// ─────────────────────────────────────────────────────────────
// ATOMIC MOVEMENTS
//
// x/y use the existing normalized zoompan crop coordinates.
//
// IMPORTANT:
// Every next segment begins at the exact end zoom/x/y of the
// prior segment.
// ─────────────────────────────────────────────────────────────

const ATOMIC_MOTIONS = {

  // ─────────────────────────────────────────────────────────
  // SPEED-RAMP FAMILY
  // ─────────────────────────────────────────────────────────

  low_push: {
    label: "Low Push",
    zoom_delta: 0.07,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  // This is intentionally NOT static.
  //
  // During the "hold" beat, the image remains alive:
  // a tiny zoom creep + tiny diagonal float.
  //
  // It should feel like the camera breathes while the viewer
  // registers the staged room.
  float_hold: {
    label: "Float",
    zoom_delta: 0.015,
    x_delta: 0.012,
    y_delta: -0.008,
    easing: "smoothstep"
  },

  fast_push: {
    label: "Fast Push",
    zoom_delta: 0.18,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  fast_push_strong: {
    label: "Fast Push Strong",
    zoom_delta: 0.24,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  fast_diagonal_settle: {
    label: "Fast Diagonal Settle",
    zoom_delta: 0.10,
    x_delta: 0.18,
    y_delta: -0.12,
    easing: "smoothstep"
  },

  fast_diagonal_settle_soft: {
    label: "Fast Diagonal Settle Soft",
    zoom_delta: 0.08,
    x_delta: 0.14,
    y_delta: -0.09,
    easing: "smoothstep"
  },

  fast_push_diagonal: {
    label: "Fast Push Diagonal",
    zoom_delta: 0.15,
    x_delta: 0.14,
    y_delta: -0.08,
    easing: "smoothstep"
  },

  // ─────────────────────────────────────────────────────────
  // DIRECTION-CHANGE FAMILY
  // ─────────────────────────────────────────────────────────

  push: {
    label: "Push",
    zoom_delta: 0.18,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  // CORRECTED LABEL/DIRECTION MAPPING.
  //
  // The previous R&D version visually rendered these opposite
  // to the names. These values are now swapped to match what
  // the viewer actually sees.
  tilt_up: {
    label: "Tilt Up",
    zoom_delta: 0.00,
    x_delta: 0.00,
    y_delta: 0.24,
    easing: "smoothstep"
  },

  tilt_down: {
    label: "Tilt Down",
    zoom_delta: 0.00,
    x_delta: 0.00,
    y_delta: -0.24,
    easing: "smoothstep"
  },

  pan_left: {
    label: "Pan Left",
    zoom_delta: 0.00,
    x_delta: -0.24,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  pan_right: {
    label: "Pan Right",
    zoom_delta: 0.00,
    x_delta: 0.24,
    y_delta: 0.00,
    easing: "smoothstep"
  }
};

// ─────────────────────────────────────────────────────────────
// COMPOUND PRESETS
//
// TWO FAMILIES:
//
// 1. ramp3
//    staged image is ALREADY moving when wipe lands:
//
//      0.0–2.5s  low push
//      2.5–4.0s  float / breathing hold
//      4.0–6.0s  fast ramp-out
//
// 2. direction2
//
//      0.0–3.0s  first movement
//      3.0–6.0s  second movement / direction change
//
// ─────────────────────────────────────────────────────────────

const COMPOUND_PRESETS = {

  // ─────────────────────────────────────────────────────────
  // 3-PHASE SPEED-RAMP FAMILY
  //
  // Existing API keys retained so no Action/UI contract breaks.
  // ─────────────────────────────────────────────────────────

  hold_push: {
    label: "Low Push → Float → Fast Push",
    family: "ramp3",
    motions: [
      "low_push",
      "float_hold",
      "fast_push"
    ],
    durations: [
      2.5,
      1.5,
      2.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  hold_diagonal_settle: {
    label: "Low Push → Float → Fast Diagonal Settle",
    family: "ramp3",
    motions: [
      "low_push",
      "float_hold",
      "fast_diagonal_settle"
    ],
    durations: [
      2.5,
      1.5,
      2.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  push_diagonal_settle: {
    label: "Low Push → Float → Fast Push Diagonal",
    family: "ramp3",
    motions: [
      "low_push",
      "float_hold",
      "fast_push_diagonal"
    ],
    durations: [
      2.5,
      1.5,
      2.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  gentle_push_diagonal_settle: {
    label: "Low Push → Float → Soft Fast Diagonal",
    family: "ramp3",
    motions: [
      "low_push",
      "float_hold",
      "fast_diagonal_settle_soft"
    ],
    durations: [
      2.5,
      1.5,
      2.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  gentle_push_push: {
    label: "Low Push → Float → Strong Fast Push",
    family: "ramp3",
    motions: [
      "low_push",
      "float_hold",
      "fast_push_strong"
    ],
    durations: [
      2.5,
      1.5,
      2.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  // ─────────────────────────────────────────────────────────
  // 2-PHASE DIRECTION-CHANGE FAMILY
  // ─────────────────────────────────────────────────────────

  push_tilt_up: {
    label: "Push → Tilt Up",
    family: "direction2",
    motions: [
      "push",
      "tilt_up"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  push_tilt_down: {
    label: "Push → Tilt Down",
    family: "direction2",
    motions: [
      "push",
      "tilt_down"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  push_pan_left: {
    label: "Push → Pan Left",
    family: "direction2",
    motions: [
      "push",
      "pan_left"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  push_pan_right: {
    label: "Push → Pan Right",
    family: "direction2",
    motions: [
      "push",
      "pan_right"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.02,
    defaultStartX: 0.50,
    defaultStartY: 0.50
  },

  pan_left_push: {
    label: "Pan Left → Push",
    family: "direction2",
    motions: [
      "pan_left",
      "push"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.16,
    defaultStartX: 0.62,
    defaultStartY: 0.50
  },

  pan_right_push: {
    label: "Pan Right → Push",
    family: "direction2",
    motions: [
      "pan_right",
      "push"
    ],
    durations: [
      3.0,
      3.0
    ],
    defaultStartZoom: 1.16,
    defaultStartX: 0.38,
    defaultStartY: 0.50
  }
};

// ─────────────────────────────────────────────────────────────
// BUILD SEGMENT
// ─────────────────────────────────────────────────────────────

function buildCompoundSegment({
  motionKey,
  startState,
  duration,
  fps
}) {
  const motion =
    ATOMIC_MOTIONS[motionKey];

  if (!motion) {
    throw new Error(
      `Unknown atomic motion: ${motionKey}`
    );
  }

  return {
    motion_key:
      motionKey,

    motion_label:
      motion.label,

    duration,

    fps,

    easing:
      motion.easing,

    start_zoom:
      startState.zoom,

    end_zoom:
      startState.zoom +
      motion.zoom_delta,

    start_x:
      startState.x,

    end_x:
      startState.x +
      motion.x_delta,

    start_y:
      startState.y,

    end_y:
      startState.y +
      motion.y_delta
  };
}

// ─────────────────────────────────────────────────────────────
// BUILD ALL SEGMENTS WITH EXACT STATE HANDOFF
// ─────────────────────────────────────────────────────────────

function buildCompoundSegments({
  compound,
  initialState,
  fps,
  segmentDurationOverride
}) {
  const segments = [];
  let state = {
    ...initialState
  };

  for (
    let i = 0;
    i < compound.motions.length;
    i++
  ) {
    const motionKey =
      compound.motions[i];

    let duration =
      compound.durations[i];

    // Preserve the old segment_duration request behavior ONLY
    // for direction2 presets.
    //
    // The ramp3 family has intentional locked timings:
    // 2.5 + 1.5 + 2.0 = 6.0s.
    if (
      compound.family === "direction2" &&
      Number.isFinite(segmentDurationOverride) &&
      segmentDurationOverride > 0
    ) {
      duration =
        segmentDurationOverride;
    }

    const segment =
      buildCompoundSegment({
        motionKey,
        startState:
          state,
        duration,
        fps
      });

    const error =
      validateMotion(segment);

    if (error) {
      throw new Error(
        `Segment ${i + 1} invalid: ${error}`
      );
    }

    segments.push(
      segment
    );

    state = {
      zoom:
        segment.end_zoom,

      x:
        segment.end_x,

      y:
        segment.end_y
    };
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────
// HARD CONCAT ANY NUMBER OF SEGMENTS
//
// NO xfade.
// NO transition.
// NO overlap.
// ─────────────────────────────────────────────────────────────

async function concatMotionSegments({
  segmentPaths,
  outputPath,
  fps,
  totalDuration
}) {
  if (
    !Array.isArray(segmentPaths) ||
    segmentPaths.length < 2
  ) {
    throw new Error(
      "concatMotionSegments requires at least two segment paths"
    );
  }

  const args = [
    "-y"
  ];

  for (const segmentPath of segmentPaths) {
    args.push(
      "-i",
      segmentPath
    );
  }

  const filterParts = [];

  for (
    let i = 0;
    i < segmentPaths.length;
    i++
  ) {
    filterParts.push(
      `[${i}:v]setpts=PTS-STARTPTS[v${i}]`
    );
  }

  const inputs =
    segmentPaths
      .map(
        (_, i) =>
          `[v${i}]`
      )
      .join("");

  filterParts.push(
    `${inputs}concat=n=${segmentPaths.length}:v=1:a=0,fps=${fps}[outv]`
  );

  args.push(
    "-filter_complex",
    filterParts.join(";"),

    "-map",
    "[outv]",

    "-t",
    String(totalDuration),

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
    String(fps),

    outputPath
  );

  await execFileAsync(
    "ffmpeg",
    args,
    {
      maxBuffer:
        20 *
        1024 *
        1024
    }
  );

  return outputPath;
}

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    mode: "railway-rnd-test",
    storage: "s3",
    s3_configured:
      Boolean(AWS_S3_BUCKET),
    region: AWS_REGION,

    routes: [
      "GET /health",
      "POST /test-cinematic-motion",
      "POST /test-cinematic-motion-custom",
      "POST /test-compound-motion"
    ],

    compound_presets:
      Object.keys(
        COMPOUND_PRESETS
      )
  });
});

// ─────────────────────────────────────────────────────────────
// NAMED CINEMATIC PRESET TEST
// ─────────────────────────────────────────────────────────────

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
      preset =
        "cinematic_push_right",
      duration = 5,
      fps = 30,
      prospect_id =
        "motion-test",
      property_address = ""
    } = req.body || {};

    if (!image_url) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Missing image_url"
        });
    }

    if (!presets[preset]) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            `Unknown preset: ${preset}`
        });
    }

    const p =
      presets[preset];

    const params = {
      image_url,
      output_name: preset,
      prospect_id,
      property_address,
      duration:
        Number(duration),
      fps:
        Number(fps),
      ...p
    };

    const error =
      validateMotion(params);

    if (error) {
      return res
        .status(400)
        .json({
          success: false,
          error
        });
    }

    try {
      const upload =
        await renderMotionClip(
          params
        );

      return res.json({
        success: true,

        video_url:
          upload.url,

        public_id:
          upload.key,

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
            x:
              params.start_x,
            y:
              params.start_y
          },

          end_focal_position: {
            x:
              params.end_x,
            y:
              params.end_y
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

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.message ||
            "Preset render failed"
        });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// CUSTOM SINGLE-MOTION TEST
// ─────────────────────────────────────────────────────────────

app.post(
  "/test-cinematic-motion-custom",
  async (req, res) => {

    const {
      image_url,
      output_name =
        "custom-motion",
      duration = 5,
      fps = 30,
      easing = "linear",
      start_zoom,
      end_zoom,
      start_x,
      end_x,
      start_y,
      end_y,
      prospect_id =
        "motion-test",
      property_address = ""
    } = req.body || {};

    if (!image_url) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Missing image_url"
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
      return res
        .status(400)
        .json({
          success: false,
          error
        });
    }

    try {

      const upload =
        await renderMotionClip(
          params
        );

      return res.json({
        success: true,

        video_url:
          upload.url,

        public_id:
          upload.key,

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
            x:
              params.start_x,
            y:
              params.start_y
          },

          end_focal_position: {
            x:
              params.end_x,
            y:
              params.end_y
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

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.message ||
            "Custom render failed"
        });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// COMPOUND MOTION TEST
// ─────────────────────────────────────────────────────────────

app.post(
  "/test-compound-motion",
  async (req, res) => {

    const body =
      req.body || {};

    const image_url =
      body.image_url;

    const preset =
      body.preset ||
      "hold_push";

    const output_name =
      body.output_name;

    const frameRate =
      Number(
        body.fps ??
        30
      );

    const requestedSegmentDuration =
      body.segment_duration === undefined
        ? undefined
        : Number(
            body.segment_duration
          );

    const prospect_id =
      body.prospect_id ||
      "motion-test";

    const property_address =
      body.property_address ||
      "";

    if (!image_url) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Missing image_url"
        });
    }

    const compound =
      COMPOUND_PRESETS[preset];

    if (!compound) {
      return res
        .status(400)
        .json({
          success: false,

          error:
            `Unknown compound preset "${preset}". ` +
            `Available presets: ${Object.keys(
              COMPOUND_PRESETS
            ).join(", ")}`
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
          success: false,
          error:
            "fps must be greater than 0"
        });
    }

    if (
      requestedSegmentDuration !== undefined &&
      (
        !Number.isFinite(
          requestedSegmentDuration
        ) ||
        requestedSegmentDuration <= 0
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "segment_duration must be greater than 0"
        });
    }

    const initialZoom =
      Number(
        body.start_zoom ??
        compound.defaultStartZoom
      );

    const initialX =
      Number(
        body.start_x ??
        compound.defaultStartX
      );

    const initialY =
      Number(
        body.start_y ??
        compound.defaultStartY
      );

    if (
      !Number.isFinite(
        initialZoom
      ) ||
      initialZoom <= 0
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "start_zoom must be greater than 0"
        });
    }

    if (
      !Number.isFinite(
        initialX
      ) ||
      initialX < 0 ||
      initialX > 1
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "start_x must be between 0 and 1"
        });
    }

    if (
      !Number.isFinite(
        initialY
      ) ||
      initialY < 0 ||
      initialY > 1
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "start_y must be between 0 and 1"
        });
    }

    const initialState = {
      zoom:
        initialZoom,

      x:
        initialX,

      y:
        initialY
    };

    let segments;

    try {
      segments =
        buildCompoundSegments({
          compound,
          initialState,
          fps:
            frameRate,
          segmentDurationOverride:
            requestedSegmentDuration
        });
    } catch (error) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            error.message
        });
    }

    const totalDuration =
      segments.reduce(
        (sum, segment) =>
          sum +
          segment.duration,
        0
      );

    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ssp-compound-rnd-"
        )
      );

    const inputPath =
      path.join(
        workDir,
        "input.jpg"
      );

    const finalPath =
      path.join(
        workDir,
        "compound.mp4"
      );

    const finalOutputName =
      makeSafePublicId(
        output_name ||
        preset
      ) ||
      preset;

    try {

      console.log(
        `[RND COMPOUND] Starting ${preset}`
      );

      console.log(
        `[RND COMPOUND] ${compound.label}`
      );

      console.log(
        `[RND COMPOUND] Family: ${compound.family}`
      );

      console.log(
        `[RND COMPOUND] Initial: zoom=${initialState.zoom.toFixed(4)} x=${initialState.x.toFixed(4)} y=${initialState.y.toFixed(4)}`
      );

      await downloadImage(
        image_url,
        inputPath
      );

      const segmentPaths = [];

      let currentTime =
        0;

      for (
        let i = 0;
        i < segments.length;
        i++
      ) {
        const segment =
          segments[i];

        const outputPath =
          path.join(
            workDir,
            `segment-${i + 1}.mp4`
          );

        console.log(
          `[RND COMPOUND] Segment ${i + 1}: ${segment.motion_label} ` +
          `${currentTime.toFixed(1)}-${(
            currentTime +
            segment.duration
          ).toFixed(1)}s ` +
          `start(z=${segment.start_zoom.toFixed(4)},x=${segment.start_x.toFixed(4)},y=${segment.start_y.toFixed(4)}) ` +
          `end(z=${segment.end_zoom.toFixed(4)},x=${segment.end_x.toFixed(4)},y=${segment.end_y.toFixed(4)})`
        );

        await renderMotionClipToFile({
          inputPath,
          outputPath,
          ...segment
        });

        segmentPaths.push(
          outputPath
        );

        currentTime +=
          segment.duration;
      }

      await concatMotionSegments({
        segmentPaths,
        outputPath:
          finalPath,
        fps:
          frameRate,
        totalDuration
      });

      const folder =
        makeProspectFolder(
          prospect_id,
          property_address
        );

      const key =
        `ssp-prospects/${folder}/tests/${finalOutputName}.mp4`;

      const upload =
        await uploadVideo(
          finalPath,
          key
        );

      console.log(
        `[RND COMPOUND] Uploaded: ${upload.key}`
      );

      let timelineCursor =
        0;

      const renderSegments =
        segments.map(
          (
            segment,
            index
          ) => {
            const startTime =
              timelineCursor;

            const endTime =
              startTime +
              segment.duration;

            timelineCursor =
              endTime;

            return {
              index:
                index + 1,

              motion:
                segment.motion_key,

              label:
                segment.motion_label,

              start_time:
                startTime,

              end_time:
                endTime,

              duration:
                segment.duration,

              easing:
                segment.easing,

              start_zoom:
                segment.start_zoom,

              end_zoom:
                segment.end_zoom,

              start_focal_position: {
                x:
                  segment.start_x,

                y:
                  segment.start_y
              },

              end_focal_position: {
                x:
                  segment.end_x,

                y:
                  segment.end_y
              }
            };
          }
        );

      const finalSegment =
        segments[
          segments.length - 1
        ];

      return res.json({
        success: true,

        video_url:
          upload.url,

        public_id:
          upload.key,

        render: {
          route:
            "/test-compound-motion",

          preset,

          label:
            compound.label,

          family:
            compound.family,

          output_name:
            finalOutputName,

          duration:
            totalDuration,

          fps:
            frameRate,

          concat:
            "hard",

          transition:
            "none",

          width:
            1920,

          height:
            1080,

          initial_state: {
            zoom:
              initialState.zoom,

            x:
              initialState.x,

            y:
              initialState.y
          },

          segments:
            renderSegments,

          final_state: {
            zoom:
              finalSegment.end_zoom,

            x:
              finalSegment.end_x,

            y:
              finalSegment.end_y
          }
        }
      });

    } catch (error) {

      console.error(
        "[RND COMPOUND] Render failed:",
        error.stderr ||
        error.message ||
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          error:
            error.message ||
            "Compound motion render failed"
        });

    } finally {

      try {
        fs.rmSync(
          workDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch (cleanupError) {

        console.error(
          "[RND COMPOUND] Cleanup failed:",
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
  "0.0.0.0",
  () => {

    console.log(
      `${SERVICE_NAME} v${SERVICE_VERSION} listening on port ${PORT}`
    );

    console.log(
      `[RND] Named route: /test-cinematic-motion`
    );

    console.log(
      `[RND] Custom route: /test-cinematic-motion-custom`
    );

    console.log(
      `[RND] Compound route: /test-compound-motion`
    );

    console.log(
      `[RND] Compound presets: ${Object.keys(
        COMPOUND_PRESETS
      ).join(", ")}`
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
