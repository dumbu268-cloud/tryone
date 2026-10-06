# AI Virtual Try-On — Architecture (Part 1)

> Status: **Design only.** No application code in this phase.
> Goal: *"Let me see how this clothing design looks on me"* — a convincing real-time visual, not physical fit simulation.

---

## 0. The decision everything hangs on (assumption challenge)

You asked for three things that **cannot all be true at the same time today**:

1. **Real-time** (live webcam video, ~30fps)
2. **In the browser** (no install, privacy-friendly)
3. **AI/diffusion-grade photorealism**

State-of-the-art AI try-on (CatVTON, IDM-VTON, CatV2TON) are **server-side GPU diffusion models that take seconds per image** — they are not, and will not soon be, 30fps-in-a-browser. Any product that promises "real-time photoreal AI try-on in the browser" is quietly lying about one of the three.

So I'm **not** building one engine. I'm building a **two-tier experience** and treating "which engine renders the garment" as a swappable seam:

| Tier | What | Where | Latency | Looks like |
|------|------|-------|---------|------------|
| **Live Mirror** (always on) | Geometric mesh-warp of the garment onto the tracked body | **Browser** | ~30fps | Convincing, not photoreal |
| **HD Snapshot** (on demand, *future*) | Diffusion try-on on a single captured frame | **Server GPU** | A few seconds | Photoreal |

This directly satisfies your requirement **#9 (quality vs. real-time)** and **#10 (add better models later)**: the live tier gives the instant "mirror" feel; the HD tier gives a share-worthy image when the user asks for it. They share one input contract, so better engines drop in without touching the camera/UI.

**Two more assumptions I'm pushing back on:**

- **"Paste any Amazon/shopping link and we auto-identify the garment."** Reliable scraping of arbitrary retailers is brittle, rate-limited, and ToS/legally sensitive. I will **not** make the whole product depend on it. URL resolution lives behind an adapter interface with an OpenGraph fallback and a **guaranteed** "paste image / upload" path underneath. When scraping fails (it will), the product still works.
- **Full 3D cloth simulation is the wrong tool.** It won't run real-time in-browser and you explicitly don't want physical fit accuracy. A **2.5D textured-mesh warp driven by pose landmarks** is the right level of effort. It's excellent front-facing and degrades gracefully on strong body rotation — an acceptable, stated limitation.

---

## 1. Recommended technology stack

### Client (does the real-time work)
- **React 18 + TypeScript + Vite** — fast, standard, professional, instant HMR.
- **Tailwind CSS** — clean UI quickly, no bespoke design system to maintain.
- **Zustand** — minimal state (camera status, active garment, settings). Redux would be over-engineering.
- **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`) — `PoseLandmarker` (33 landmarks, image + 3D world coords) + person segmentation. GPU (WebGL/WebGPU) delegate with WASM fallback. Runs fully client-side.
- **PixiJS v8** (WebGL2/WebGPU) — GPU compositing + deformable textured **Mesh** for the garment warp. Lighter than Three.js for a 2.5D job; keeps us off hand-rolled WebGL while leaving the escape hatch open.
- **Web Worker + OffscreenCanvas** — ML inference off the main thread so rendering never stutters.
- **One-Euro filter** — landmark smoothing (the difference between "jittery tech demo" and "convincing").

### Server (introduced only when phases need it)
- **Node.js + Fastify (TypeScript)** — API/orchestration: product resolution, garment-asset cache, serving prepared assets. Same language as the client = shared types.
- **Python GPU microservice (FastAPI)** — the ML-heavy work: garment background removal (BiRefNet / rembg), auto control-point detection, garment classification, and later diffusion try-on (CatVTON/IDM-VTON). Python owns this ecosystem; Node orchestrates, Python computes. **This split is the pluggability seam for better models.**
- **S3-compatible object storage + CDN** — prepared garment RGBA textures + control-point JSON, cached by normalized product id / image hash.
- **Transport: REST.** The live loop needs no server round-trip. WebSocket only later for HD-job progress.

---

## 2. Camera & real-time processing pipeline

```
getUserMedia → <video> → requestVideoFrameCallback (frame-accurate)
      │
      ├─► [Web Worker] MediaPipe: PoseLandmarker + person segmentation
      │        └─► PoseFrame { landmarks(image+world), personMask, confidence, ts }
      │
      └─► [Main thread / GPU] One-Euro smooth → TryOnEngine.render(PoseFrame, GarmentAsset)
                 → PixiJS: warp garment mesh → clip by personMask → harmonize color → composite over video
                 → draw to output canvas
