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

  return `${getPacificRunDate(date)}-${safeStreetAddress}`;
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
// 30-SECOND PERSONALIZED PROSPECT VIDEO
// 2s intro + 9s interior + 9s exterior + 10s reusable CTA
// ElevenLabs v3 narration + burned-in ASS captions + music ducking
// ─────────────────────────────────────────────────────────────

function ensure30sConfigured() {
  const required = [
    "CTA_TEMPLATE_URL",
    "MUSIC_TRACK_URL",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID"
  ];

  const missing = required.filter(
    name => !process.env[name]
  );

  if (missing.length) {
    throw new Error(
      `Missing required 30s renderer variables: ${missing.join(", ")}`
    );
  }
}

async function downloadMedia(
  url,
  outputPath,
  allowedTypes = []
) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "arraybuffer",
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: status =>
      status >= 200 &&
      status < 300
  });

  const contentType =
    String(
      response.headers["content-type"] ||
      ""
    ).toLowerCase();

  if (
    allowedTypes.length &&
    !allowedTypes.some(type =>
      contentType.startsWith(type)
    )
  ) {
    throw new Error(
      `Unexpected content type ${contentType || "unknown"} from ${url}`
    );
  }

  const buffer =
    Buffer.from(response.data);

  if (buffer.length < 1000) {
    throw new Error(
      `Downloaded media is unexpectedly small: ${buffer.length} bytes`
    );
  }

  await fs.promises.writeFile(
    outputPath,
    buffer
  );
}

async function getMediaDuration(filePath) {
  const {
    stdout
  } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ],
    {
      maxBuffer:
        5 *
        1024 *
        1024
    }
  );

  const duration =
    Number(
      String(stdout).trim()
    );

  if (
    !Number.isFinite(duration)
  ) {
    throw new Error(
      `Could not determine media duration for ${filePath}`
    );
  }

  return duration;
}

function escapeAssText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function assTime(seconds) {
  const safe =
    Math.max(0, Number(seconds) || 0);

  const hours =
    Math.floor(safe / 3600);

  const minutes =
    Math.floor(
      (safe % 3600) / 60
    );

  const secs =
    safe % 60;

  return (
    `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`
  );
}

function getSpokenCharacters(alignment) {
  if (
    !alignment ||
    !Array.isArray(
      alignment.characters
    ) ||
    !Array.isArray(
      alignment.character_start_times_seconds
    ) ||
    !Array.isArray(
      alignment.character_end_times_seconds
    )
  ) {
    return [];
  }

  const result = [];
  let insideTag = false;

  for (
    let i = 0;
    i < alignment.characters.length;
    i += 1
  ) {
    const char =
      alignment.characters[i];

    if (char === "[") {
      insideTag = true;
      continue;
    }

    if (insideTag) {
      if (char === "]") {
        insideTag = false;
      }
      continue;
    }

    const start =
      Number(
        alignment.character_start_times_seconds[i]
      );

    const end =
      Number(
        alignment.character_end_times_seconds[i]
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      continue;
    }

    result.push({
      char,
      start,
      end
    });
  }

  return result;
}

function buildCaptionSegments(
  alignment,
  {
    maxWords = 7,
    maxChars = 46,
    maxDuration = 3.4
  } = {}
) {
  const chars =
    getSpokenCharacters(
      alignment
    );

  if (!chars.length) {
    return [];
  }

  const words = [];
  let current = null;

  function finishWord() {
    if (
      current &&
      current.text.trim()
    ) {
      words.push({
        text:
          current.text.trim(),
        start:
          current.start,
        end:
          current.end
      });
    }

    current = null;
  }

  for (const item of chars) {
    if (/\s/.test(item.char)) {
      finishWord();
      continue;
    }

    if (!current) {
      current = {
        text: "",
        start: item.start,
        end: item.end
      };
    }

    current.text += item.char;
    current.end =
      item.end;

    if (
      /[.!?]/.test(
        item.char
      )
    ) {
      finishWord();
    }
  }

  finishWord();

  const segments = [];
  let bucket = [];

  function flush() {
    if (!bucket.length) {
      return;
    }

    segments.push({
      text:
        bucket
          .map(word => word.text)
          .join(" "),
      start:
        bucket[0].start,
      end:
        bucket[
          bucket.length - 1
        ].end
    });

    bucket = [];
  }

  for (const word of words) {
    const candidate =
      [...bucket, word];

    const candidateText =
      candidate
        .map(item => item.text)
        .join(" ");

    const candidateDuration =
      candidate[
        candidate.length - 1
      ].end -
      candidate[0].start;

    const shouldFlush =
      bucket.length &&
      (
        candidate.length > maxWords ||
        candidateText.length > maxChars ||
        candidateDuration > maxDuration
      );

    if (shouldFlush) {
      flush();
    }

    bucket.push(word);

    if (
      /[.!?]$/.test(
        word.text
      ) &&
      bucket.length >= 2
    ) {
      flush();
    }
  }

  flush();

  return segments;
}

async function writeAssCaptions(
  filePath,
  segments
) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Property,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H80000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,130,130,105,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  const events =
    segments
      .map(segment => {
        const safeText =
          escapeAssText(
            segment.text
          );

        return `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Property,,0,0,0,,${safeText}`;
      })
      .join("\n");

  await fs.promises.writeFile(
    filePath,
    `${header}${events}\n`,
    "utf8"
  );
}

