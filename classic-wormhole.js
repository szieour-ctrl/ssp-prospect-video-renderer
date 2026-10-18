"use strict";

// Classic Liquid Wormhole v3, recovered from commit
// fbc96753a9246fe5dd007fea490d5084822a011d (before PR #1).
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function validateClassic(body = {}) {
  for (const name of ["image_a_url", "image_b_url"]) {
    try {
      const url = new URL(body[name]);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error(name + " must be a public HTTPS image URL");
    }
  }
  const duration = Number(body.duration ?? 0.9);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 1.5) {
    throw new Error("duration must be 0.5–1.5 seconds");
  }
  const fps = Number(body.fps ?? 30);
  if (![24, 30].includes(fps)) throw new Error("fps must be 24 or 30");
  const aspect = body.aspect_ratio || "9:16";
  if (!["9:16", "16:9"].includes(aspect)) throw new Error("aspect_ratio must be 9:16 or 16:9");
  const strength = Number(body.intensity ?? 0.65);
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("intensity must be 0–1");
  const shake = Number(body.shake_px ?? 0);
  if (!Number.isFinite(shake) || shake < 0 || shake > 35) throw new Error("shake_px must be 0–35");
  const originX = Number(body.origin_x ?? 0.5);
  const originY = Number(body.origin_y ?? 0.5);
  if (![originX, originY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("origin coordinates must be 0–1");
  }
  const peakDarken = Number(body.peak_darken ?? 0);
  if (!Number.isFinite(peakDarken) || peakDarken < 0 || peakDarken > 0.15) {
    throw new Error("peak_darken must be 0.00–0.15");
  }
  const darkenPeakTime = Number(body.darken_peak_time ?? 0.5);
  if (!Number.isFinite(darkenPeakTime) || darkenPeakTime < 0 || darkenPeakTime > 1) {
    throw new Error("darken_peak_time must be 0–1 within the transition");
  }
  const darkenCurve = body.darken_curve ?? "smooth";
  if (darkenCurve !== "smooth") throw new Error("darken_curve must be smooth");
  return {
    preset: "liquid_wormhole_classic", duration, fps, aspect, strength, shake,
    originX, originY, peakDarken, darkenPeakTime, darkenCurve
  };
}

// The peak_darken term is additive to the exact v3 baseline dip (-0.17).
// At zero, the resulting FFmpeg graph matches the recovered v3 graph exactly.
function buildClassicGraph(p) {
  const w = p.aspect === "9:16" ? 1080 : 1920;
  const h = p.aspect === "9:16" ? 1920 : 1080;
  const d = p.duration.toFixed(3);
  const total = (2 + p.duration).toFixed(3);
  const rotation = (0.045 * p.strength).toFixed(4);
  const cx = (p.originX * w).toFixed(1);
  const cy = (p.originY * h).toFixed(1);
  const a1 = "'" + rotation + "*exp(-20*max(t-1.40,0))*sin(75*max(t-1.40,0))*gte(t,1.40)'";
  const a2 = "'-" + rotation + "*exp(-20*max(t-0.40,0))*sin(75*max(t-0.40,0))*gte(t,0.40)'";
  const pad = 180, ww = w + 2 * pad, hh = h + 2 * pad;
  const prefix = (i, label, angle) => [
    "[" + i + ":v]fps=" + p.fps,
    "scale=" + ww + ":" + hh + ":force_original_aspect_ratio=increase",
    "crop=" + ww + ":" + hh,
    "setsar=1",
    "rotate=" + angle + ":c=black:ow=iw:oh=ih",
    "crop=" + w + ":" + h + ":" + pad + ":" + pad,
    "format=yuv420p[" + label + "]"
  ].join(",");
  const shake = p.shake;
  const start = (1 + p.duration * 0.42).toFixed(3);
  const nx = "'" + pad + "+" + shake.toFixed(2) + "*exp(-18*max(t-" + start + ",0))*sin(110*max(t-" + start + ",0))*gte(t," + start + ")'";
  const ny = "'" + pad + "+" + shake.toFixed(2) + "*0.60*exp(-18*max(t-" + start + ",0))*cos(94*max(t-" + start + ",0))*gte(t," + start + ")'";
  let brightness = "-0.17*exp(-pow((t-" + (1 + p.duration * 0.5).toFixed(3) + ")/" + (p.duration * 0.25).toFixed(3) + ",2))";
  if (p.peakDarken > 0) {
    const peak = (1 + p.duration * p.darkenPeakTime).toFixed(3);
    brightness += "-" + p.peakDarken.toFixed(4) + "*exp(-pow((t-" + peak + ")/" + (p.duration * 0.25).toFixed(3) + ",2))";
  }
  const graph = [
    prefix(0, "a", a1) + ";",
    prefix(1, "b", a2) + ";",
    "[a][b]xfade=transition=circleopen:duration=" + d + ":offset=1.000,",
    "pad=" + ww + ":" + hh + ":" + pad + ":" + pad + ":color=black,",
    "crop=" + w + ":" + h + ":x=" + nx + ":y=" + ny + ",",
    "eq=brightness='" + brightness + "':eval=frame,format=yuv420p[outv]"
  ].join("");
  return { graph, w, h, total, origin: { x: cx, y: cy } };
}

module.exports = { validateClassic, buildClassicGraph };
