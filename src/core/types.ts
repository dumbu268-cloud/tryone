// ---------------------------------------------------------------------------
// Shared contracts for the Live Mirror pipeline.
//
//   Camera -> BodyPerception -> PoseFrame -> TryOnEngine (fit) -> Renderer
//
// These interfaces are the stable architectural seams. Implementations behind
// them (perception model, try-on engine, renderer) can be swapped without
// touching the rest of the pipeline.
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A 3x3 matrix stored row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** A single body landmark in normalized coordinates (x,y in [0,1]), with depth. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/**
 * Per-pixel category mask produced by the multiclass selfie segmenter.
 * Category indices: 0 background, 1 hair, 2 body-skin, 3 face-skin,
 * 4 clothes, 5 others/accessories.
 */
export interface SegmentationMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * The canonical per-frame perception result consumed by the try-on engine.
 * Landmarks are already smoothed and mirrored into screen-pixel space.
 */
export interface PoseFrame {
  /** Source video-frame timestamp in milliseconds. */
  timestamp: number;
  /** Source frame size in pixels (the space `image` landmarks live in). */
  width: number;
  height: number;
  /** Whether a usable pose was detected this frame. */
  valid: boolean;
  /** Overall confidence 0..1 (derived from landmark visibility). */
  confidence: number;
  /** Landmarks in screen-pixel space, mirrored to match the mirrored preview. */
  image: Vec2[];
  /** Normalized landmarks (with depth z + visibility), mirrored. */
  normalized: Landmark[];
  /** Optional occlusion mask; may update at a lower cadence than the pose. */
  segmentation?: SegmentationMask;
}

export type GarmentType = 'tshirt' | 'longsleeve' | 'hoodie' | 'dress';

/**
 * Control points on the garment texture, in texture-pixel space. These map to
 * body landmarks to position/deform the garment. Shoulders + hem form the
 * torso quad; sleeve points are kept for reference/debug.
 */
export interface GarmentAnchors {
  neck: Vec2;
  leftShoulder: Vec2;
  rightShoulder: Vec2;
  leftHem: Vec2;
  rightHem: Vec2;
  leftSleeve?: Vec2;
  rightSleeve?: Vec2;
}

export interface Quad {
  tl: Vec2;
  tr: Vec2;
  br: Vec2;
  bl: Vec2;
}

/**
 * A sleeve region in the garment's flat-lay texture space. The "root" edge is
 * the armhole (seam with the torso); the "tip" edge is the cuff. `rootTop`
 * sits at the shoulder, `rootBottom` at the underarm.
 */
export interface SleeveLayout {
  rootTop: Vec2;
  rootBottom: Vec2;
  tipTop: Vec2;
  tipBottom: Vec2;
}

/**
 * Describes how the garment texture decomposes into deformable regions. Used by
 * the mesh builder (topology) and the articulated engine (deformation). All
 * coordinates are in texture-pixel space.
 */
export interface GarmentLayout {
  torso: Quad;
  leftSleeve: SleeveLayout;
  rightSleeve: SleeveLayout;
  sleeveLength: 'short' | 'long';
  /** True when sleeves cover the forearm (disables the bare-forearm repaint). */
  coversForearm: boolean;
  /**
   * Keypoint rig used by the fitting engine. When absent it is derived from the
   * coarse torso/sleeve quads above (legacy garments).
   */
  rig?: GarmentRig;
}

/** A sleeve in texture space: a skeleton from the armhole centre to the cuff. */
export interface SleeveRig {
  /** Polyline; axis[0] is the armhole centre (midpoint of shoulder tip & armpit). */
  axis: Vec2[];
  rootHalfWidth: number;
  tipHalfWidth: number;
}

/**
 * Named garment keypoints in texture space ("L"/"R" = image-left/right). They
 * correspond 1:1 to body keypoints estimated on the user, so fitting is a
 * keypoint-correspondence warp instead of a fixed template.
 */
export interface GarmentRig {
  neckL: Vec2;
  neckR: Vec2;
  /** Shoulder seam tips (where sleeves attach at the top). */
  shoulderL: Vec2;
  shoulderR: Vec2;
  armpitL: Vec2;
  armpitR: Vec2;
  hemL: Vec2;
  hemR: Vec2;
  sleeveL: SleeveRig | null;
  sleeveR: SleeveRig | null;
  /** How the rig was obtained: source-model pose, flat-lay silhouette, or legacy layout. */
  source: 'pose' | 'silhouette' | 'layout';
}