async function generateElevenLabsNarration({
  text,
  outputPath
}) {
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID;

  const modelId =
    process.env.ELEVENLABS_MODEL_ID ||
    "eleven_v3";

  const response =
    await axios({
      method: "POST",
      url:
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
      headers: {
        "xi-api-key":
          process.env.ELEVENLABS_API_KEY,
        "Content-Type":
          "application/json"
      },
      data: {
        text,
        model_id:
          modelId,
        apply_text_normalization:
          "auto"
      },
      timeout: 120000,
      maxContentLength:
        50 *
        1024 *
        1024
    });

  if (
    !response.data ||
    !response.data.audio_base64
  ) {
    throw new Error(
      "ElevenLabs did not return audio_base64"
    );
  }

  const audioBuffer =
    Buffer.from(
      response.data.audio_base64,
      "base64"
    );

  await fs.promises.writeFile(
    outputPath,
    audioBuffer
  );

  return {
    alignment:
      response.data.normalized_alignment ||
      response.data.alignment ||
      null,
    modelId
  };
}


function countSpokenTextCharacters(value) {
  const text =
    String(value || "");

  let insideTag = false;
  let count = 0;

  for (const char of text) {
    if (char === "[") {
      insideTag = true;
      continue;
    }

    if (insideTag) {
      if (char === "]") {
        insideTag = false;
      }
      continue;
    }

    count += 1;
  }

  return count;
}

function getCombinedNarrationSplitTime(
  alignment,
  firstNarrationText
) {
  const spoken =
    getSpokenCharacters(
      alignment
    );

  const firstCount =
    countSpokenTextCharacters(
      firstNarrationText
    );

  if (
    !spoken.length ||
    firstCount < 1
  ) {
    throw new Error(
      "Could not determine intro narration split point."
    );
  }

  const boundaryIndex =
    Math.min(
      firstCount,
      spoken.length - 1
    );

  const next =
    spoken[boundaryIndex];

  const previous =
    spoken[
      Math.max(
        0,
        boundaryIndex - 1
      )
    ];

  const split =
    next &&
    Number.isFinite(next.start)
      ? next.start
      : previous.end;

  if (
    !Number.isFinite(split) ||
    split <= 0
  ) {
    throw new Error(
      "Invalid intro narration split time."
    );
  }

  return split;
}

async function splitNarrationAudio({
  inputPath,
  splitTime,
  output1Path,
  output2Path
}) {
  await Promise.all([
    execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-t",
        String(splitTime),
        "-c:a",
        "pcm_s16le",
        output1Path
      ],
      {
        maxBuffer:
          20 *
          1024 *
          1024
      }
    ),

    execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(splitTime),
        "-i",
        inputPath,
        "-c:a",
        "pcm_s16le",
        output2Path
      ],
      {
        maxBuffer:
          20 *
          1024 *
          1024
      }
    )
  ]);
}

function splitCaptionSegments(
  segments,
  splitTime
) {
  const first = [];
  const second = [];

  for (const segment of segments) {
    if (
      segment.start <
      splitTime
    ) {
      first.push({
        text:
          segment.text,
        start:
          segment.start,
        end:
          Math.min(
            segment.end,
            splitTime
          )
      });
      continue;
    }

    second.push({
      text:
        segment.text,
      start:
        Math.max(
          0,
          segment.start -
          splitTime
        ),
      end:
        Math.max(
          0,
          segment.end -
          splitTime
        )
    });
  }

  return {
    first,
    second
  };
}