```

- Inference runs in a worker; the render loop never blocks on ML.
- If a frame's inference isn't ready, we **reuse the last smoothed pose** — render stays at display rate even if inference runs slower.
- Everything here is client-side: **camera frames never leave the device** in the live tier (a real privacy selling point).

---

## 3. Body tracking & segmentation

- **Pose**: MediaPipe `PoseLandmarker` → 33 landmarks. We care about shoulders, elbows, wrists, hips. Shoulders define garment **width + roll**; shoulder→hip vector defines **torso length/scale + pitch**; elbows/wrists optionally drive sleeves.
- **Segmentation**: MediaPipe person/selfie segmentation → a person mask used for **occlusion** (arms/hair in front of the torso correctly hide the garment) and to clip the warp to the body.
- **Stability**: One-Euro filter on landmarks + confidence hysteresis to kill jitter and gracefully handle brief tracking loss.
- *Fallback option:* TensorFlow.js BlazePose/MoveNet if we ever need it — but MediaPipe is the recommended primary.

---

## 4. How clothing images become "wearable" assets

A garment is only useful to the engine once it's a **clean cutout with known anchor points**. The pipeline (server-side, Phase 3):

1. **Acquire** garment image (from the product resolver, an uploaded file, or an image URL).
2. **Background removal** → RGBA cutout (BiRefNet / rembg / SAM).
3. **Classify** garment type (t-shirt / long-sleeve / hoodie / dress …) → sets the mesh template and z-order.
4. **Auto-rig**: detect control points on the flatlay (neck, L/R shoulder, L/R sleeve-end, L/R hem, center-hem) by running pose/parsing on the garment itself.
5. **Emit** a `GarmentAsset` (see §10) and cache it in object storage/CDN.

For Phase 1–2 we **hand-author** a few assets so we can prove the live experience before building this pipeline.

---

## 5. How garments follow the body

- Build a **triangulated mesh** over the garment (control points + a grid), textured with the RGBA cutout.
- Each frame, map garment **control points → pose landmarks**; set target vertex positions via affine/barycentric interpolation from landmark deltas.
- **Clip** the warped garment by the person mask → correct occlusion.
- **Polish** (cheap, high-impact): edge feathering, a soft contact shadow where garment meets body, and **color/light harmonization** (sample ambient from the frame, tint the garment) so it doesn't look pasted on.
- **Limitation, stated honestly:** excellent for front-facing / mild angles; degrades on strong torso rotation or extreme poses. Acceptable given the "visual, not physical fit" goal.

---

## 6. How product URLs are processed (designed now, built in Phase 4)

**`ProductResolver`**: `URL → { title, type, color?, images[] }`

- **Adapter pattern** per domain (e.g. `AmazonAdapter`) implementing one interface.
- **Generic OpenGraph/`og:image` adapter** as fallback for unknown sites.
- **Caching** keyed by normalized product id / URL hash — never re-fetch/re-process the same product.
- **Guaranteed fallback**: if resolution fails, drop to the Phase-3 image path (paste image URL / upload). The core experience never hard-depends on scraping.
- Prefer official product/affiliate APIs over scraping where they exist (more robust + ToS-friendly).

---

## 7. Supporting different shopping sites

- New site = new adapter implementing `ProductResolver`. No change to the try-on pipeline.
- Adapters are **data-light and isolated**, so breakage from a site redesign is contained to one file.
- Tiered strategy: **official API → site adapter → OpenGraph fallback → manual image**.

---

## 8. Browser vs. server split

| Runs in **Browser** | Runs on **Server** |
|---|---|
| Camera capture + permissions | Product URL resolution / scraping |
| Pose + segmentation inference | Garment background removal + auto-rigging |
| Landmark smoothing | Garment-type classification |
| Garment mesh warp + occlusion + color harmonization | Prepared-asset cache + CDN |
| Full live render loop + all UI | *(Future)* HD diffusion try-on on captured stills (with consent) |

Principle: **the real-time loop is 100% client-side** (latency, cost, privacy). The server only does batchable, cacheable, GPU-heavy, or network-bound work.

---

## 9. Visual quality while staying real-time

Two tiers (see §0): the **live** geometric warp for the instant mirror, and an optional **HD** diffusion snapshot for photoreal output. Within the live tier, quality comes from cheap tricks that read as "real": smoothing, edge feathering, soft contact shadow, color/light harmonization, correct occlusion. We spend GPU on compositing, not on physics.

---

## 10. Letting better models drop in later

Three small contracts isolate every component that might change:

```ts
interface GarmentAsset {
  id: string;
  type: 'tshirt' | 'longsleeve' | 'hoodie' | 'dress' | ...;
  texture: RGBA;                 // background-removed cutout
  controlPoints: Record<AnchorName, Vec2>;
  zOrder: number;
  colorHints?: { dominant: RGB; material?: string };
  source?: { url?: string; retailer?: string };
}

