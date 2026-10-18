"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PRESETS: VORTEX_PRESETS } = require("../vortex-warp");
const { validateClassic, buildClassicGraph } = require("../classic-wormhole");
const originalV3Filters = require("./fixtures/liquid-wormhole-v3-original");

const base = {
  image_a_url: "https://assets.example.test/coastal.jpg",
  image_b_url: "https://assets.example.test/transitional.jpg",
  duration: 1, fps: 30, intensity: 0.65, shake_px: 0
};

test("keeps vortex presets and adds classic as a separate preset", () => {
  assert.deepEqual(VORTEX_PRESETS, ["liquid_wormhole", "liquid_wormhole_impact"]);
  assert.equal(validateClassic(base).preset, "liquid_wormhole_classic");
});

test("zero additional darkening reproduces the original v3 graph", () => {
  const p = validateClassic({ ...base, aspect_ratio: "9:16", peak_darken: 0 });
  const { graph, w, h } = buildClassicGraph(p);
  assert.equal(w, 1080);
  assert.equal(h, 1920);
  assert.equal(graph, originalV3Filters({ ...p, preset: "liquid_wormhole", shake: 18 }).graph);
  assert.match(graph, /xfade=transition=circleopen:duration=1\.000:offset=1\.000/);
  assert.match(graph, /rotate=\'0\.0292\*exp\(-20\*max\(t-1\.40,0\)\)/);
  assert.match(graph, /eq=brightness='-0\.17\*exp\(-pow\(\(t-1\.500\)\/0\.250,2\)\)':eval=frame/);
  assert.doesNotMatch(graph, /vignette|color=black.*xfade|geq=lum/);
});

test("accepts the required 8% and 12% additional smooth dips around the selected midpoint", () => {
  for (const peak of [0.08, 0.12]) {
    const p = validateClassic({ ...base, aspect_ratio: "9:16", peak_darken: peak });
    const graph = buildClassicGraph(p).graph;
    assert.match(graph, new RegExp(`-${peak.toFixed(4)}\\*exp\\(-pow\\(\\(t-1\\.500\\)\\/0\\.250,2\\)\\)`));
  }
});

test("supports landscape and portrait output dimensions", () => {
  const portrait = buildClassicGraph(validateClassic({ ...base, aspect_ratio: "9:16" }));
  const landscape = buildClassicGraph(validateClassic({ ...base, aspect_ratio: "16:9" }));
  assert.deepEqual([portrait.w, portrait.h], [1080, 1920]);
  assert.deepEqual([landscape.w, landscape.h], [1920, 1080]);
});

test("validates darkening controls and keeps shake at zero", () => {
  assert.throws(() => validateClassic({ ...base, peak_darken: 0.16 }), /peak_darken/);
  assert.throws(() => validateClassic({ ...base, darken_peak_time: 1.1 }), /darken_peak_time/);
  assert.throws(() => validateClassic({ ...base, darken_curve: "hard" }), /darken_curve/);
  assert.equal(validateClassic(base).shake, 0);
});
