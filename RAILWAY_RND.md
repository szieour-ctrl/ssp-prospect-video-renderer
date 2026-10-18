# SSP Ken Burns R&D — Railway Test Deployment

Deploy **branch:** `test/railway-ken-burns-rnd`

This branch is intentionally isolated from the production prospect renderer. `npm start` launches `server-rnd.js`, which exposes only the R&D motion routes plus health status.

## Required Railway variables

- `AWS_REGION` — normally `us-east-2`
- `AWS_S3_BUCKET` — SSP media bucket name
- AWS credentials/role variables already used by the existing renderer service

Railway supplies `PORT`; do not hard-code it.

## Health check

Railway is configured via `railway.toml` to check:

`GET /health`

Expected response includes:

- `status: "ok"`
- `service: "ssp-ken-burns-rnd"`
- `mode: "railway-rnd-test"`
- `s3_configured: true`
- route list containing `/test-cinematic-motion-custom`

## R&D routes

### Liquid Wormhole classic and spiral-warp prototype

`GET /rnd-transition-presets` returns the existing `liquid_wormhole` and `liquid_wormhole_impact` presets plus `liquid_wormhole_classic`. The classic preset restores the exact pre-PR #1 v3 FFmpeg graph recovered from commit `fbc96753a9246fe5dd007fea490d5084822a011d`; the two existing preset names continue to use the separate spiral-warp implementation.

Classic requests accept the same image, duration, FPS, aspect, intensity, and zero-shake fields, plus `peak_darken` (0.00–0.15, additional to the original v3 midpoint dip), `darken_peak_time` (0–1 fraction of the transition, default 0.50), and `darken_curve` (`smooth`). A zero `peak_darken` reproduces the recovered v3 filter graph exactly. The optional extra dip uses a smooth Gaussian curve centered at the selected time and returns to full baseline brightness afterward. Both 9:16 and 16:9 are supported.

`POST /test-transition` keeps the existing Action field names: `image_a_url`, `image_b_url`, `duration`, `fps`, `aspect_ratio`, `intensity`, `shake_px`, `origin_x`, and `origin_y`. For the classic preset, include the three optional darkening controls. The spiral-warp behavior remains on `liquid_wormhole` and `liquid_wormhole_impact`; it is implemented with clamped 16-bit coordinate maps and an inward collapse/outward reveal.

Bent Tree Coastal and Transitional primary-bedroom comparisons use 1.0 second, 30 FPS, 9:16 (1080 × 1920), intensity 0.65, and zero shake. A is the original v3 baseline; B and C add 8% and 12% smooth peak darkening. Automated regression tests compare the zero-additional-darkening graph against the recovered v3 function and retain all vortex regressions. Run them with `npm test`.

The R&D branch does not change production `server.js`, Ken Burns, compound motion, S3 handling, or production deployment routes.


### Fixed preset

`POST /test-cinematic-motion`

Current preset: `cinematic_push_right`

### Parameter-driven custom motion

`POST /test-cinematic-motion-custom`

Example request:

```json
{
  "image_url": "https://example.com/room.jpg",
  "output_name": "living-room-v1",
  "duration": 5,
  "fps": 30,
  "easing": "linear",
  "start_zoom": 1.02,
  "end_zoom": 1.30,
  "start_x": 0.34,
  "end_x": 0.62,
  "start_y": 0.55,
  "end_y": 0.48,
  "prospect_id": "kb-rnd-001",
  "property_address": "123 Main St"
}
```

Successful renders upload to:

`ssp-prospects/{prospectFolder}/tests/{output_name}.mp4`

The response returns both `video_url` and `public_id`.

## Custom GPT connection

After Railway deployment succeeds:

1. Open the Railway public domain and verify `/health`.
2. Copy the Railway base URL.
3. Replace `https://YOUR-RENDERER-DOMAIN` in the Ken Burns R&D GPT Action schema with the Railway base URL.
4. Save the Action.
5. Run one fixed preset test first, then one custom-parameter test.

Do not merge this branch into `main` while motion R&D is active.
