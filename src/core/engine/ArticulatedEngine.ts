import type { FitResult, GarmentAsset, PoseFrame, Quad, TryOnEngine, Vec2 } from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';
import { buildGarmentMesh, type GarmentMesh } from '@/core/garment/mesh';
import * as v from '@/core/math/vec';

export interface ArticulatedOptions {
  shoulderWidthFactor?: number;
  hemDropFactor?: number;
  shoulderLiftFactor?: number;
  fadeSpeed?: number;
  minTorsoPx?: number;
  /** Fraction down the torso side where the armhole (underarm) sits. */
  underarmV?: number;
  /** Landmark visibility below which an arm is treated as untracked. */
  armVisibility?: number;
}

const DEFAULTS: Required<ArticulatedOptions> = {
  shoulderWidthFactor: 1.12,
  hemDropFactor: 0.32,
  shoulderLiftFactor: 0.06,
  fadeSpeed: 0.22,
  minTorsoPx: 24,
  underarmV: 0.3,
  armVisibility: 0.5,
};

const ZERO_QUAD: Quad = {
  tl: { x: 0, y: 0 },
  tr: { x: 0, y: 0 },
  br: { x: 0, y: 0 },
  bl: { x: 0, y: 0 },
};

interface ArmChain {
  shoulderIdx: number;
  elbowIdx: number;
  wristIdx: number;
}

/** A bent, tapering tube pinned at the armhole and following the arm. */
interface Skeleton {
  pointAt(t: number, s: number): Vec2;
}

/**
 * ArticulatedEngine — Phase 2 deformable try-on.
 *
 * Torso: bilinear warp of a shoulder/hip quad (distance, tilt, twist, yaw).
 * Sleeves: each mapped along the shoulder→elbow→wrist chain, pinned at the
 * armhole to the torso edge (no seam gap) and tapering to the cuff. Untracked
 * arms fall back to a hanging pose so sleeves stay stable instead of flying off.
 */
export class ArticulatedEngine implements TryOnEngine {
  readonly id = 'articulated-v1';
  private readonly opts: Required<ArticulatedOptions>;
  private garment: GarmentAsset | null = null;
  private mesh: GarmentMesh | null = null;
  private positions: Float32Array = new Float32Array(0);
  private opacity = 0;

  constructor(options: ArticulatedOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  prepare(garment: GarmentAsset): void {
    this.garment = garment;
    this.mesh = buildGarmentMesh(garment);
    this.positions = new Float32Array(this.mesh.vertexCount * 2);
    this.opacity = 0;
  }

  fit(frame: PoseFrame): FitResult {
    const mesh = this.mesh;
    if (!mesh) return invisible();

    const geo = this.torsoGeometry(frame);
    const target = geo ? 1 : 0;
    this.opacity += (target - this.opacity) * this.opts.fadeSpeed;
    if (!geo) {
      if (this.opacity < 0.02) this.opacity = 0;
      return { ...invisible(), opacity: this.opacity };
    }

    const left = this.buildArm(frame, geo, geo.leftArm, geo.quad.tl, geo.quad.bl);
    const right = this.buildArm(frame, geo, geo.rightArm, geo.quad.tr, geo.quad.br);

    const pos = this.positions;
    const { region, paramA, paramB } = mesh;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const a = paramA[i]!;
      const b = paramB[i]!;
      let p: Vec2;
      if (region[i] === 0) p = bilinear(geo.quad, a, b);
      else if (region[i] === 1) p = left.pointAt(a, b);
      else p = right.pointAt(a, b);
      pos[i * 2] = p.x;
      pos[i * 2 + 1] = p.y;
    }

    const lz = frame.normalized[geo.leftArm.shoulderIdx]?.z ?? 0;
    const rz = frame.normalized[geo.rightArm.shoulderIdx]?.z ?? 0;
    const shoulderZ = (lz + rz) / 2;

    return {
      quad: geo.quad,
      leftSleeveOpacity: this.sleeveOpacity(frame, geo.leftArm),
      rightSleeveOpacity: this.sleeveOpacity(frame, geo.rightArm),
      opacity: this.opacity,
      visible: this.opacity > 0.02,
      positions: pos,
      leftSleeveBehind: this.isBehind(frame, geo.leftArm.wristIdx, shoulderZ),
      rightSleeveBehind: this.isBehind(frame, geo.rightArm.wristIdx, shoulderZ),
    };
  }

  private isBehind(frame: PoseFrame, wristIdx: number, shoulderZ: number): boolean {
    const n = frame.normalized[wristIdx];
    if (!n) return false;
    return n.z > shoulderZ + 0.08;
  }