/** Serializable garment description (no decoded image). */
export interface GarmentDescriptor {
  id: string;
  name: string;
  type: GarmentType;
  /** URL of the texture (SVG or PNG with transparency). */
  textureUrl: string;
  textureWidth: number;
  textureHeight: number;
  anchors: GarmentAnchors;
  layout: GarmentLayout;
  zOrder: number;
  colorHints?: { dominant: [number, number, number] };
}

/** A fully loaded garment ready for the engine + renderer. */
export interface GarmentAsset {
  id: string;
  name: string;
  type: GarmentType;
  textureWidth: number;
  textureHeight: number;
  /** Decoded texture usable as a WebGL texture source. */
  image: TexImageSource;
  anchors: GarmentAnchors;
  layout: GarmentLayout;
  zOrder: number;
  colorHints?: { dominant: [number, number, number] };
}

/**
 * Geometry describing how to draw the garment for one frame.
 *
 * The articulated engine (Phase 2) fills `positions` (per-vertex screen-space
 * coordinates for the garment mesh) plus draw-order flags. `quad` is still the
 * torso quad, used for debug overlay and forearm-occlusion. `homography` is
 * retained (optional) for the simpler Phase-1 MeshWarpEngine.
 */
export interface FitResult {
  /** Torso quad corners in screen space (debug/overlay + forearm occlusion). */
  quad: Quad;
  /** 0..1 placement opacity; drives fade in/out as tracking gains/loses lock. */
  opacity: number;
  /** Whether the garment should be drawn this frame. */
  visible: boolean;
  /** Per-vertex screen-space positions (x,y) matching the garment mesh order. */
  positions?: Float32Array;
  /** Draw the left/right sleeve behind the torso (arm is behind the body). */
  leftSleeveBehind?: boolean;
  rightSleeveBehind?: boolean;
  /** Per-sleeve opacity (0..1): fades a sleeve out when the arm isn't tracked. */
  leftSleeveOpacity?: number;
  rightSleeveOpacity?: number;
  /** Homography (garment texture-px -> screen-px), set by MeshWarpEngine only. */
  homography?: Mat3;
  /** Diagnostics for the debug overlay and test bench. */
  debug?: FitDebug;
}

export type ArmTrackState = 'tracked' | 'partial' | 'held' | 'rest';

export interface FitDebug {
  /** Body target keypoints: neckL, neckR, shoulderL, shoulderR, armpitL, armpitR, hemL, hemR. */
  keypoints: Vec2[];
  /** Image-left then image-right arm: tracking state + joint chain used for the sleeve. */
  arms: { state: ArmTrackState; chain: Vec2[] }[];
}

/**
 * The swappable try-on engine. v0 (MeshWarpEngine) computes garment *geometry*;
 * the Renderer owns GPU compositing. A future server/diffusion engine will
 * generalize this seam to return pixels instead of geometry.
 */
export interface TryOnEngine {
  readonly id: string;
  prepare(garment: GarmentAsset): void;
  fit(frame: PoseFrame): FitResult;
  dispose(): void;
}

// --- Phase 3: automatic garment preparation -------------------------------

/** Plain pixel buffer (RGBA), DOM-free so the analysis is unit-testable. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the preparer understood about the input image. */
export interface GarmentPrepDiagnostics {
  /** Whether a usable top-like garment was detected and prepared. */
  supported: boolean;
  reason?: string;
  detectedType: GarmentType;
  sleeveLength: 'short' | 'long' | 'none';
  bbox: BBox;
  /** Fraction of pixels kept as garment after background removal (0..1). */
  foregroundRatio: number;
  /** Which preparer produced this result. */
  method?: 'ml' | 'classic';
}

export interface GarmentPrepResult {
  asset: GarmentAsset;
  diagnostics: GarmentPrepDiagnostics;
}

/**
 * Turns an ordinary clothing image into a wearable {@link GarmentAsset}
 * compatible with the articulated engine. The swap seam for garment acquisition
 * (classical CV now; an ML segmenter could implement the same interface later).
 */
export interface GarmentPreparer {
  prepare(source: CanvasImageSource): Promise<GarmentPrepResult>;
}
