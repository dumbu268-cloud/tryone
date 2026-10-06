import type { FitResult, GarmentAsset, PoseFrame, TryOnEngine, Vec2 } from '@/core/types';
import { computeHomography, IDENTITY } from '@/core/math/homography';
import { PoseLandmark } from '@/core/perception/landmarks';
import * as v from '@/core/math/vec';

export interface MeshWarpOptions {
  /** Garment torso width relative to the shoulder-landmark span. */
  shoulderWidthFactor?: number;
  /** How far below the hips the hem extends, as a fraction of torso length. */
  hemDropFactor?: number;
  /** Lift the shoulder seam toward the neck, as a fraction of torso length. */
  shoulderLiftFactor?: number;
  /** Opacity easing per frame (0..1); higher = snappier fade. */
  fadeSpeed?: number;
  /** Minimum torso size (px) below which we treat the pose as unusable. */
  minTorsoPx?: number;
}

const DEFAULTS: Required<MeshWarpOptions> = {
  shoulderWidthFactor: 1.12,
  hemDropFactor: 0.42,
  shoulderLiftFactor: 0.06,
  fadeSpeed: 0.22,
  minTorsoPx: 24,
};

const INVISIBLE: FitResult = {
  homography: IDENTITY,
  quad: {
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
    bl: { x: 0, y: 0 },
  },
  opacity: 0,
  visible: false,
};

/**
 * MeshWarpEngine v0 — geometric try-on.
 *
 * Builds a projective (homography) map from the garment's shoulder/hem quad to a
 * torso quad derived from the body landmarks. The top edge follows the shoulder
 * axis and the bottom edge follows the hip axis, so the garment responds to:
 *   - distance  (shoulder span → scale)
 *   - tilt/roll (shoulder axis angle)
 *   - torso twist (shoulders vs hips rotate independently)
 *   - yaw        (landmark foreshortening narrows the quad)
 *
 * Per-vertex cloth deformation and elbow/wrist-driven sleeves are Phase 2.
 */
export class MeshWarpEngine implements TryOnEngine {
  readonly id = 'mesh-warp-v0';
  private readonly opts: Required<MeshWarpOptions>;
  private garment: GarmentAsset | null = null;
  private srcQuad: Vec2[] = [];
  private opacity = 0;

  constructor(options: MeshWarpOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  prepare(garment: GarmentAsset): void {
    this.garment = garment;
    const a = garment.anchors;
    // Source quad in garment texture space, order: TL, TR, BR, BL.
    this.srcQuad = [a.leftShoulder, a.rightShoulder, a.rightHem, a.leftHem];
    this.opacity = 0;
  }

  fit(frame: PoseFrame): FitResult {
    if (!this.garment) return INVISIBLE;

    const target = this.wantsVisible(frame) ? 1 : 0;
    this.opacity += (target - this.opacity) * this.opts.fadeSpeed;
    if (this.opacity < 0.02 && target === 0) {
      this.opacity = 0;
      return { ...INVISIBLE };
    }

    const quad = this.torsoQuad(frame);
    if (!quad) {
      this.opacity = Math.max(0, this.opacity - this.opts.fadeSpeed);
      return { ...INVISIBLE, opacity: 0 };
    }

    const h = computeHomography(this.srcQuad, [quad.tl, quad.tr, quad.br, quad.bl]);
    if (!h) {
      return { ...INVISIBLE, opacity: 0 };
    }

    return {
      homography: h,
      quad,
      opacity: this.opacity,
      visible: this.opacity > 0.02,
    };
  }

  private wantsVisible(frame: PoseFrame): boolean {
    return frame.valid && frame.image.length >= 33 && this.torsoQuad(frame) !== null;
  }

  /** Build the screen-space torso quad (TL, TR, BR, BL) or null if unusable. */
  private torsoQuad(
    frame: PoseFrame,
  ): { tl: Vec2; tr: Vec2; br: Vec2; bl: Vec2 } | null {
    const lm = frame.image;
    if (lm.length < 33) return null;

    const s1 = lm[PoseLandmark.LEFT_SHOULDER]!;
    const s2 = lm[PoseLandmark.RIGHT_SHOULDER]!;
    const h1 = lm[PoseLandmark.LEFT_HIP]!;
    const h2 = lm[PoseLandmark.RIGHT_HIP]!;

    // Assign by on-screen x so garment-left maps to screen-left (mirror-safe).
    const [leftSh, rightSh] = s1.x <= s2.x ? [s1, s2] : [s2, s1];
    const [leftHip, rightHip] = h1.x <= h2.x ? [h1, h2] : [h2, h1];

    const shoulderMid = v.mid(leftSh, rightSh);
    const hipMid = v.mid(leftHip, rightHip);
    const torsoVec = v.sub(hipMid, shoulderMid);
    const torsoLen = v.len(torsoVec);
    const shoulderWidth = v.dist(leftSh, rightSh);
    const hipWidth = v.dist(leftHip, rightHip);

    if (torsoLen < this.opts.minTorsoPx || shoulderWidth < this.opts.minTorsoPx) {
      return null;
    }

    const torsoDir = v.normalize(torsoVec);
    // Horizontal axes: shoulders at top, hips at bottom (allows torso twist).
    let shoulderAxis = v.normalize(v.sub(rightSh, leftSh));
    let hipAxis = v.normalize(v.sub(rightHip, leftHip));
    const fallbackAxis = v.perp(torsoDir); // perp points +x for a downward torso
    if (v.len(shoulderAxis) < 0.5) shoulderAxis = fallbackAxis;
    if (v.len(hipAxis) < 0.5) hipAxis = fallbackAxis;

    const halfShoulder = (shoulderWidth / 2) * this.opts.shoulderWidthFactor;
    const hemHalf = v.clamp((hipWidth / 2) * 1.1, halfShoulder * 0.82, halfShoulder * 1.05);

    const lift = v.scale(torsoDir, this.opts.shoulderLiftFactor * torsoLen);
    const top = v.sub(shoulderMid, lift);
    const hemCenter = v.add(hipMid, v.scale(torsoDir, this.opts.hemDropFactor * torsoLen));

    const tl = v.sub(top, v.scale(shoulderAxis, halfShoulder));
    const tr = v.add(top, v.scale(shoulderAxis, halfShoulder));
    const bl = v.sub(hemCenter, v.scale(hipAxis, hemHalf));
    const br = v.add(hemCenter, v.scale(hipAxis, hemHalf));

    if (![tl, tr, bl, br].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      return null;
    }
    return { tl, tr, br, bl };
  }

  dispose(): void {
    this.garment = null;
    this.srcQuad = [];
    this.opacity = 0;
  }
}