  /**
   * Fade a sleeve out when its arm isn't confidently tracked, so an untracked
   * arm leaves no sleeve rather than a stuck "hanging" blob over the chest.
   */
  private sleeveOpacity(frame: PoseFrame, arm: ArmChain): number {
    const elbow = frame.normalized[arm.elbowIdx]?.visibility ?? 0;
    const wrist = frame.normalized[arm.wristIdx]?.visibility ?? 0;
    return smooth01(this.opts.armVisibility - 0.2, this.opts.armVisibility + 0.1, Math.min(elbow, wrist));
  }

  private torsoGeometry(frame: PoseFrame): TorsoGeometry | null {
    const lm = frame.image;
    if (!frame.valid || lm.length < 33) return null;

    const s11 = lm[PoseLandmark.LEFT_SHOULDER]!;
    const s12 = lm[PoseLandmark.RIGHT_SHOULDER]!;
    const h23 = lm[PoseLandmark.LEFT_HIP]!;
    const h24 = lm[PoseLandmark.RIGHT_HIP]!;

    // Assign by on-screen x; carry the matching arm chain for each side.
    const leftIs11 = s11.x <= s12.x;
    const leftShoulder = leftIs11 ? s11 : s12;
    const rightShoulder = leftIs11 ? s12 : s11;
    const leftArm: ArmChain = leftIs11
      ? { shoulderIdx: 11, elbowIdx: 13, wristIdx: 15 }
      : { shoulderIdx: 12, elbowIdx: 14, wristIdx: 16 };
    const rightArm: ArmChain = leftIs11
      ? { shoulderIdx: 12, elbowIdx: 14, wristIdx: 16 }
      : { shoulderIdx: 11, elbowIdx: 13, wristIdx: 15 };

    const shoulderMid = v.mid(leftShoulder, rightShoulder);
    const shoulderWidth = v.dist(leftShoulder, rightShoulder);
    if (shoulderWidth < this.opts.minTorsoPx) return null;

    let shoulderAxis = v.normalize(v.sub(rightShoulder, leftShoulder));
    if (v.len(shoulderAxis) < 0.5) shoulderAxis = { x: 1, y: 0 };
    // Downward spine direction: perpendicular to the shoulder line, pointing to +y.
    let down = v.perp(shoulderAxis);
    if (down.y < 0) down = v.scale(down, -1);

    // Hips: trust measured landmarks only when confidently visible; otherwise
    // synthesize a body-proportioned torso from the shoulders. This fixes seated /
    // cropped framing (hips out of frame), where MediaPipe's hip guesses would
    // otherwise collapse the shirt into a small bib on the upper chest.
    const hipVis = Math.min(
      frame.normalized[PoseLandmark.LEFT_HIP]?.visibility ?? 0,
      frame.normalized[PoseLandmark.RIGHT_HIP]?.visibility ?? 0,
    );
    const hb = smooth01(0.35, 0.6, hipVis);

    const measLeftHip = h23.x <= h24.x ? h23 : h24;
    const measRightHip = h23.x <= h24.x ? h24 : h23;
    const measHipMid = v.mid(measLeftHip, measRightHip);
    const measHipWidth = v.dist(measLeftHip, measRightHip);
    let measHipAxis = v.normalize(v.sub(measRightHip, measLeftHip));
    if (v.len(measHipAxis) < 0.5) measHipAxis = shoulderAxis;

    const synthLen = shoulderWidth * 1.5;
    const synthHipMid = v.add(shoulderMid, v.scale(down, synthLen));
    const synthHipWidth = shoulderWidth * 0.78;

    let hipMid = v.lerp(synthHipMid, measHipMid, hb);
    const hipWidth = synthHipWidth + (measHipWidth - synthHipWidth) * hb;
    let hipAxis = v.normalize(v.lerp(shoulderAxis, measHipAxis, hb));
    if (v.len(hipAxis) < 0.5) hipAxis = shoulderAxis;

    let torsoVec = v.sub(hipMid, shoulderMid);
    let torsoLen = v.len(torsoVec);
    let torsoDir = torsoLen > 1 ? v.normalize(torsoVec) : down;

    // A torso is at least ~1.5x shoulder-width tall. If measured hips land too
    // high (close/seated framing, or a cropped lower body), extend to a realistic
    // length so the shirt covers the torso instead of bunching up on the chest.
    const minLen = shoulderWidth * 1.5;
    if (torsoLen < minLen) {
      torsoLen = minLen;
      hipMid = v.add(shoulderMid, v.scale(torsoDir, minLen));
    }

    const halfShoulder = (shoulderWidth / 2) * this.opts.shoulderWidthFactor;
    const hemHalf = v.clamp((hipWidth / 2) * 1.1, halfShoulder * 0.82, halfShoulder * 1.05);
    const lift = v.scale(torsoDir, this.opts.shoulderLiftFactor * torsoLen);
    const top = v.sub(shoulderMid, lift);
    const hemCenter = v.add(hipMid, v.scale(torsoDir, this.opts.hemDropFactor * torsoLen));

    const quad: Quad = {
      tl: v.sub(top, v.scale(shoulderAxis, halfShoulder)),
      tr: v.add(top, v.scale(shoulderAxis, halfShoulder)),
      bl: v.sub(hemCenter, v.scale(hipAxis, hemHalf)),
      br: v.add(hemCenter, v.scale(hipAxis, hemHalf)),
    };
    for (const p of [quad.tl, quad.tr, quad.bl, quad.br]) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    }
    return { quad, torsoDir, torsoLen, leftArm, rightArm };
  }

  private buildArm(
    frame: PoseFrame,
    geo: TorsoGeometry,
    arm: ArmChain,
    shoulderPt: Vec2,
    bottomCorner: Vec2,
  ): Skeleton {
    const underarm = v.lerp(shoulderPt, bottomCorner, this.opts.underarmV);
    const c0 = v.mid(shoulderPt, underarm);
    const rootHalf = Math.max(6, v.dist(shoulderPt, underarm) / 2);
    const rootNormal = v.normalize(v.sub(underarm, shoulderPt));
    const isLong = this.garment?.layout.sleeveLength === 'long';

    // Real arm joints, blended toward a hanging fallback when untracked.
    const armLen = geo.torsoLen * 0.95;
    const hangElbow = v.add(shoulderPt, v.scale(geo.torsoDir, armLen * 0.5));
    const hangWrist = v.add(shoulderPt, v.scale(geo.torsoDir, armLen));
    const elbowVis = frame.normalized[arm.elbowIdx]?.visibility ?? 0;
    const wristVis = frame.normalized[arm.wristIdx]?.visibility ?? 0;
    const wArm = smooth01(this.opts.armVisibility - 0.2, this.opts.armVisibility + 0.1, Math.min(elbowVis, wristVis));
    const elbow = v.lerp(hangElbow, frame.image[arm.elbowIdx] ?? hangElbow, wArm);
    const wrist = v.lerp(hangWrist, frame.image[arm.wristIdx] ?? hangWrist, wArm);

    const knots: Vec2[] = isLong ? [c0, elbow, wrist] : [c0, v.lerp(c0, elbow, 0.55)];
    const cuffHalf = rootHalf * (isLong ? 0.5 : 0.72);
    return makeSkeleton(knots, rootHalf, cuffHalf, rootNormal);
  }

  dispose(): void {
    this.garment = null;
    this.mesh = null;
    this.positions = new Float32Array(0);
    this.opacity = 0;
  }
}

