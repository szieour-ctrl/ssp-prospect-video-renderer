"use strict";

const PRESETS = Object.freeze(["liquid_wormhole", "liquid_wormhole_impact"]);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function validate(body = {}) {
  const preset = body.preset || "liquid_wormhole";
  if (!PRESETS.includes(preset)) throw new Error("Invalid preset");
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
  const shake = Number(body.shake_px ?? 18);
  if (!Number.isFinite(shake) || shake < 0 || shake > 35) throw new Error("shake_px must be 0–35");
  const originX = Number(body.origin_x ?? 0.5);
  const originY = Number(body.origin_y ?? 0.5);
  if (![originX, originY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("origin coordinates must be 0–1");
  }
  return { preset, duration, fps, aspect, strength, shake, originX, originY };
}

function smoothProgress(expr) {
  return `(${expr})*(${expr})*(3-2*(${expr}))`;
}

function warpExpressions({ width, height, mapWidth, mapHeight, fps, strength, phase, direction, originX, originY }) {
  const cx = (originX * width).toFixed(2);
  const cy = (originY * height).toFixed(2);
  const radius = Math.hypot(width, height) / 2;
  const raw = phase === "collapse"
    ? `min(max((T-1)/0.5,0),1)`
    : `min(max((T-0.5)/0.5,0),1)`;
  const p = smoothProgress(raw);
  const minimumScale = (0.22 - 0.1 * strength).toFixed(4);
  const scale = phase === "collapse"
    ? `(1-(1-${minimumScale})*${p})`
    : `(${minimumScale}+(1-${minimumScale})*${p})`;
  const xScale = (width / mapWidth).toFixed(6);
  const yScale = (height / mapHeight).toFixed(6);
  const x = `(X*${xScale})`;
  const y = `(Y*${yScale})`;
  const dx = `(${x}-${cx})`;
  const dy = `(${y}-${cy})`;
  const r = `min(1,hypot(${dx},${dy})/${radius.toFixed(2)})`;
  const twist = phase === "collapse" ? p : `(1-${p})`;
  const theta = `(atan2(${dy},${dx})+${direction}*${(2 * Math.PI * (1.1 + 0.9 * strength)).toFixed(5)}*${twist}*(1-${r}))`;
  const sourceRadius = `min(${radius.toFixed(2)},hypot(${dx},${dy})/${scale})`;
  const sx = `clip(${cx}+${sourceRadius}*cos(${theta}),0,${width - 1})`;
  const sy = `clip(${cy}+${sourceRadius}*sin(${theta}),0,${height - 1})`;
  return { x: sx, y: sy };
}

function buildFilterGraph(options, dimensions = {}) {
  const width = dimensions.width || (options.aspect === "9:16" ? 1080 : 1920);
  const height = dimensions.height || (options.aspect === "9:16" ? 1920 : 1080);
  const duration = options.duration;
  const pad = 64;
  const paddedWidth = width + 2 * pad;
  const paddedHeight = height + 2 * pad;
  const mapWidth = Math.max(2, Math.round(width / 4));
  const mapHeight = Math.max(2, Math.round(height / 4));
  const hit = 1 + duration / 2;
  const shake = options.preset === "liquid_wormhole_impact" ? options.shake : 0;
  const shift = localHit => {
    const x = `(${pad}+${shake}*exp(-12*max(t-${localHit.toFixed(3)},0))*cos(92*max(t-${localHit.toFixed(3)},0)))`;
    const y = `(${pad}+${shake}*0.72*exp(-12*max(t-${localHit.toFixed(3)},0))*sin(92*max(t-${localHit.toFixed(3)},0)+PI/2))`;
    return { x, y };
  };
  const mapFilters = (label, phase, direction) => {
    const map = warpExpressions({
      width, height, mapWidth, mapHeight, fps: options.fps, strength: options.strength, phase, direction,
      originX: options.originX, originY: options.originY
    });
    const source = `nullsrc=s=${mapWidth}x${mapHeight}:r=${options.fps}:d=${renderDuration},format=gray16le,geq`;
    const upscale = `,scale=${width}:${height}:flags=bilinear,format=gray16le`;
    return `${source}=lum='${map.x}'${upscale}[xmap${label}];${source}=lum='${map.y}'${upscale}[ymap${label}]`;
  };
  const input = (index, label) => {
    const localShift = shift(index === 0 ? hit : duration / 2);
    return `[${index}:v]fps=${options.fps},scale=${paddedWidth}:${paddedHeight}:force_original_aspect_ratio=increase,` +
      `crop=${paddedWidth}:${paddedHeight},setsar=1,` +
      `crop=${width}:${height}:x='${localShift.x}':y='${localShift.y}',format=yuv444p[${label}src];` +
      `[${label}src][xmap${label}][ymap${label}]remap[${label}]`;
  };
  const renderDuration = (2 + duration).toFixed(3);
  const graph = [
    mapFilters("coastal", "collapse", 1) + ";",
    mapFilters("transitional", "open", -1) + ";",
    input(0, "coastal") + ";",
    input(1, "transitional") + ";",
    `[coastal][transitional]xfade=transition=fade:duration=${duration.toFixed(3)}:offset=1.000,format=yuv420p[outv]`
  ].join("");
  return { graph, width, height, total: (2 + duration).toFixed(3), midpoint: hit };
}

module.exports = { PRESETS, validate, buildFilterGraph };
