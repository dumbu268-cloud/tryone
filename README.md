# TryOne — AI Virtual Try-On

A web-based AI virtual try-on **Live Mirror**: turn on your camera and see a clothing
design rendered onto your body in real time. The goal is a *convincing visual*, not
physical fit simulation.

> **Status: Phase 1 — Live Mirror Foundation.**
> Pipeline: `Camera → Body Perception → PoseFrame → Garment Fitting → Real-time Rendering`.
> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and roadmap.

## What Phase 1 does

- Opens the front camera with a mirrored preview.
- Perceives the body in real time (MediaPipe pose landmarks + multiclass segmentation).
- Builds a smoothed `PoseFrame` (jitter reduced with a One-Euro filter).
- Fits **one bundled t-shirt** to the torso with a homography-based mesh warp — it
  follows movement, scale/distance, and torso tilt/rotation (not a static sticker).
- Composites everything on a WebGL2 canvas with basic occlusion (hair/neck + forearms
  drawn back over the garment).
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

## Testing notes

Automated tests cover the pure logic (filters, homography, fitting) plus a headless
Playwright boot test (fake camera) and a one-shot perception test against a sample
image. **Live-with-a-real-person tracking must be verified in a real browser with a
webcam** — a headless sandbox has no camera or human subject.