async function renderBrandIntro({
  propertyAddress,
  outputPath,
  fps = 30,
  duration = 2
}) {
  const safeAddress =
    escapeDrawtext(
      propertyAddress
    );

  const safeBrand =
    escapeDrawtext(
      "SMART STAGE PRO"
    );

  const safeSub =
    escapeDrawtext(
      "A QUICK LOOK AT THIS LISTING"
    );

  const filter =
    [
      "format=yuv420p",
      `drawtext=text='${safeBrand}':fontcolor=0xD4B87A:fontsize=38:x=(w-tw)/2:y=240`,
      `drawtext=text='${safeAddress}':fontcolor=white:fontsize=64:x=(w-tw)/2:y=420`,
      `drawtext=text='${safeSub}':fontcolor=0xB8975A:fontsize=25:x=(w-tw)/2:y=530`
    ].join(",");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x1a1714:s=1920x1080:r=${fps}:d=${duration}`,
      "-vf",
      filter,
      "-t",
      String(duration),
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
      outputPath
    ],
    {
      maxBuffer:
        20 *
        1024 *
        1024
    }
  );
}


function ensureElevenLabsPauseTail(value) {
  const text =
    String(value || "").trim();

  if (!text) {
    return "";
  }

  if (/\.\.\.\[pauses\]\s*$/i.test(text)) {
    return text;
  }

  const cleaned =
    text
      .replace(/\s*\[pauses\]\s*$/i, "")
      .replace(/[.…]+$/g, "")
      .trim();

  return `${cleaned}...[pauses]`;
}

async function renderDynamicIntroCard({
  variant,
  propertyAddress,
  card,
  narrationPath,
  captionsPath,
  outputPath,
  duration,
  fps = 30
}) {
  const safeBrand =
    escapeDrawtext("SMART STAGE PRO");

  const safeAddress =
    escapeDrawtext(propertyAddress);

  const safeSub =
    escapeDrawtext("A QUICK LOOK AT THIS LISTING");

  const filters = [
    "format=yuv420p",
    `drawtext=text='${safeBrand}':fontcolor=0xD4B87A:fontsize=38:x=(w-tw)/2:y=90`,
    `drawtext=text='${safeAddress}':fontcolor=white:fontsize=56:x=(w-tw)/2:y=175`,
    `drawtext=text='${safeSub}':fontcolor=0xB8975A:fontsize=25:x=(w-tw)/2:y=250`,
    "drawbox=x=180:y=305:w=1560:h=2:color=0x6b6259@0.7:t=fill"
  ];

  if (Number(variant) === 1) {
    const status =
      [card.occupancy_display, card.listing_type_display]
        .filter(Boolean)
        .join("  •  ");

    const specs =
      [
        card.year_built_display,
        card.beds_display,
        card.baths_display,
        card.sqft_display
      ]
        .filter(Boolean)
        .join("  •  ");

    const safeStatus =
      escapeDrawtext(status);

    const safeSpecs =
      escapeDrawtext(specs);

    const safeHighlight =
      escapeDrawtext(card.listing_highlight || "");

    filters.push(
      `drawtext=text='${safeStatus}':fontcolor=white:fontsize=44:x=(w-tw)/2:y=430`,
      `drawtext=text='${safeSpecs}':fontcolor=white:fontsize=34:x=(w-tw)/2:y=535`,
      `drawtext=text='${safeHighlight}':fontcolor=0xD4B87A:fontsize=36:x=(w-tw)/2:y=655`
    );
  } else {
    const safeInteriorOriginal =
      escapeDrawtext(card.interior_original_label || "");

    const safeInteriorFinal =
      escapeDrawtext(card.interior_final_label || "");

    const safeExteriorOriginal =
      escapeDrawtext(card.exterior_original_label || "");

    const exteriorFinalLabels =
      Array.isArray(card.exterior_final_labels)
        ? card.exterior_final_labels.slice(0, 3)
        : [card.exterior_final_label].filter(Boolean);

    filters.push(
      `drawtext=text='INTERIOR':fontcolor=0xD4B87A:fontsize=30:x=155:y=355`,
      `drawtext=text='ORIGINAL  •  ${safeInteriorOriginal}':fontcolor=white:fontsize=34:x=155:y=420`,
      `drawtext=text='FINAL     •  ${safeInteriorFinal}':fontcolor=white:fontsize=34:x=155:y=485`,
      `drawtext=text='EXTERIOR':fontcolor=0xD4B87A:fontsize=30:x=155:y=610`,
      `drawtext=text='ORIGINAL  •  ${safeExteriorOriginal}':fontcolor=white:fontsize=34:x=155:y=675`
    );

    exteriorFinalLabels.forEach((label, index) => {
      const safeLabel =
        escapeDrawtext(label);

      const prefix =
        index === 0
          ? "FINAL     •  "
          : "             ";

      filters.push(
        `drawtext=text='${prefix}${safeLabel}':fontcolor=white:fontsize=34:x=155:y=${740 + index * 58}`
      );
    });
  }

  const basePath =
    outputPath.replace(/\.mp4$/i, "-base.mp4");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x1a1714:s=1920x1080:r=${fps}:d=${duration}`,
      "-vf",
      filters.join(","),
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      basePath
    ],
    {
      maxBuffer:
        30 *
        1024 *
        1024
    }
  );

  const escapedAss =
    captionsPath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      basePath,
      "-i",
      narrationPath,
      "-filter_complex",
      `[0:v]ass='${escapedAss}'[v];[1:a]apad=pad_dur=1,atrim=0:${duration}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      maxBuffer:
        30 *
        1024 *
        1024
    }
  );
}

async function concatIntroCards({
  card1Path,
  card2Path,
  outputPath
}) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      card1Path,
      "-i",
      card2Path,
      "-filter_complex",
      "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      maxBuffer:
        40 *
        1024 *
        1024
    }
  );
}

async function renderBeforeAfter9s({
  beforePath,
  afterPath,
  outputPath,
  beforeLabel,
  afterLabel,
  fps = 30
}) {
  const beforeHold = 3;
  const transition = 1;
  const afterHold = 5;

  const beforeSourceDuration =
    beforeHold + transition;

  const afterSourceDuration =
    transition + afterHold;

  const beforeFrames =
    Math.round(
      beforeSourceDuration *
        fps
    );

  const afterFrames =
    Math.round(
      afterSourceDuration *
        fps
    );

  const safeBeforeLabel =
    escapeDrawtext(
      beforeLabel
    );

  const safeAfterLabel =
    escapeDrawtext(
      afterLabel
    );

  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,zoompan=z='min(zoom+0.00010,1.010)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${beforeFrames}:s=1920x1080:fps=${fps},drawtext=text='${safeBeforeLabel}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.55:boxborderw=16:x=55:y=h-th-55[beforev]`,
    `[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,zoompan=z='1+0.25*(3*pow(min(on/(5*${fps}),1),2)-2*pow(min(on/(5*${fps}),1),3))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${afterFrames}:s=1920x1080:fps=${fps},drawtext=text='${safeAfterLabel}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.55:boxborderw=16:x=55:y=h-th-55[afterv]`,
    `[beforev][afterv]xfade=transition=wipeleft:duration=${transition}:offset=${beforeHold}[outv]`
  ].join(";");

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
      "9",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      maxBuffer:
        30 *
        1024 *
        1024
    }
  );
}

