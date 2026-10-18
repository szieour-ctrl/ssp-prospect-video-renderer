"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { PRESETS, validate, buildFilterGraph } = require("./vortex-warp");

const execFileAsync = promisify(execFile);
const REGION = process.env.AWS_REGION || "us-east-2";
const BUCKET = process.env.AWS_S3_BUCKET;
const s3 = new S3Client({ region: REGION });

async function getImage(url, destination) {
  const response = await axios.get(url, {
    responseType: "arraybuffer", timeout: 30000, maxContentLength: 20 * 1024 * 1024
  });
  if (!String(response.headers["content-type"] || "").startsWith("image/")) {
    throw new Error("Input URL did not return an image");
  }
  await fs.promises.writeFile(destination, response.data);
}

function safe(value) {
  return String(value || "transition").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 80);
}

module.exports = function registerTransitionRoutes(app) {
  app.get("/rnd-transition-presets", (_request, response) => response.json({
    success: true, presets: PRESETS, version: "0.5.0", status: "R&D spiral warp"
  }));

  app.post("/test-transition", async (request, response) => {
    let params;
    try { params = validate(request.body || {}); }
    catch (error) { return response.status(400).json({ success: false, error: error.message }); }
    if (!BUCKET) return response.status(503).json({ success: false, error: "AWS_S3_BUCKET is not configured" });

    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ssp-transition-"));
    try {
      const imageA = path.join(directory, "coastal.jpg");
      const imageB = path.join(directory, "transitional.jpg");
      const output = path.join(directory, "transition.mp4");
      await Promise.all([
        getImage(request.body.image_a_url, imageA),
        getImage(request.body.image_b_url, imageB)
      ]);
      const render = buildFilterGraph(params);
      const firstSeconds = (1 + params.duration).toFixed(3);
      const secondSeconds = (2 + params.duration).toFixed(3);
      const args = [
        "-y", "-filter_complex_threads", "1",
        "-loop", "1", "-framerate", String(params.fps), "-t", firstSeconds, "-i", imageA,
        "-loop", "1", "-framerate", String(params.fps), "-t", secondSeconds, "-i", imageB,
        "-filter_complex", render.graph, "-map", "[outv]", "-t", render.total,
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", output
      ];
      await execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024, timeout: 180000 });
      const key = "ssp-prospects/" + safe(request.body.prospect_id || "transition-rnd") +
        "/tests/" + safe(request.body.output_name || params.preset) + "-" + Date.now() + ".mp4";
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: fs.createReadStream(output), ContentType: "video/mp4"
      }));
      const videoUrl = "https://" + BUCKET + ".s3." + REGION + ".amazonaws.com/" +
        key.split("/").map(encodeURIComponent).join("/");
      response.json({
        success: true, video_url: videoUrl, public_id: key,
        render: {
          preset: params.preset, duration: params.duration, aspect_ratio: params.aspect,
          render_width: render.width, render_height: render.height, fps: params.fps,
          intensity: params.strength,
          shake_px: params.preset === "liquid_wormhole_impact" ? params.shake : 0,
          transition_midpoint_seconds: Number((params.duration / 2).toFixed(3)),
          status: "spiral warp with inward collapse and outward reveal; no opaque wipe"
        }
      });
    } catch (error) {
      console.error("[TRANSITION RND]", error.stderr || error.message);
      response.status(500).json({ success: false, error: error.message });
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
};
