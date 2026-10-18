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

### Spiral-warp transition prototype (v5)

`GET /rnd-transition-presets` returns the existing preset names `liquid_wormhole` and `liquid_wormhole_impact`.

`POST /test-transition` keeps the existing Action field names: `image_a_url`, `image_b_url`, `duration`, `fps`, `aspect_ratio`, `intensity`, `shake_px`, `origin_x`, and `origin_y`. The Coastal image compresses into a spiral around the selected origin. The Transitional image starts compressed at the same point, then opens after the midpoint. The graph uses clamped 16-bit coordinate maps and a full-frame dissolve, without a circular matte or dark overlay. Test B uses a damped impact shift; the Bent Tree comparison uses `shake_px: 18`.

The Bent Tree regression inputs are the existing Coastal and Transitional primary-bedroom images. Comparison settings: 1.0 second, 30 FPS, 9:16 (1080 × 1920), intensity 0.65; maximum compression is at 0.5 seconds into the transition. Generated local renders are review-only and are not committed.

Run validation and regression tests with `npm test`. This code stays on the R&D branch; production `server.js`, Ken Burns, compound motion, and S3 behavior are unchanged.


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