async function renderFinal30s({
  introPath,
  interiorPath,
  exteriorPath,
  ctaPath,
  musicPath,
  narrationPath,
  captionsPath,
  outputPath,
  fps = 30
}) {
  const escapedAss =
    captionsPath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");

  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v0]`,
    `[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v1]`,
    `[2:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v2]`,
    `[3:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v3]`,
    "[v0][v1][v2][v3]concat=n=4:v=1:a=0[visual]",
    `[visual]ass='${escapedAss}'[video]`,
    "[4:a]atrim=0:30,asetpts=PTS-STARTPTS,volume=0.20[music]",
    "[5:a]apad=pad_dur=30,atrim=0:30,asetpts=PTS-STARTPTS,asplit=2[narr_sc][narr_mix]",
    "[music][narr_sc]sidechaincompress=threshold=0.012:ratio=8:attack=25:release=450[ducked]",
    "[ducked][narr_mix]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,atrim=0:30[aout]"
  ].join(";");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      introPath,
      "-i",
      interiorPath,
      "-i",
      exteriorPath,
      "-i",
      ctaPath,
      "-i",
      ctaNarrationPath,
      "-stream_loop",
      "-1",
      "-i",
      musicPath,
      "-i",
      narrationPath,
      "-filter_complex",
      filter,
      "-map",
      "[video]",
      "-map",
      "[aout]",
      "-t",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      maxBuffer:
        50 *
        1024 *
        1024
    }
  );
}


function ensureV2Configured() {
  const required = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID",
    "CTA_V2_TEMPLATE_URL",
    "CTA_V2_NARRATION_URL"
  ];

  if (
    !process.env.MUSIC_TRACK_V2_URL &&
    !process.env.MUSIC_TRACK_URL
  ) {
    required.push("MUSIC_TRACK_V2_URL");
  }

  const missing =
    required.filter(
      name => !process.env[name]
    );

  if (missing.length) {
    throw new Error(
      `Missing required V2 renderer variables: ${missing.join(", ")}`
    );
  }
}

async function mediaHasAudio(filePath) {
  try {
    const { stdout } =
      await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=index",
          "-of",
          "csv=p=0",
          filePath
        ],
        {
          maxBuffer:
            5 *
            1024 *
            1024
        }
      );

    return Boolean(
      String(stdout || "").trim()
    );
  } catch {
    return false;
  }
}

async function renderFinalV2({
  card1Path,
  card2Path,
  interiorPath,
  exteriorPath,
  ctaPath,
  ctaNarrationPath,
  musicPath,
  outputPath,
  card1Duration,
  card2Duration,
  ctaDuration,
  fps = 30
}) {
  const transformDuration = 18;
  const totalDuration =
    card1Duration +
    card2Duration +
    transformDuration +
    ctaDuration;

  const ctaStart =
    card1Duration +
    card2Duration +
    transformDuration;

  const musicFullLevel = 0.24;
  const musicDuckedLevel = 0.08;

  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v0]`,
    `[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v1]`,
    `[2:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v2]`,
    `[3:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v3]`,
    `[4:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${fps},setsar=1,setpts=PTS-STARTPTS[v4]`,
    "[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[video]",

    `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=1,atrim=0:${card1Duration},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=7,asplit=2[a0mix][a0sc]`,
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=1,atrim=0:${card2Duration},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=7,asplit=2[a1mix][a1sc]`,
    `anullsrc=r=48000:cl=stereo:d=${transformDuration}[transform_silence]`,
    `[5:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=1,atrim=0:${ctaDuration},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=7[a4]`,
    "[a0mix][a1mix][transform_silence][a4]concat=n=4:v=0:a=1[narration]",
    `anullsrc=r=48000:cl=stereo:d=${transformDuration + ctaDuration}[post_intro_silence]`,
    "[a0sc][a1sc][post_intro_silence]concat=n=3:v=0:a=1[intro_trigger]",
    `[6:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${totalDuration},asetpts=PTS-STARTPTS,volume='if(gte(t,${ctaStart}),${musicDuckedLevel},${musicFullLevel})':eval=frame[music]`,
    "[music][intro_trigger]sidechaincompress=threshold=0.012:ratio=8:attack=25:release=450[ducked]",
    `[ducked][narration]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,atrim=0:${totalDuration}[aout]`
  ].join(";");

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      card1Path,
      "-i",
      card2Path,
      "-i",
      interiorPath,
      "-i",
      exteriorPath,
      "-i",
      ctaPath,
      "-i",
      ctaNarrationPath,
      "-stream_loop",
      "-1",
      "-i",
      musicPath,
      "-filter_complex",
      filter,
      "-map",
      "[video]",
      "-map",
      "[aout]",
      "-t",
      String(totalDuration),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "21",
      "-maxrate",
      "1900k",
      "-bufsize",
      "3800k",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      maxBuffer:
        70 *
        1024 *
        1024
    }
  );

  return totalDuration;
}


app.post(
  "/render-prospect-video-30s",
  async (req, res) => {
    const {
      interior_before_image_url,
      interior_after_image_url,
      exterior_before_image_url,
      exterior_after_image_url,
      property_address,
      agent_first_name = "",
      agent_name = "",
      prospect_id = "prospect",
      mls_number = "",
      interior_room = "interior",
      exterior_enhancement = "exterior enhancement",
      narration_script,
      fps = 30
    } = req.body || {};

    const required = {
      interior_before_image_url,
      interior_after_image_url,
      exterior_before_image_url,
      exterior_after_image_url,
      property_address,
      narration_script
    };

    const missing =
      Object.entries(required)
        .filter(
          ([, value]) =>
            !String(value || "").trim()
        )
        .map(
          ([name]) => name
        );

    if (missing.length) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            `Missing required fields: ${missing.join(", ")}`
        });
    }

    const frameRate =
      Number(fps);

    if (
      !Number.isFinite(frameRate) ||
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
          "ssp-prospect-30s-"
        )
      );

    const paths = {
      interiorBefore:
        path.join(
          workDir,
          "interior-before.jpg"
        ),
      interiorAfter:
        path.join(
          workDir,
          "interior-after.jpg"
        ),
      exteriorBefore:
        path.join(
          workDir,
          "exterior-before.jpg"
        ),
      exteriorAfter:
        path.join(
          workDir,
          "exterior-after.jpg"
        ),
      cta:
        path.join(
          workDir,
          "cta.mp4"
        ),
      music:
        path.join(
          workDir,
          "music.mp3"
        ),
      narration:
        path.join(
          workDir,
          "narration.mp3"
        ),
      captions:
        path.join(
          workDir,
          "captions.ass"
        ),
      intro:
        path.join(
          workDir,
          "intro.mp4"
        ),
      interior:
        path.join(
          workDir,
          "interior.mp4"
        ),
      exterior:
        path.join(
          workDir,
          "exterior.mp4"
        ),
      output:
        path.join(
          workDir,
          "prospect-30s.mp4"
        )
    };

    try {
      ensure30sConfigured();
      ensureS3Configured();

      console.log(
        `[PROSPECT 30S] Starting render for ${prospectFolder}`
      );

      await Promise.all([
        downloadMedia(
          interior_before_image_url,
          paths.interiorBefore,
          ["image/"]
        ),
        downloadMedia(
          interior_after_image_url,
          paths.interiorAfter,
          ["image/"]
        ),
        downloadMedia(
          exterior_before_image_url,
          paths.exteriorBefore,
          ["image/"]
        ),
        downloadMedia(
          exterior_after_image_url,
          paths.exteriorAfter,
          ["image/"]
        ),
        downloadMedia(
          process.env.CTA_TEMPLATE_URL,
          paths.cta,
          ["video/"]
        ),
        downloadMedia(
          process.env.MUSIC_TRACK_V2_URL ||
          process.env.MUSIC_TRACK_URL,
          paths.music,
          ["audio/", "application/octet-stream"]
        )
      ]);

      const ctaDuration =
        await getMediaDuration(
          paths.cta
        );

      if (
        ctaDuration < 9.5 ||
        ctaDuration > 10.5
      ) {
        throw new Error(
          `CTA template must be approximately 10 seconds; received ${ctaDuration.toFixed(2)}s`
        );
      }

      const narration =
        await generateElevenLabsNarration({
          text:
            String(
              narration_script
            ),
          outputPath:
            paths.narration
        });

      const narrationDuration =
        await getMediaDuration(
          paths.narration
        );

      if (
        narrationDuration > 29.5
      ) {
        throw new Error(
          `Narration is too long for a 30-second render (${narrationDuration.toFixed(2)}s). Shorten the script.`
        );
      }

      const captionSegments =
        buildCaptionSegments(
          narration.alignment
        );

      await writeAssCaptions(
        paths.captions,
        captionSegments
      );

      await renderBrandIntro({
        propertyAddress:
          property_address,
        outputPath:
          paths.intro,
        fps:
          frameRate,
        duration:
          2
      });

      await renderBeforeAfter9s({
        beforePath:
          paths.interiorBefore,
        afterPath:
          paths.interiorAfter,
        outputPath:
          paths.interior,
        beforeLabel:
          "ORIGINAL LISTING PHOTO",
        afterLabel:
          "VIRTUALLY STAGED",
        fps:
          frameRate
      });

      await renderBeforeAfter9s({
        beforePath:
          paths.exteriorBefore,
        afterPath:
          paths.exteriorAfter,
        outputPath:
          paths.exterior,
        beforeLabel:
          "ORIGINAL EXTERIOR",
        afterLabel:
          String(
            exterior_enhancement ||
            "EXTERIOR ENHANCEMENT"
          ).toUpperCase(),
        fps:
          frameRate
      });

      await renderFinal30s({
        introPath:
          paths.intro,
        interiorPath:
          paths.interior,
        exteriorPath:
          paths.exterior,
        ctaPath:
          paths.cta,
        musicPath:
          paths.music,
        narrationPath:
          paths.narration,
        captionsPath:
          paths.captions,
        outputPath:
          paths.output,
        fps:
          frameRate
      });

      const videoKey =
        `ssp-prospects/${prospectFolder}/video-30s.mp4`;

      const upload =
        await uploadFileToS3({
          filePath:
            paths.output,
          key:
            videoKey,
          contentType:
            "video/mp4"
        });

      console.log(
        `[PROSPECT 30S] Uploaded to S3: ${upload.key}`
      );

      return res.json({
        success: true,
        video_url:
          upload.url,
        public_id:
          upload.key,
        prospect: {
          prospect_id,
          agent_first_name,
          agent_name,
          property_address,
          mls_number,
          interior_room,
          exterior_enhancement,
          run_date:
            prospectRunDate,
          folder_name:
            prospectFolder,
          storage_prefix:
            prospectStoragePrefix
        },
        render: {
          version:
            "ssp-prospect-30s-v1",
          output_duration:
            30,
          fps:
            frameRate,
          width:
            1920,
          height:
            1080,
          intro_duration:
            2,
          interior_duration:
            9,
          exterior_duration:
            9,
          cta_duration:
            Number(
              ctaDuration.toFixed(3)
            ),
          narration_duration:
            Number(
              narrationDuration.toFixed(3)
            ),
          caption_count:
            captionSegments.length,
          elevenlabs_model:
            narration.modelId,
          music_ducking:
            true,
          final_frame:
            "cta_hold_no_fade"
        }
      });
    } catch (error) {
      console.error(
        "[PROSPECT 30S] Render failed:",
        error.response?.data ||
          error.stderr ||
          error.message ||
          error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.response?.data?.detail ||
            error.message ||
            "30-second prospect video rendering failed"
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
          "[PROSPECT 30S] Cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
);



// ─────────────────────────────────────────────────────────────
// PROSPECT VIDEO V2
// Dynamic intro + 2 transformations + reusable CTA
// ─────────────────────────────────────────────────────────────

app.post(
  "/render-prospect-video-v2",
  async (req, res) => {
    const {
      prospect_id = "prospect",
      agent_first_name = "",
      agent_name = "",
      property_address = "",
      mls_number = "",
      campaign_tag = "",
      interior_before_image_url = "",
      interior_after_image_url = "",
      exterior_before_image_url = "",
      exterior_after_image_url = "",
      card_1 = {},
      card_2 = {},
      narration_card_1 = "",
      narration_card_2 = "",
      fps = 30
    } = req.body || {};

    const narration1 =
      ensureElevenLabsPauseTail(
        narration_card_1 ||
        card_1.narration
      );

    const narration2 =
      ensureElevenLabsPauseTail(
        narration_card_2 ||
        card_2.narration
      );

    const required = {
      prospect_id,
      property_address,
      interior_before_image_url,
      interior_after_image_url,
      exterior_before_image_url,
      exterior_after_image_url,
      narration_card_1:
        narration1,
      narration_card_2:
        narration2
    };

    const missing =
      Object.entries(required)
        .filter(
          ([, value]) =>
            !String(value || "").trim()
        )
        .map(([name]) => name);

    if (missing.length) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            `Missing required fields: ${missing.join(", ")}`
        });
    }

    const frameRate =
      Number(fps);

    if (
      !Number.isFinite(frameRate) ||
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
          "ssp-prospect-v2-"
        )
      );

    const paths = {
      interiorBefore:
        path.join(
          workDir,
          "interior-before.jpg"
        ),
      interiorAfter:
        path.join(
          workDir,
          "interior-after.jpg"
        ),
      exteriorBefore:
        path.join(
          workDir,
          "exterior-before.jpg"
        ),
      exteriorAfter:
        path.join(
          workDir,
          "exterior-after.jpg"
        ),
      cta:
        path.join(
          workDir,
          "cta-v2.mp4"
        ),
      ctaNarration:
        path.join(
          workDir,
          "cta-v2-narration.mp3"
        ),
      music:
        path.join(
          workDir,
          "music.mp3"
        ),
      narrationCombined:
        path.join(
          workDir,
          "narration-intro-combined.mp3"
        ),
      narration1:
        path.join(
          workDir,
          "narration-card-1.wav"
        ),
      narration2:
        path.join(
          workDir,
          "narration-card-2.wav"
        ),
      captions1:
        path.join(
          workDir,
          "captions-card-1.ass"
        ),
      captions2:
        path.join(
          workDir,
          "captions-card-2.ass"
        ),
      card1:
        path.join(
          workDir,
          "intro-card-1.mp4"
        ),
      card2:
        path.join(
          workDir,
          "intro-card-2.mp4"
        ),
      interior:
        path.join(
          workDir,
          "interior.mp4"
        ),
      exterior:
        path.join(
          workDir,
          "exterior.mp4"
        ),
      output:
        path.join(
          workDir,
          "prospect-v2.mp4"
        )
    };

    try {
      ensureV2Configured();
      ensureS3Configured();

      console.log(
        `[PROSPECT V2] Starting render for ${prospectFolder}`
      );

      await Promise.all([
        downloadMedia(
          interior_before_image_url,
          paths.interiorBefore,
          ["image/"]
        ),
        downloadMedia(
          interior_after_image_url,
          paths.interiorAfter,
          ["image/"]
        ),
        downloadMedia(
          exterior_before_image_url,
          paths.exteriorBefore,
          ["image/"]
        ),
        downloadMedia(
          exterior_after_image_url,
          paths.exteriorAfter,
          ["image/"]
        ),
        downloadMedia(
          process.env.CTA_V2_TEMPLATE_URL,
          paths.cta,
          ["video/", "application/octet-stream"]
        ),
        downloadMedia(
          process.env.CTA_V2_NARRATION_URL,
          paths.ctaNarration,
          ["audio/", "application/octet-stream"]
        ),
        downloadMedia(
          process.env.MUSIC_TRACK_V2_URL ||
          process.env.MUSIC_TRACK_URL,
          paths.music,
          ["audio/", "application/octet-stream"]
        )
      ]);

      const [
        ctaDuration,
        ctaNarrationDuration
      ] =
        await Promise.all([
          getMediaDuration(
            paths.cta
          ),
          getMediaDuration(
            paths.ctaNarration
          )
        ]);

      if (
        Math.abs(
          ctaNarrationDuration -
          ctaDuration
        ) > 1.5
      ) {
        throw new Error(
          `CTA narration duration (${ctaNarrationDuration.toFixed(2)}s) does not reasonably match CTA template duration (${ctaDuration.toFixed(2)}s).`
        );
      }

      const combinedNarrationText =
        `${narration1} ${narration2}`;

      const narrationResult =
        await generateElevenLabsNarration({
          text:
            combinedNarrationText,
          outputPath:
            paths.narrationCombined
        });

      const narrationSplitTime =
        getCombinedNarrationSplitTime(
          narrationResult.alignment,
          narration1
        );

      await splitNarrationAudio({
        inputPath:
          paths.narrationCombined,
        splitTime:
          narrationSplitTime,
        output1Path:
          paths.narration1,
        output2Path:
          paths.narration2
      });

      const [
        narrationDuration1,
        narrationDuration2
      ] =
        await Promise.all([
          getMediaDuration(
            paths.narration1
          ),
          getMediaDuration(
            paths.narration2
          )
        ]);

      const combinedCaptionSegments =
        buildCaptionSegments(
          narrationResult.alignment
        );

      const {
        first:
          captionSegments1,
        second:
          captionSegments2
      } =
        splitCaptionSegments(
          combinedCaptionSegments,
          narrationSplitTime
        );

      await Promise.all([
        writeAssCaptions(
          paths.captions1,
          captionSegments1
        ),
        writeAssCaptions(
          paths.captions2,
          captionSegments2
        )
      ]);

      const cardDuration1 =
        Number(
          (
            narrationDuration1 +
            0.4
          ).toFixed(3)
        );

      const cardDuration2 =
        Number(
          (
            narrationDuration2 +
            0.4
          ).toFixed(3)
        );

      await Promise.all([
        renderDynamicIntroCard({
          variant: 1,
          propertyAddress:
            property_address,
          card:
            card_1,
          narrationPath:
            paths.narration1,
          captionsPath:
            paths.captions1,
          outputPath:
            paths.card1,
          duration:
            cardDuration1,
          fps:
            frameRate
        }),

        renderDynamicIntroCard({
          variant: 2,
          propertyAddress:
            property_address,
          card:
            card_2,
          narrationPath:
            paths.narration2,
          captionsPath:
            paths.captions2,
          outputPath:
            paths.card2,
          duration:
            cardDuration2,
          fps:
            frameRate
        }),

        renderBeforeAfter9s({
          beforePath:
            paths.interiorBefore,
          afterPath:
            paths.interiorAfter,
          outputPath:
            paths.interior,
          beforeLabel:
            card_2.interior_original_label ||
            "ORIGINAL LISTING PHOTO",
          afterLabel:
            card_2.interior_final_label ||
            "VIRTUALLY STAGED",
          fps:
            frameRate
        }),

        renderBeforeAfter9s({
          beforePath:
            paths.exteriorBefore,
          afterPath:
            paths.exteriorAfter,
          outputPath:
            paths.exterior,
          beforeLabel:
            card_2.exterior_original_label ||
            "ORIGINAL EXTERIOR",
          afterLabel:
            (
              Array.isArray(
                card_2.exterior_final_labels
              ) &&
              card_2.exterior_final_labels.length
            )
              ? card_2.exterior_final_labels.join(" • ")
              : "EXTERIOR ENHANCEMENT",
          fps:
            frameRate
        })
      ]);

      const outputDuration =
        await renderFinalV2({
          card1Path:
            paths.card1,
          card2Path:
            paths.card2,
          interiorPath:
            paths.interior,
          exteriorPath:
            paths.exterior,
          ctaPath:
            paths.cta,
          ctaNarrationPath:
            paths.ctaNarration,
          musicPath:
            paths.music,
          outputPath:
            paths.output,
          card1Duration:
            cardDuration1,
          card2Duration:
            cardDuration2,
          ctaDuration,
          fps:
            frameRate
        });

      const videoKey =
        `ssp-prospects/${prospectFolder}/video-v2.mp4`;

      const upload =
        await uploadFileToS3({
          filePath:
            paths.output,
          key:
            videoKey,
          contentType:
            "video/mp4"
        });

      console.log(
        `[PROSPECT V2] Uploaded to S3: ${upload.key}`
      );

      return res.json({
        success: true,
        video_url:
          upload.url,
        public_id:
          upload.key,
        thumbnail_url:
          "",
        thumbnail_public_id:
          "",
        prospect: {
          prospect_id,
          agent_first_name,
          agent_name,
          property_address,
          mls_number,
          campaign_tag,
          run_date:
            prospectRunDate,
          folder_name:
            prospectFolder,
          storage_prefix:
            prospectStoragePrefix
        },
        render: {
          version:
            "ssp-prospect-v2",
          output_duration:
            Number(
              outputDuration.toFixed(3)
            ),
          intro_duration:
            Number(
              (
                cardDuration1 +
                cardDuration2
              ).toFixed(3)
            ),
          card_1_duration:
            cardDuration1,
          card_2_duration:
            cardDuration2,
          interior_duration:
            9,
          exterior_duration:
            9,
          cta_duration:
            Number(
              ctaDuration.toFixed(3)
            ),
          fps:
            frameRate,
          width:
            1920,
          height:
            1080,
          music_ducking:
            true,
          elevenlabs_model:
            narrationResult.modelId,
          intro_tts_mode:
            "single_generation_split",
          final_word_rule:
            "last word...[pauses]"
        }
      });
    } catch (error) {
      console.error(
        "[PROSPECT V2] Render failed:",
        error.response?.data ||
          error.stderr ||
          error.message ||
          error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.response?.data?.detail ||
            error.message ||
            "V2 prospect video rendering failed"
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
          "[PROSPECT V2] Cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────
// TEMP TEST: TWO-CARD DYNAMIC INTRO
// Development branch only.
// ─────────────────────────────────────────────────────────────

app.post(
  "/test-dynamic-intro",
  async (req, res) => {
    const {
      property_address = "",
      prospect_id = "prospect",
      agent_first_name = "",
      agent_name = "",
      mls_number = "",
      fps = 30,
      card_1 = {},
      card_2 = {},
      narration_card_1 = "",
      narration_card_2 = ""
    } = req.body || {};

    const narration1 =
      ensureElevenLabsPauseTail(
        narration_card_1 ||
        card_1.narration
      );

    const narration2 =
      ensureElevenLabsPauseTail(
        narration_card_2 ||
        card_2.narration
      );

    if (
      !property_address ||
      !narration1 ||
      !narration2
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "property_address, card 1 narration, and card 2 narration are required"
        });
    }

    const frameRate =
      Number(fps);

    if (
      !Number.isFinite(frameRate) ||
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

    const prospectFolder =
      makeProspectFolder(
        property_address
      );

    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ssp-dynamic-intro-"
        )
      );

    const paths = {
      narration1:
        path.join(
          workDir,
          "narration-card-1.mp3"
        ),
      narration2:
        path.join(
          workDir,
          "narration-card-2.mp3"
        ),
      captions1:
        path.join(
          workDir,
          "captions-card-1.ass"
        ),
      captions2:
        path.join(
          workDir,
          "captions-card-2.ass"
        ),
      card1:
        path.join(
          workDir,
          "intro-card-1.mp4"
        ),
      card2:
        path.join(
          workDir,
          "intro-card-2.mp4"
        ),
      final:
        path.join(
          workDir,
          "dynamic-intro-test.mp4"
        )
    };

    try {
      console.log(
        `[DYNAMIC INTRO TEST] Starting for ${prospectFolder}`
      );

      const [
        narrationResult1,
        narrationResult2
      ] =
        await Promise.all([
          generateElevenLabsNarration({
            text:
              narration1,
            outputPath:
              paths.narration1
          }),
          generateElevenLabsNarration({
            text:
              narration2,
            outputPath:
              paths.narration2
          })
        ]);

      const [
        narrationDuration1,
        narrationDuration2
      ] =
        await Promise.all([
          getMediaDuration(
            paths.narration1
          ),
          getMediaDuration(
            paths.narration2
          )
        ]);

      const captionSegments1 =
        buildCaptionSegments(
          narrationResult1.alignment
        );

      const captionSegments2 =
        buildCaptionSegments(
          narrationResult2.alignment
        );

      await Promise.all([
        writeAssCaptions(
          paths.captions1,
          captionSegments1
        ),
        writeAssCaptions(
          paths.captions2,
          captionSegments2
        )
      ]);

      const cardDuration1 =
        Number(
          (
            narrationDuration1 +
            0.4
          ).toFixed(3)
        );

      const cardDuration2 =
        Number(
          (
            narrationDuration2 +
            0.4
          ).toFixed(3)
        );

      await renderDynamicIntroCard({
        variant: 1,
        propertyAddress:
          property_address,
        card:
          card_1,
        narrationPath:
          paths.narration1,
        captionsPath:
          paths.captions1,
        outputPath:
          paths.card1,
        duration:
          cardDuration1,
        fps:
          frameRate
      });

      await renderDynamicIntroCard({
        variant: 2,
        propertyAddress:
          property_address,
        card:
          card_2,
        narrationPath:
          paths.narration2,
        captionsPath:
          paths.captions2,
        outputPath:
          paths.card2,
        duration:
          cardDuration2,
        fps:
          frameRate
      });

      await concatIntroCards({
        card1Path:
          paths.card1,
        card2Path:
          paths.card2,
        outputPath:
          paths.final
      });

      const outputKey =
        `ssp-prospects/${prospectFolder}/tests/dynamic-intro-v1.mp4`;

      const upload =
        await uploadFileToS3({
          filePath:
            paths.final,
          key:
            outputKey,
          contentType:
            "video/mp4"
        });

      const outputDuration =
        await getMediaDuration(
          paths.final
        );

      return res.json({
        success: true,
        video_url:
          upload.url,
        public_id:
          upload.key,
        prospect: {
          prospect_id,
          agent_first_name,
          agent_name,
          property_address,
          mls_number,
          folder_name:
            prospectFolder
        },
        intro: {
          output_duration:
            Number(
              outputDuration.toFixed(3)
            ),
          card_1_duration:
            cardDuration1,
          card_2_duration:
            cardDuration2,
          card_1_narration_duration:
            Number(
              narrationDuration1.toFixed(3)
            ),
          card_2_narration_duration:
            Number(
              narrationDuration2.toFixed(3)
            ),
          card_1_caption_count:
            captionSegments1.length,
          card_2_caption_count:
            captionSegments2.length,
          elevenlabs_model:
            narrationResult1.modelId,
          final_word_rule:
            "last word...[pauses]"
        }
      });
    } catch (error) {
      console.error(
        "[DYNAMIC INTRO TEST] Render failed:",
        error.response?.data ||
          error.stderr ||
          error.message ||
          error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error.response?.data?.detail ||
            error.message ||
            "Dynamic intro test render failed"
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
          "[DYNAMIC INTRO TEST] Cleanup failed:",
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
         x=(iw-160)/2:
         y=(ih-160)/2:
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
