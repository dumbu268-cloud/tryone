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
 * homography source quad; sleeve points are reserved for Phase-2 deformation.
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
  zOrder: number;
  colorHints?: { dominant: [number, number, number] };
}

/** Geometry describing where/how to draw the garment for one frame. */
export interface FitResult {
  /** Homography mapping garment texture-px -> screen-px (row-major). */
  homography: Mat3;
  /** Target quad corners in screen space (debug/overlay + sanity checks). */
  quad: { tl: Vec2; tr: Vec2; br: Vec2; bl: Vec2 };
  /** 0..1 placement opacity; drives fade in/out as tracking gains/loses lock. */
  opacity: number;
  /** Whether the garment should be drawn this frame. */
  visible: boolean;
  /**
   * Optional per-vertex screen-space offsets for a future deformable mesh
   * (Phase 2). Unused by MeshWarpEngine v0.
   */
  vertexOffsets?: Float32Array;
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
