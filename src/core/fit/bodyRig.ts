import type { Vec2 } from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';
import * as v from '@/core/math/vec';

// Body keypoint estimator. Turns sparse pose joints into the garment-relevant
// body points a shirt actually attaches to (neck sides, shoulder tops, armpits).
// The SAME function runs on the live user and on a model in a product photo, so
// garment keypoints and body keypoints correspond 1:1 (pose-transfer warping).
//
// All distances are expressed in units of the shoulder-joint span ("span").

export interface LandmarkPx {
  x: number;
  y: number;
  /** Reliability used for decisions (visibility × in-frame). */
  visibility: number;
  /** 0..1, how far inside the image the point is (1 = well inside). */
  inFrame?: number;
  /** Raw model visibility (occlusion likelihood), before the in-frame factor. */
  raw?: number;
}

export interface ArmChainIdx {
  shoulder: number;
  elbow: number;
  wrist: number;
}

export interface BodyKeypoints {
  /** Shoulder joints, image-left / image-right. */
  jointL: Vec2;
  jointR: Vec2;
  center: Vec2;
  /** Unit vector image-left → image-right along the shoulders. */
  axis: Vec2;
  /** Unit vector toward the head. */
  up: Vec2;
  /** Unit vector down the torso (follows lean when hips are reliable). */
  torsoDir: Vec2;
  /** Hip axis (unit), blended toward the shoulder axis when hips are unreliable. */
  hipAxis: Vec2;
  hipReliability: number;
  span: number;
  neckL: Vec2;
  neckR: Vec2;
  shoulderL: Vec2;
  shoulderR: Vec2;
  armpitL: Vec2;
  armpitR: Vec2;
  armL: ArmChainIdx;
  armR: ArmChainIdx;
}

/** Anthropometric ratios (span units), calibrated on real footage. */
export const BODY = {
  neckHalf: 0.17,
  neckUp: 0.21,
  neckFromMouth: 0.36,
  tipOut: 0.09,
  tipUp: 0.1,
  pitDown: 0.46,
  upperArm: 0.85,
  forearm: 0.75,
};

const LEFT_CHAIN: ArmChainIdx = { shoulder: 11, elbow: 13, wrist: 15 };
const RIGHT_CHAIN: ArmChainIdx = { shoulder: 12, elbow: 14, wrist: 16 };

export function estimateBodyKeypoints(
  lm: readonly LandmarkPx[],
  hipReliability: number,
  minSpan = 8,
): BodyKeypoints | null {
  const s11 = lm[PoseLandmark.LEFT_SHOULDER];
  const s12 = lm[PoseLandmark.RIGHT_SHOULDER];
  if (!s11 || !s12) return null;

  const leftIs11 = s11.x <= s12.x;
  const jointL: Vec2 = leftIs11 ? s11 : s12;
  const jointR: Vec2 = leftIs11 ? s12 : s11;
  const armL = leftIs11 ? LEFT_CHAIN : RIGHT_CHAIN;
  const armR = leftIs11 ? RIGHT_CHAIN : LEFT_CHAIN;

  const span = v.dist(jointL, jointR);
  if (!(span >= minSpan)) return null;
  const center = v.mid(jointL, jointR);
  const axis = v.normalize(v.sub(jointR, jointL));
  const up: Vec2 = { x: axis.y, y: -axis.x };
  const down = v.scale(up, -1);

  // Neck: shoulder-span estimate, refined by the mouth position when visible.
  let neckH = BODY.neckUp * span;
  const m9 = lm[9];
  const m10 = lm[10];
  if (m9 && m10 && Math.min(m9.visibility, m10.visibility) > 0.5) {
    const mouth = v.mid(m9, m10);
    const dUp = v.dot(v.sub(mouth, center), up);
    if (dUp > 0.3 * span) neckH = v.lerpN(neckH, BODY.neckFromMouth * dUp, 0.6);
  }
  neckH = v.clamp(neckH, 0.12 * span, 0.32 * span);
  const neckC = v.add(center, v.scale(up, neckH));
  const neckL = v.sub(neckC, v.scale(axis, BODY.neckHalf * span));
  const neckR = v.add(neckC, v.scale(axis, BODY.neckHalf * span));

  // Torso direction: hips when reliable (limited to a plausible lean), else perpendicular.
  let torsoDir = down;
  let hipAxis = axis;
  const h23 = lm[PoseLandmark.LEFT_HIP];
  const h24 = lm[PoseLandmark.RIGHT_HIP];
  const hr = v.clamp(hipReliability, 0, 1);
  if (h23 && h24 && hr > 0) {
    const hipL = h23.x <= h24.x ? h23 : h24;
    const hipR = h23.x <= h24.x ? h24 : h23;
    const measured = v.normalize(v.sub(v.mid(hipL, hipR), center));
    // Clamp lean to ±35° from the shoulder perpendicular; reject inverted torsos.
    const plausible = v.dot(measured, down) > Math.cos((35 * Math.PI) / 180);
    if (plausible) torsoDir = v.normalize(v.lerp(down, measured, hr));
    const ha = v.normalize(v.sub(hipR, hipL));
    if (v.len(ha) > 0.5 && v.dot(ha, axis) > 0.5) hipAxis = v.normalize(v.lerp(axis, ha, hr));
  }

  const tipUp = v.scale(up, BODY.tipUp * span);
  const shoulderL = v.add(v.sub(jointL, v.scale(axis, BODY.tipOut * span)), tipUp);
  const shoulderR = v.add(v.add(jointR, v.scale(axis, BODY.tipOut * span)), tipUp);
  const pitDrop = v.scale(torsoDir, BODY.pitDown * span);
  const armpitL = v.add(jointL, pitDrop);
  const armpitR = v.add(jointR, pitDrop);

  return {
    jointL,
    jointR,
    center,
    axis,
    up,
    torsoDir,
    hipAxis,
    hipReliability: hr,
    span,
    neckL,
    neckR,
    shoulderL,
    shoulderR,
    armpitL,
    armpitR,
    armL,
    armR,
  };
}
