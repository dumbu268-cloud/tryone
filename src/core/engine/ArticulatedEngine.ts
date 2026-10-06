import type {
  FitResult,
  GarmentAsset,
  GarmentLayout,
  PoseFrame,
  Quad,
  TryOnEngine,
  Vec2,
} from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';
import { buildGarmentMesh, type GarmentMesh } from '@/core/garment/mesh';
import * as v from '@/core/math/vec';

export interface ArticulatedOptions {
  /** Garment shoulders sit this much wider than the body shoulder landmarks. */
  shoulderWidthFactor?: number;
  /** Lift the shoulder seam toward the neck, as a fraction of garment length. */
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
  shoulderLiftFactor: 0.05,
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

/** Garment-intrinsic proportions, relative to its own shoulder width. */
interface GarmentProportions {
  hemWidthRatio: number;
  torsoLenRatio: number;
  leftSleeveLenRatio: number;
  rightSleeveLenRatio: number;
  leftSleeveTipRatio: number;
  rightSleeveTipRatio: number;
}

interface Skeleton {
  pointAt(t: number, s: number): Vec2;
}

/**
 * ArticulatedEngine — garment-proportioned deformable try-on.
 *
 * The garment's own layout determines its shape (torso width/length/hem + sleeve
 * length/width); the body only places/scales/orients/leans it. So different
 * garments produce visibly different geometry, while the fit tracks the user.
 * Sleeves articulate to the elbow/wrist when visible and rest in a natural hang
 * (never vanish) when the arms aren't tracked.
 */
export class ArticulatedEngine implements TryOnEngine {
  readonly id = 'articulated-v2';
  private readonly opts: Required<ArticulatedOptions>;
  private mesh: GarmentMesh | null = null;
  private prop: GarmentProportions = flatProportions();
  private positions: Float32Array = new Float32Array(0);
  private opacity = 0;

