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
const SERVICE_VERSION = "0.2.0";

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
        contentType ||
        "unknown content type"
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
// COMPOUND MOTION DEFINITIONS
//
// These are intentionally relative deltas.
//
// Segment 2 ALWAYS starts from segment 1's exact final:
//   zoom
//   x
//   y
//
// That is the seam-continuity contract.
// ─────────────────────────────────────────────────────────────

const ATOMIC_MOTIONS = {
  hold: {
    label: "Hold",
    zoom_delta: 0.04,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  gentle_push: {
    label: "Gentle Push",
    zoom_delta: 0.10,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  push: {
    label: "Push",
    zoom_delta: 0.22,
    x_delta: 0.00,
    y_delta: 0.00,
    easing: "smoothstep"
  },

  diagonal_settle: {
    label: "Diagonal Settle",
    zoom_delta: 0.15,
    x_delta: 0.08,
    y_delta: -0.05,
    easing: "smoothstep"
  }
};

const COMPOUND_PRESETS = {
  hold_push: {
    label: "Hold → Push",
    first: "hold",
    second: "push"
  },

  hold_diagonal_settle: {
    label: "Hold → Diagonal Settle",
    first: "hold",
    second: "diagonal_settle"
  },

  push_diagonal_settle: {
    label: "Push → Diagonal Settle",
    first: "push",
    second: "diagonal_settle"
  },

  gentle_push_diagonal_settle: {
    label: "Gentle Push → Diagonal Settle",
    first: "gentle_push",
    second: "diagonal_settle"
  },

  gentle_push_push: {
    label: "Gentle Push → Push",
    first: "gentle_push",
    second: "push"
  }
};

// ─────────────────────────────────────────────────────────────
// BUILD ONE COMPOUND SEGMENT FROM A START STATE
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

    duration:
      duration,

    fps:
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
// HARD CONCAT
//
// NO transition.
// NO xfade.
// NO overlap.
//
// Two rendered motion segments become one continuous MP4.
// ─────────────────────────────────────────────────────────────

async function concatMotionSegments({
  firstPath,
  secondPath,
  outputPath,
  fps,
  totalDuration
}) {
  const filter =
    `[0:v]setpts=PTS-STARTPTS[v0];` +
    `[1:v]setpts=PTS-STARTPTS[v1];` +
    `[v0][v1]concat=n=2:v=1:a=0,fps=${fps}[outv]`;

  await execFileAsync(
    "ffmpeg",
    [
      "-y",

      "-i",
      firstPath,

      "-i",
      secondPath,

      "-filter_complex",
      filter,

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

          width:
            1920,

          height:
            1080
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

          width:
            1920,

          height:
            1080
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
//
// Renders:
//   Segment 1
//   Segment 2
//
// Then concatenates them frame-to-frame.
//
// There is:
//   NO xfade
//   NO dissolve
//   NO overlap
//   NO transition
//
// Default timing:
//   0.0–3.0s segment 1
//   3.0–6.0s segment 2
//
// Segment 2 receives the exact:
//   end zoom
//   end x
//   end y
//
// from segment 1.
// ─────────────────────────────────────────────────────────────

app.post(
  "/test-compound-motion",
  async (req, res) => {
    const {
      image_url,

      preset =
        "hold_push",

      output_name,

      segment_duration = 3,

      fps = 30,

      start_zoom = 1.02,

      start_x = 0.50,

      start_y = 0.50,

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

    const segmentDuration =
      Number(
        segment_duration
      );

    const frameRate =
      Number(fps);

    const initialZoom =
      Number(start_zoom);

    const initialX =
      Number(start_x);

    const initialY =
      Number(start_y);

    if (
      !Number.isFinite(
        segmentDuration
      ) ||
      segmentDuration <= 0
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "segment_duration must be greater than 0"
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

    const totalDuration =
      segmentDuration * 2;

    const initialState = {
      zoom:
        initialZoom,

      x:
        initialX,

      y:
        initialY
    };

    const segment1 =
      buildCompoundSegment({
        motionKey:
          compound.first,

        startState:
          initialState,

        duration:
          segmentDuration,

        fps:
          frameRate
      });

    const segment1Error =
      validateMotion(
        segment1
      );

    if (segment1Error) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            `Segment 1 invalid: ${segment1Error}`
        });
    }

    // ───────────────────────────────────────────────────────
    // THE SEAM
    //
    // Segment 2 starts from EXACTLY the state where
    // segment 1 ends.
    // ───────────────────────────────────────────────────────

    const seamState = {
      zoom:
        segment1.end_zoom,

      x:
        segment1.end_x,

      y:
        segment1.end_y
    };

    const segment2 =
      buildCompoundSegment({
        motionKey:
          compound.second,

        startState:
          seamState,

        duration:
          segmentDuration,

        fps:
          frameRate
      });

    const segment2Error =
      validateMotion(
        segment2
      );

    if (segment2Error) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            `Segment 2 invalid: ${segment2Error}`
        });
    }

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

    const firstPath =
      path.join(
        workDir,
        "segment-1.mp4"
      );

    const secondPath =
      path.join(
        workDir,
        "segment-2.mp4"
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
        `[RND COMPOUND] Segment 1: ${compound.first}`
      );

      console.log(
        `[RND COMPOUND] Seam: zoom=${seamState.zoom.toFixed(
          4
        )} x=${seamState.x.toFixed(
          4
        )} y=${seamState.y.toFixed(
          4
        )}`
      );

      console.log(
        `[RND COMPOUND] Segment 2: ${compound.second}`
      );

      await downloadImage(
        image_url,
        inputPath
      );

      await renderMotionClipToFile({
        inputPath,
        outputPath:
          firstPath,

        ...segment1
      });

      await renderMotionClipToFile({
        inputPath,
        outputPath:
          secondPath,

        ...segment2
      });

      await concatMotionSegments({
        firstPath,
        secondPath,
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

          output_name:
            finalOutputName,

          duration:
            totalDuration,

          segment_duration:
            segmentDuration,

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

          segment_1: {
            motion:
              segment1.motion_key,

            label:
              segment1.motion_label,

            start_time:
              0,

            end_time:
              segmentDuration,

            duration:
              segmentDuration,

            easing:
              segment1.easing,

            start_zoom:
              segment1.start_zoom,

            end_zoom:
              segment1.end_zoom,

            start_focal_position: {
              x:
                segment1.start_x,

              y:
                segment1.start_y
            },

            end_focal_position: {
              x:
                segment1.end_x,

              y:
                segment1.end_y
            }
          },

          seam: {
            time:
              segmentDuration,

            zoom:
              seamState.zoom,

            x:
              seamState.x,

            y:
              seamState.y
          },

          segment_2: {
            motion:
              segment2.motion_key,

            label:
              segment2.motion_label,

            start_time:
              segmentDuration,

            end_time:
              totalDuration,

            duration:
              segmentDuration,

            easing:
              segment2.easing,

            start_zoom:
              segment2.start_zoom,

            end_zoom:
              segment2.end_zoom,

            start_focal_position: {
              x:
                segment2.start_x,

              y:
                segment2.start_y
            },

            end_focal_position: {
              x:
                segment2.end_x,

              y:
                segment2.end_y
            }
          },

          final_state: {
            zoom:
              segment2.end_zoom,

            x:
              segment2.end_x,

            y:
              segment2.end_y
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
