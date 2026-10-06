# TryOne — AI Virtual Try-On

A web-based AI virtual try-on **Live Mirror**: turn on your camera and see a clothing
design rendered onto your body in real time. The goal is a *convincing visual*, not
physical fit simulation.

> **Status: Phase 2 — Convincing / Articulated Try-On.**
> Pipeline: `Camera → Body Perception → PoseFrame → Articulated Fitting → Real-time Rendering`.
> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and roadmap.

## What it does

- Opens the front camera with a mirrored preview.
- Perceives the body in real time (MediaPipe pose landmarks + multiclass segmentation).
- Builds a smoothed `PoseFrame` (jitter reduced with a One-Euro filter).
- Fits a garment with an **articulated, deformable mesh**:
  - the **torso** warps with your shoulders and hips (distance, tilt, twist, yaw);
  - each **sleeve follows your shoulder → elbow → wrist**, pinned at the armhole and
    tapering to the cuff, so it bends like worn fabric (not a rigid graphic);
  - untracked arms fall back to a stable hanging pose.
- Composites on a WebGL2 canvas with occlusion (clip to body, hide behind neck/hair,
  depth-ordered sleeves, bare-forearm repaint) and mild light harmonization.
- Ships two garments (**long-sleeve shirt**, **crew tee**) with a picker.
- Shows live FPS / inference / render-latency stats.

## Requirements

- Node.js 20+ (developed on Node 22)
- A modern Chromium-based browser is recommended (WebGL2; WebGPU used automatically if
  available). Firefox/Safari work via the WASM/WebGL fallback.
- A webcam.

## Getting started

```bash
npm install          # also copies the MediaPipe WASM runtime into public/
npm run setup:models # downloads the pose + segmentation models into public/models
npm run dev          # start the dev server, then open the printed URL
```

> The ML models (~15 MB) and the MediaPipe WASM runtime are **not committed**. They are
> fetched/copied locally by the setup scripts so the live camera feed never depends on a
> third-party CDN at runtime (better for privacy and latency).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Type-check only |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run Playwright boot/perception tests |
| `npm run setup` | Download models + copy WASM runtime |

## Project structure

```
src/
  core/
    math/         vec, one-euro filter, homography (pure, unit-tested)
    camera/       getUserMedia lifecycle
    perception/   MediaPipe pose + segmentation -> PoseFrame
    garment/      GarmentAsset model + loader (bundled SVG tee)
    engine/       TryOnEngine contract + MeshWarpEngine v0
    render/       WebGL2 compositor + shaders
    perf/         frame/latency/FPS metrics
    pipeline/     LiveMirror orchestrator (the hot loop, outside React)
    types.ts      shared contracts (PoseFrame, GarmentAsset, TryOnEngine, ...)
  state/          Zustand store (low-frequency UI state only)
  ui/             React UI shell (screen, controls, stats overlay)
```

## Testing

Unit tests (Vitest) cover the pure logic — One-Euro filter, homography solver, vector
math, and the `MeshWarpEngine` fitting geometry:

```bash
npm test
```

End-to-end tests (Playwright, headless Chromium with a fake camera + SwiftShader) cover:

- **boot** — the app starts, camera + models initialize, the render loop runs (FPS > 0),
  no runtime errors.
- **selftest** — the real `image → MediaPipe pose + segmentation → PoseFrame →
  MeshWarpEngine fit` pipeline against a still person image.
- **visual** — composites the garment onto that image and screenshots the WebGL output
  for review (`e2e/__artifacts__/tryon.png`).
- **perf** — prints measured live-loop metrics (informational).

```bash
npx playwright install chromium   # one-time
npm run test:e2e
```

> **Live-with-a-real-person tracking must be verified in a real browser with a webcam.**
> A headless sandbox has no camera or human subject, and SwiftShader software rendering
> makes inference far slower than real GPU hardware — the compositing cost (~1 ms),
> however, is representative.