interface PoseFrame {
  landmarks: { image: Vec2[]; world: Vec3[] };
  personMask: Mask;
  confidence: number;
  timestamp: number;
}

interface TryOnEngine {               // the swappable seam
  render(frame: PoseFrame, garment: GarmentAsset): CompositedFrame;
}
```

- `MeshWarpEngine` (client, now) and a future `DiffusionEngine` (server, HD) both satisfy `TryOnEngine` — swap engines without touching capture or UI.
- `GarmentPreparer` and `ProductResolver` are likewise interfaces, so the garment-prep model and each retailer integration evolve independently.
- The transport (local worker vs. remote server) is abstracted, so an engine can move from client to server transparently.

**Future UX the seams already allow** (not built now): paste a product URL, drag/drop a link from another window, and mobile share-sheet / deep-link hand-off — all just produce a `GarmentAsset` for the same engine.

---

## Development phases

### Phase 1 — Live Mirror Foundation *(the proof)*
- **Build:** Scaffold + camera + worker-based pose/segmentation + render loop; overlay **one hand-prepared garment** anchored to shoulders/torso, smoothed, with mask-based occlusion. Define the three core contracts (§10).
- **Why:** De-risks the hardest, most uncertain part — a *convincing real-time overlay* — before any backend exists.
- **Result:** Stand in front of your camera and watch a shirt track your upper body smoothly, fully in-browser.

### Phase 2 — Convincing Quality + Garment Catalog
- **Build:** Full mesh deformation (not just anchor+scale), sleeve articulation, color/light harmonization, contact shadow, feathering; a small **curated catalog** of hand-prepared garments + a picker UI.
- **Why:** Turn "it tracks" into "it looks convincing," with enough variety to evaluate.
- **Result:** A polished, demoable live mirror with several garments.

### Phase 3 — Garment Preparation Pipeline *(image → wearable asset)*
- **Build:** Python GPU service (background removal + auto control-point detection + classification) + Node API + asset cache/CDN. Input is a garment **image** (upload or image URL) — not full scraping yet.
- **Why:** Removes the manual-prep bottleneck — any garment image becomes wearable automatically. The real scalability unlock.
- **Result:** Paste/upload a clothing image → seconds later it's live on you.

### Phase 4 — Product URL Resolution + Input UX
- **Build:** Node `ProductResolver` with retailer adapters + OpenGraph fallback + caching; wire **paste-URL** and **drag/drop**, leaving clean seams for mobile share/deep-link. Falls back to Phase 3's image path on failure.
- **Why:** Delivers the headline UX (paste an Amazon link) on top of a proven pipeline, while isolating the brittle part.
- **Result:** Paste a product link → garment resolved → live try-on, with graceful fallback.

### Phase 5 — HD Snapshot Engine *(future / explicitly deferred)*
- **Build:** Server diffusion try-on (CatVTON/IDM-VTON) behind the `TryOnEngine` seam, run on a user-captured still **with consent**; a "See in HD" action.
- **Why:** Photoreal, share-worthy output on demand — without compromising the real-time loop.
- **Result:** One-tap photoreal try-on image alongside the live mirror.

---

## Exact scope of Part 2 = **Phase 1 only**

**In scope:**
- Project scaffold: Vite + React + TS, Tailwind, Zustand, PixiJS v8, `@mediapipe/tasks-vision`; clean folder structure.
- Camera module: `getUserMedia`, permission UX, mirrored preview, `requestVideoFrameCallback` loop, start/stop.
- Inference worker: MediaPipe `PoseLandmarker` + person segmentation in a Web Worker (OffscreenCanvas), emitting `PoseFrame`; GPU delegate with WASM fallback.
- Core contracts (types): `GarmentAsset`, `PoseFrame`, `TryOnEngine`, `GarmentPreparer`, `ProductResolver` + a **`MeshWarpEngine` v0** (anchor + scale + roll only).
- Render/composite: PixiJS stage draws video + **one bundled transparent-PNG garment** with hand-authored control points, anchored to shoulders/torso, One-Euro smoothed, clipped by person mask for basic occlusion.
- One sample garment asset committed to the repo.
- Minimal clean UI + an FPS/latency dev overlay; target **~30fps** on a typical laptop.

**Explicitly OUT of scope for Part 2** (later phases):
- Any backend or Python service; scraping / URL resolution.
- Automatic garment prep / background removal / catalog / picker.
- Full mesh deformation, sleeve articulation, color harmonization (Phase 2).
- Diffusion / HD try-on (Phase 5).
- Mobile share / deep-link.

---

## Non-functional targets
- **Privacy:** live camera frames stay on-device.
- **Performance:** live tier ~30fps; HD tier measured in seconds.
- **Browsers:** Chromium-first (WebGPU), graceful WASM/WebGL fallback for Safari/Firefox.
