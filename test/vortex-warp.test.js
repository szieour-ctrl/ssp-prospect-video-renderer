"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PRESETS, validate, buildFilterGraph } = require("../vortex-warp");

const base = {
  image_a_url: "https://assets.example.test/coastal.jpg",
  image_b_url: "https://assets.example.test/transitional.jpg",
  duration: 1,
  fps: 30,
  aspect_ratio: "9:16",
  intensity: 0.65
};

test("keeps the existing Action preset names and test parameters", () => {
  assert.deepEqual(PRESETS, ["liquid_wormhole", "liquid_wormhole_impact"]);
  const a = validate({ ...base, preset: "liquid_wormhole" });
  const b = validate({ ...base, preset: "liquid_wormhole_impact", shake_px: 18 });
  assert.equal(a.duration, 1);
  assert.equal(a.fps, 30);
  assert.equal(a.aspect, "9:16");
  assert.equal(a.strength, 0.65);
  assert.equal(b.shake, 18);
});

test("rejects unsupported URLs, presets, frame rates, and impact shake", () => {
  assert.throws(() => validate({ ...base, image_a_url: "http://assets.example.test/a.jpg" }), /HTTPS/);
  assert.throws(() => validate({ ...base, preset: "circleopen" }), /Invalid preset/);
  assert.throws(() => validate({ ...base, fps: 60 }), /fps must be 24 or 30/);
  assert.throws(() => validate({ ...base, preset: "liquid_wormhole_impact", shake_px: 36 }), /shake_px/);
});

test("warps Coastal inward and Transitional outward at the transition midpoint", () => {
  const params = validate({ ...base, preset: "liquid_wormhole" });
  const result = buildFilterGraph(params);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.midpoint, 1.5); // transition starts at 1.0s; midpoint is +0.5s
  assert.match(result.graph, /xfade=transition=fade:duration=1\.000:offset=1\.000/);
  assert.equal((result.graph.match(/geq=lum=/g) || []).length, 4);
  assert.match(result.graph, /\(1-\(1-0\.1550\)\*/); // Coastal compresses to 15.5% at intensity 0.65
  assert.match(result.graph, /\(0\.1550\+\(1-0\.1550\)\*/); // Transitional opens from 15.5%
  assert.match(result.graph, /T-1\)\/0\.5/); // Coastal collapses during the first half
  assert.match(result.graph, /T-0\.5\)\/0\.5/); // Transitional opens during the second half on its local timeline
  assert.match(result.graph, /1-\(min\(max\(\(T-0\.5\)/); // Incoming twist unwinds as it opens
  assert.doesNotMatch(result.graph, /circleopen|circleclose|color=black|brightness=/);
});

test("Test B applies a damped 18-pixel impact jolt while Test A stays steady", () => {
  const a = buildFilterGraph(validate({ ...base, preset: "liquid_wormhole" })).graph;
  const b = buildFilterGraph(validate({ ...base, preset: "liquid_wormhole_impact", shake_px: 18 })).graph;
  assert.match(b, /18\*exp\(-12\*max\(t-1\.500,0\)\)/);
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /18\*exp/);
});