  constructor(options: ArticulatedOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  prepare(garment: GarmentAsset): void {
    this.mesh = buildGarmentMesh(garment);
    this.prop = computeProportions(garment.layout);
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

    const left = this.buildArm(frame, geo, geo.leftArm, geo.quad.tl, geo.quad.bl, true);
    const right = this.buildArm(frame, geo, geo.rightArm, geo.quad.tr, geo.quad.br, false);

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

  private torsoGeometry(frame: PoseFrame): TorsoGeometry | null {
    const lm = frame.image;
    if (!frame.valid || lm.length < 33) return null;

    const s11 = lm[PoseLandmark.LEFT_SHOULDER]!;
    const s12 = lm[PoseLandmark.RIGHT_SHOULDER]!;
    const h23 = lm[PoseLandmark.LEFT_HIP]!;
    const h24 = lm[PoseLandmark.RIGHT_HIP]!;

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
    const bodyShoulderW = v.dist(leftShoulder, rightShoulder);
    if (bodyShoulderW < this.opts.minTorsoPx) return null;

    let shoulderAxis = v.normalize(v.sub(rightShoulder, leftShoulder));
    if (v.len(shoulderAxis) < 0.5) shoulderAxis = { x: 1, y: 0 };
    let down = v.perp(shoulderAxis);
    if (down.y < 0) down = v.scale(down, -1);

    // Body torso DIRECTION (lean) from shoulders→hips; its length is not used —
    // the garment supplies the length. Synthesize/clamp only the direction.
    const hipVis = Math.min(
      frame.normalized[PoseLandmark.LEFT_HIP]?.visibility ?? 0,
      frame.normalized[PoseLandmark.RIGHT_HIP]?.visibility ?? 0,
    );
    const hb = smooth01(0.35, 0.6, hipVis);
    const measLeftHip = h23.x <= h24.x ? h23 : h24;
    const measRightHip = h23.x <= h24.x ? h24 : h23;
    const measHipMid = v.mid(measLeftHip, measRightHip);
    let measHipAxis = v.normalize(v.sub(measRightHip, measLeftHip));
    if (v.len(measHipAxis) < 0.5) measHipAxis = shoulderAxis;
    const synthHipMid = v.add(shoulderMid, v.scale(down, bodyShoulderW * 1.5));

    const hipMid = v.lerp(synthHipMid, measHipMid, hb);
    let hipAxis = v.normalize(v.lerp(shoulderAxis, measHipAxis, hb));
    if (v.len(hipAxis) < 0.5) hipAxis = shoulderAxis;

    const torsoVec = v.sub(hipMid, shoulderMid);
    let torsoDir = v.len(torsoVec) > 1 ? v.normalize(torsoVec) : down;
    // Never let the garment render upside down.
    if (v.dot(torsoDir, down) <= 0) torsoDir = down;

    // --- Garment-proportioned quad -----------------------------------------
    const factor = this.opts.shoulderWidthFactor;
    const scaleUnit = bodyShoulderW * factor; // garment shoulder width -> body
    const topHalf = scaleUnit / 2;
    const botHalf = topHalf * this.prop.hemWidthRatio;
    const lenScreen = this.prop.torsoLenRatio * scaleUnit;

    const top = v.sub(shoulderMid, v.scale(torsoDir, this.opts.shoulderLiftFactor * lenScreen));
    const bottom = v.add(top, v.scale(torsoDir, lenScreen));

    const quad: Quad = {
      tl: v.sub(top, v.scale(shoulderAxis, topHalf)),
      tr: v.add(top, v.scale(shoulderAxis, topHalf)),
      bl: v.sub(bottom, v.scale(hipAxis, botHalf)),
      br: v.add(bottom, v.scale(hipAxis, botHalf)),
    };
    for (const p of [quad.tl, quad.tr, quad.bl, quad.br]) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    }
    return { quad, torsoDir, torsoLen: lenScreen, scaleUnit, shoulderAxis, leftArm, rightArm };
  }

  private buildArm(
    frame: PoseFrame,
    geo: TorsoGeometry,
    arm: ArmChain,
    shoulderPt: Vec2,
    bottomCorner: Vec2,
    isLeft: boolean,
  ): Skeleton {
    const underarm = v.lerp(shoulderPt, bottomCorner, this.opts.underarmV);
    const c0 = v.mid(shoulderPt, underarm);
    const rootHalf = Math.max(6, v.dist(shoulderPt, underarm) / 2);
    const rootNormal = v.normalize(v.sub(underarm, shoulderPt));

    const lenRatio = isLeft ? this.prop.leftSleeveLenRatio : this.prop.rightSleeveLenRatio;
    const tipRatio = isLeft ? this.prop.leftSleeveTipRatio : this.prop.rightSleeveTipRatio;
    const sleeveLen = lenRatio * geo.scaleUnit;
    if (sleeveLen < 10) {
      // Sleeveless/tank: collapse the sleeve mesh to the armhole (renders nothing).
      return { pointAt: () => c0 };
    }
    const tipHalf = v.clamp((tipRatio * geo.scaleUnit) / 2, 3, rootHalf);

    // Arm direction: real joints when visible, blended toward a natural resting
    // hang (down + slightly outward) when not — so the sleeve never vanishes.
    const outward = isLeft ? v.scale(geo.shoulderAxis, -1) : geo.shoulderAxis;
    const restDir = v.normalize(v.add(geo.torsoDir, v.scale(outward, 0.35)));
    const armLen = Math.max(sleeveLen, geo.torsoLen * 0.9);
    const restElbow = v.add(c0, v.scale(restDir, armLen * 0.5));
    const restWrist = v.add(c0, v.scale(restDir, armLen));

    const elbowVis = frame.normalized[arm.elbowIdx]?.visibility ?? 0;
    const wristVis = frame.normalized[arm.wristIdx]?.visibility ?? 0;
    const wArm = smooth01(
      this.opts.armVisibility - 0.2,
      this.opts.armVisibility + 0.1,
      Math.min(elbowVis, wristVis),
    );
    const elbow = v.lerp(restElbow, frame.image[arm.elbowIdx] ?? restElbow, wArm);
    const wrist = v.lerp(restWrist, frame.image[arm.wristIdx] ?? restWrist, wArm);

    // Sleeve covers `sleeveLen` of arc length along shoulder→elbow→wrist.
    const knots = truncatePolyline([c0, elbow, wrist], sleeveLen, restDir);
    return makeSkeleton(knots, rootHalf, tipHalf, rootNormal);
  }

  dispose(): void {
    this.mesh = null;
    this.positions = new Float32Array(0);
    this.opacity = 0;
  }
}

interface TorsoGeometry {
  quad: Quad;
  torsoDir: Vec2;
  torsoLen: number;
  scaleUnit: number;
  shoulderAxis: Vec2;
  leftArm: ArmChain;
  rightArm: ArmChain;
}

function flatProportions(): GarmentProportions {
  return {
    hemWidthRatio: 1,
    torsoLenRatio: 1.4,
    leftSleeveLenRatio: 0.9,
    rightSleeveLenRatio: 0.9,
    leftSleeveTipRatio: 0.5,
    rightSleeveTipRatio: 0.5,
  };
}

function computeProportions(layout: GarmentLayout): GarmentProportions {
  const t = layout.torso;
  const shoulderW = Math.max(1, v.dist(t.tl, t.tr));
  const hemW = v.dist(t.bl, t.br);
  const torsoLen = (v.dist(t.tl, t.bl) + v.dist(t.tr, t.br)) / 2;

  const sleeve = (s: GarmentLayout['leftSleeve']) => {
    const rootMid = v.mid(s.rootTop, s.rootBottom);
    const tipMid = v.mid(s.tipTop, s.tipBottom);
    return {
      lenRatio: v.dist(rootMid, tipMid) / shoulderW,
      tipRatio: v.dist(s.tipTop, s.tipBottom) / shoulderW,
    };
  };
  const l = sleeve(layout.leftSleeve);
  const r = sleeve(layout.rightSleeve);

  return {
    hemWidthRatio: v.clamp(hemW / shoulderW, 0.55, 1.6),
    torsoLenRatio: v.clamp(torsoLen / shoulderW, 0.8, 2.8),
    leftSleeveLenRatio: v.clamp(l.lenRatio, 0, 1.6),
    rightSleeveLenRatio: v.clamp(r.lenRatio, 0, 1.6),
    leftSleeveTipRatio: v.clamp(l.tipRatio, 0, 1.2),
    rightSleeveTipRatio: v.clamp(r.tipRatio, 0, 1.2),
  };
}

/** Truncate (or extend) a polyline to a target arc length, returning its knots. */
function truncatePolyline(poly: Vec2[], length: number, fallbackDir: Vec2): Vec2[] {
  if (length <= 1 || poly.length < 2) return [poly[0]!, poly[0]!];
  const out: Vec2[] = [poly[0]!];
  let remaining = length;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const seg = v.dist(a, b);
    if (seg <= remaining + 1e-3) {
      out.push(b);
      remaining -= seg;
    } else {
      out.push(v.add(a, v.scale(v.normalize(v.sub(b, a)), remaining)));
      remaining = 0;
      break;
    }
  }
  if (remaining > 1 && out.length >= 1) {
    const last = out[out.length - 1]!;
    const prev = out.length >= 2 ? out[out.length - 2]! : v.sub(last, fallbackDir);
    let dir = v.sub(last, prev);
    dir = v.len(dir) > 1e-3 ? v.normalize(dir) : fallbackDir;
    out[out.length - 1] = v.add(last, v.scale(dir, remaining));
  }
  return out;
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
  if (segs.length === 0) {
    const p = knots[0] ?? { x: 0, y: 0 };
    return { pointAt: () => p };
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