interface TorsoGeometry {
  quad: Quad;
  torsoDir: Vec2;
  torsoLen: number;
  leftArm: ArmChain;
  rightArm: ArmChain;
}

function makeSkeleton(knots: Vec2[], rootHalf: number, cuffHalf: number, rootNormal: Vec2): Skeleton {
  const segs: { a: Vec2; dir: Vec2; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    const len = Math.max(1e-3, v.dist(a, b));
    segs.push({ a, dir: v.scale(v.sub(b, a), 1 / len), len });
    total += len;
  }
  return {
    pointAt(t, s) {
      const d = v.clamp(t, 0, 1) * total;
      let acc = 0;
      let seg = segs[segs.length - 1]!;
      let local = d - (total - seg.len);
      for (const sg of segs) {
        if (d <= acc + sg.len) {
          seg = sg;
          local = d - acc;
          break;
        }
        acc += sg.len;
      }
      const center = v.add(seg.a, v.scale(seg.dir, local));
      let normal = v.perp(seg.dir);
      if (v.dot(normal, rootNormal) < 0) normal = v.scale(normal, -1);
      const half = rootHalf + (cuffHalf - rootHalf) * t;
      return v.add(center, v.scale(normal, s * half));
    },
  };
}

function bilinear(q: Quad, u: number, vv: number): Vec2 {
  const topx = q.tl.x + (q.tr.x - q.tl.x) * u;
  const topy = q.tl.y + (q.tr.y - q.tl.y) * u;
  const botx = q.bl.x + (q.br.x - q.bl.x) * u;
  const boty = q.bl.y + (q.br.y - q.bl.y) * u;
  return { x: topx + (botx - topx) * vv, y: topy + (boty - topy) * vv };
}

function smooth01(a: number, b: number, x: number): number {
  const t = v.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function invisible(): FitResult {
  return { quad: ZERO_QUAD, opacity: 0, visible: false };
}
