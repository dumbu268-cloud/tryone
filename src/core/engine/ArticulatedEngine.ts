import type {
  ArmTrackState,
  FitResult,
  GarmentAsset,
  GarmentRig,
  PoseFrame,
  Quad,
  TryOnEngine,
  Vec2,
} from '@/core/types';
import { buildGarmentMesh, type GarmentMesh, type SleeveSource } from '@/core/garment/mesh';
import { BODY, estimateBodyKeypoints, type ArmChainIdx, type BodyKeypoints, type LandmarkPx } from '@/core/fit/bodyRig';
import { solveAffine, solveTps, type Warp2D } from '@/core/math/tps';
import { fitPolylineLength, makeTube } from '@/core/fit/tube';
import { PoseLandmark } from '@/core/perception/landmarks';
import * as v from '@/core/math/vec';

/**
 * Rig-based try-on engine.
 *
 * Torso: thin-plate-spline warp from the garment's own keypoints (neck sides,
 * shoulder tips, armpits, hem) to the user's body keypoints. Neck/shoulders/
 * armpits come from the body; the hem keeps the garment's own length and taper,
 * so different garments produce different geometry. The torso never depends on
 * arm landmarks.
 *
 * Sleeves: tubes along shoulder→elbow→wrist. The upper sleeve needs only the
 * elbow; a missing wrist extends the forearm instead of disabling the arm.
 * Joint reliability includes "is it inside the frame" and uses hysteresis; when
 * an arm is lost, the last good pose is held (in body-relative coordinates) and
 * eases to a natural resting hang. Sleeves never disappear.
 */

export interface ArticulatedOptions {
  /** Fade time constant (ms); frame-rate independent. */
  fadeMs?: number;
  /** How long to hold the last fit when the person is lost (ms). */
  holdMs?: number;
  /** Time constant for a lost arm easing to rest (ms). */
  armDecayMs?: number;
}

const DEFAULTS: Required<ArticulatedOptions> = { fadeMs: 140, holdMs: 700, armDecayMs: 900 };

const ZERO_QUAD: Quad = {
  tl: { x: 0, y: 0 },
  tr: { x: 0, y: 0 },
  br: { x: 0, y: 0 },
  bl: { x: 0, y: 0 },
};

/** Flat-lay sleeves are a flattened tube: worn projected width ≈ 2/π of it. */
const FLAT_TO_WORN = 2 / Math.PI;

interface JointTrack {
  rel: number; // smoothed reliability
  on: boolean; // hysteresis state
  lastGood: Vec2 | null; // body-relative
  lastGoodT: number;
}

interface ArmTrack {
  elbow: JointTrack;
  wrist: JointTrack;
  /** Last good forearm direction (body-relative unit vector). */
  forearmDir: Vec2 | null;
}

const newJoint = (): JointTrack => ({ rel: 0, on: false, lastGood: null, lastGoodT: -Infinity });
const newArm = (): ArmTrack => ({ elbow: newJoint(), wrist: newJoint(), forearmDir: null });

export class ArticulatedEngine implements TryOnEngine {
  readonly id = 'rig-tps-v3';
  private readonly opts: Required<ArticulatedOptions>;
  private mesh: GarmentMesh | null = null;
  private rig: GarmentRig | null = null;
  private positions: Float32Array = new Float32Array(0);
  private opacity = 0;
  private hipRel = 0;
  private arms: [ArmTrack, ArmTrack] = [newArm(), newArm()];
  private last: FitResult | null = null;
  private lastValidT = -Infinity;
  private lastT: number | null = null;

  constructor(options: ArticulatedOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  prepare(garment: GarmentAsset): void {
    this.mesh = buildGarmentMesh(garment);
    this.rig = this.mesh.rig;
    this.positions = new Float32Array(this.mesh.vertexCount * 2);
    this.opacity = 0;
    this.arms = [newArm(), newArm()];
    this.last = null;
    this.lastT = null;
  }

  fit(frame: PoseFrame): FitResult {
    const mesh = this.mesh;
    const rig = this.rig;
    if (!mesh || !rig) return invisible();
    const now = frame.timestamp;
    const dt = this.lastT === null ? 33 : v.clamp(now - this.lastT, 1, 250);
    this.lastT = now;
    const k = 1 - Math.exp(-dt / this.opts.fadeMs);

    const lm = this.reliableLandmarks(frame);
    const body = frame.valid && lm ? estimateBodyKeypoints(lm, this.hipRel) : null;

    if (!body) {
      // Hold the last fit briefly (landmark dropouts), then fade out.
      if (this.last && now - this.lastValidT < this.opts.holdMs) return { ...this.last };
      this.opacity += (0 - this.opacity) * k;
      if (this.opacity < 0.02) this.opacity = 0;
      return this.last
        ? { ...this.last, opacity: this.opacity, visible: this.opacity > 0.02 }
        : { ...invisible(), opacity: this.opacity };
    }
    this.lastValidT = now;
    this.opacity += (1 - this.opacity) * k;

    // --- Torso: TPS from garment keypoints → body keypoints ------------------
    const hem = this.hemTargets(rig, body);
    const src = [rig.neckL, rig.neckR, rig.shoulderL, rig.shoulderR, rig.armpitL, rig.armpitR, rig.hemL, rig.hemR];
    const dst = [body.neckL, body.neckR, body.shoulderL, body.shoulderR, body.armpitL, body.armpitR, hem.l, hem.r];
    const warp: Warp2D | null = solveTps(src, dst, 1e-4) ?? solveAffine(src, dst);
    if (!warp) return this.last ?? invisible();

    const pos = this.positions;
    const { region, texPx, paramA, paramB } = mesh;
    // --- Sleeves --------------------------------------------------------------
    const scale = v.dist(body.shoulderL, body.shoulderR) / Math.max(1, v.dist(rig.shoulderL, rig.shoulderR));
    const flat = rig.source !== 'pose';
    const armL = this.trackArm(0, lm!, body, body.armL, -1, now);
    const armR = this.trackArm(1, lm!, body, body.armR, 1, now);
    const tubeL = this.sleeveTube(mesh.sleeveL, 'L', body, armL.chain, scale, flat);
    const tubeR = this.sleeveTube(mesh.sleeveR, 'R', body, armR.chain, scale, flat);

    for (let i = 0; i < mesh.vertexCount; i++) {
      let p: Vec2;
      const reg = region[i];
      if (reg === 0) p = warp.map({ x: texPx[i * 2]!, y: texPx[i * 2 + 1]! });
      else if (reg === 1 && tubeL) p = tubeL.pointAt(paramA[i]!, paramB[i]!);
      else if (reg === 2 && tubeR) p = tubeR.pointAt(paramA[i]!, paramB[i]!);
      else p = body.center;
      pos[i * 2] = p.x;
      pos[i * 2 + 1] = p.y;
    }

    const shoulderZ =
      ((frame.normalized[PoseLandmark.LEFT_SHOULDER]?.z ?? 0) + (frame.normalized[PoseLandmark.RIGHT_SHOULDER]?.z ?? 0)) / 2;
    const behind = (chain: ArmChainIdx, state: ArmTrackState) => {
      if (state === 'rest' || state === 'held') return false;
      const zw = frame.normalized[chain.wrist]?.z ?? 0;
      const ze = frame.normalized[chain.elbow]?.z ?? 0;
      return Math.min(zw, ze) > shoulderZ + 0.12;
    };

    const result: FitResult = {
      quad: { tl: body.shoulderL, tr: body.shoulderR, br: hem.r, bl: hem.l },
      opacity: this.opacity,
      visible: this.opacity > 0.02,
      positions: pos,
      leftSleeveBehind: behind(body.armL, armL.state),
      rightSleeveBehind: behind(body.armR, armR.state),
      debug: {
        keypoints: dst,
        arms: [
          { state: armL.state, chain: armL.chain },
          { state: armR.state, chain: armR.chain },
        ],
      },
    };
    this.last = result;
    return result;
  }

  /** Landmarks in screen px with reliability = visibility × in-frame. Updates hip reliability. */
  private reliableLandmarks(frame: PoseFrame): LandmarkPx[] | null {
    if (frame.image.length < 33 || frame.normalized.length < 33) return null;
    const out: LandmarkPx[] = new Array(33);
    for (let i = 0; i < 33; i++) {
      const n = frame.normalized[i]!;
      const p = frame.image[i]!;
      const f = inFrame(n.x, n.y);
      out[i] = { x: p.x, y: p.y, visibility: (n.visibility ?? 0) * f, inFrame: f, raw: n.visibility ?? 0 };
    }
    const hip = Math.min(out[PoseLandmark.LEFT_HIP]!.visibility, out[PoseLandmark.RIGHT_HIP]!.visibility);
    this.hipRel += (smooth01(0.45, 0.75, hip) - this.hipRel) * 0.3;
    return out;
  }

  /** Hem keeps the garment's own length + taper, placed along the body's torso direction. */
  private hemTargets(rig: GarmentRig, body: BodyKeypoints): { l: Vec2; r: Vec2 } {
    const gO = v.mid(rig.shoulderL, rig.shoulderR);
    const gX = v.normalize(v.sub(rig.shoulderR, rig.shoulderL));
    const gY = { x: -gX.y, y: gX.x };
    const gPitMid = v.mid(rig.armpitL, rig.armpitR);
    const gPitW = Math.max(1, v.dist(rig.armpitL, rig.armpitR));

    const bO = v.mid(body.shoulderL, body.shoulderR);
    const s = v.dist(body.shoulderL, body.shoulderR) / Math.max(1, v.dist(rig.shoulderL, rig.shoulderR));
    const bPitMid = v.mid(body.armpitL, body.armpitR);
    const bPitW = v.dist(body.armpitL, body.armpitR);
    const hemAxis = body.hipAxis;
    const bY = body.torsoDir;

    // Depth below the shoulders scales with body size; width keeps the garment's
    // hem/chest ratio relative to the body's chest (armpit) width.
    const place = (p: Vec2): Vec2 => {
      const depth = v.dot(v.sub(p, gO), gY) * s;
      const across = (v.dot(v.sub(p, gPitMid), gX) / gPitW) * bPitW;
      const pitDepth = v.dot(v.sub(bPitMid, bO), bY);
      const base = v.add(bPitMid, v.scale(bY, depth - pitDepth));
      return v.add(base, v.scale(hemAxis, across));
    };
    return { l: place(rig.hemL), r: place(rig.hemR) };
  }

  private trackArm(
    idx: 0 | 1,
    lm: LandmarkPx[],
    body: BodyKeypoints,
    chain: ArmChainIdx,
    side: -1 | 1,
    now: number,
  ): { state: ArmTrackState; chain: Vec2[] } {
    const arm = this.arms[idx];
    const joint = side < 0 ? body.jointL : body.jointR;
    const toRel = (p: Vec2): Vec2 => {
      const d = v.sub(p, joint);
      return { x: v.dot(d, body.axis) / body.span, y: v.dot(d, body.torsoDir) / body.span };
    };
    const fromRel = (r: Vec2): Vec2 =>
      v.add(joint, v.add(v.scale(body.axis, r.x * body.span), v.scale(body.torsoDir, r.y * body.span)));

    const update = (j: JointTrack, raw: number) => {
      j.rel += (raw - j.rel) * 0.45;
      j.on = j.on ? j.rel > 0.35 : j.rel > 0.55;
    };
    update(arm.elbow, lm[chain.elbow]!.visibility);
    update(arm.wrist, lm[chain.wrist]!.visibility);

    const restElbow: Vec2 = { x: side * 0.1, y: BODY.upperArm * 0.98 };
    const restForearm: Vec2 = v.normalize({ x: side * 0.08, y: 1 });
    const decay = (t0: number) => 1 - Math.exp(-Math.max(0, now - t0) / this.opts.armDecayMs);

    // MediaPipe also PREDICTS occluded joints (e.g. a hand behind the head): low
    // visibility means "covered", not "unknown". Use the prediction when it is in
    // frame and anatomically plausible instead of a canned fallback pose.
    const predicted = (i: number, from: Vec2, expect: number): Vec2 | null => {
      const p = lm[i]!;
      if ((p.inFrame ?? 1) < 0.5 || (p.raw ?? p.visibility) < 0.08) return null;
      const rel = toRel(p);
      const len = v.dist(rel, from);
      return len >= 0.3 * expect && len <= 1.45 * expect ? rel : null;
    };
    let elbowPred = false;
    let wristPred = false;

    // Elbow: tracked, else predicted (occluded), else inferred from a visible
    // wrist (two-bone IK), else held → rest.
    let elbowRel: Vec2;
    const pe = arm.elbow.on ? null : predicted(chain.elbow, { x: 0, y: 0 }, BODY.upperArm);
    if (arm.elbow.on) {
      elbowRel = toRel(lm[chain.elbow]!);
      arm.elbow.lastGood = elbowRel;
      arm.elbow.lastGoodT = now;
    } else if (pe && (!arm.wrist.on || predictedFits(toRel(lm[chain.wrist]!), pe, BODY.forearm))) {
      elbowRel = pe;
      elbowPred = true;
      arm.elbow.lastGood = elbowRel;
      arm.elbow.lastGoodT = now;
    } else if (arm.wrist.on) {
      elbowRel = ikElbow(toRel(lm[chain.wrist]!), BODY.upperArm, BODY.forearm, side);
      arm.elbow.lastGood = elbowRel;
      arm.elbow.lastGoodT = now;
    } else {
      const held = arm.elbow.lastGood ?? restElbow;
      elbowRel = v.lerp(held, restElbow, arm.elbow.lastGood ? decay(arm.elbow.lastGoodT) : 1);
    }

    // Forearm direction.
    const upperDir = v.normalize(elbowRel);
    const naturalForearm = v.normalize(v.lerp(upperDir, restForearm, 0.5));
    let forearmDir: Vec2;
    let wristRel: Vec2;
    const pw = arm.wrist.on ? null : predicted(chain.wrist, elbowRel, BODY.forearm);
    if (arm.wrist.on || pw) {
      wristRel = pw ?? toRel(lm[chain.wrist]!);
      wristPred = !!pw;
      const d = v.sub(wristRel, elbowRel);
      forearmDir = v.len(d) > 1e-3 ? v.normalize(d) : naturalForearm;
      arm.forearmDir = forearmDir;
      arm.wrist.lastGoodT = now;
    } else {
      const held = arm.forearmDir ?? naturalForearm;
      forearmDir = v.normalize(v.lerp(held, naturalForearm, arm.forearmDir ? decay(arm.wrist.lastGoodT) : 1));
      wristRel = v.add(elbowRel, v.scale(forearmDir, BODY.forearm));
    }

    const state: ArmTrackState =
      arm.elbow.on && arm.wrist.on
        ? 'tracked'
        : arm.elbow.on || arm.wrist.on || elbowPred || wristPred
          ? 'partial'
          : arm.elbow.lastGood && now - arm.elbow.lastGoodT < 2.5 * this.opts.armDecayMs
            ? 'held'
            : 'rest';
    return { state, chain: [joint, fromRel(elbowRel), fromRel(wristRel)] };
  }

  private sleeveTube(
    src: SleeveSource | null,
    side: 'L' | 'R',
    body: BodyKeypoints,
    chain: Vec2[],
    scale: number,
    flat: boolean,
  ) {
    if (!src) return null;
    const tip = side === 'L' ? body.shoulderL : body.shoulderR;
    const pit = side === 'L' ? body.armpitL : body.armpitR;
    const root = v.mid(tip, pit);
    const widthK = flat ? FLAT_TO_WORN : 1;
    const span = body.span;
    // Sleeve length is a fraction of the user's OWN arm (armhole → elbow → wrist),
    // so a long sleeve ends at the wrist for any arm length or camera angle
    // (forearms pointing at the camera look short on screen).
    const upper = v.dist(root, chain[1]!);
    const armLen = upper + v.dist(chain[1]!, chain[2]!);
    const length = Math.max(4, src.coverage * armLen);
    const axis = fitPolylineLength(smoothArmAxis([root, chain[1]!, chain[2]!]), length);
    const reachesForearm = length > upper * 1.05;
    const sourceMid = src.rig.rootHalfWidth * scale * widthK;
    const sourceTip = src.rig.tipHalfWidth * scale * widthK;
    const mid = v.clamp(sourceMid, 0.1 * span, 0.23 * span);
    const cuff = v.clamp(sourceTip, reachesForearm ? 0.07 * span : 0.09 * span, 0.18 * span);
    return makeTube(
      axis,
      {
        root: v.dist(tip, pit) / 2,
        mid,
        tip: cuff,
      },
      side,
      v.sub(pit, tip),
      src.cap,
      'pinned',
    );
  }

  dispose(): void {
    this.mesh = null;
    this.rig = null;
    this.positions = new Float32Array(0);
    this.opacity = 0;
    this.last = null;
  }
}

function smoothArmAxis(points: [Vec2, Vec2, Vec2]): Vec2[] {
  const [p0, p1, p2] = points;
  const m0 = v.sub(p1, p0);
  const m1 = v.scale(v.sub(p2, p0), 0.5);
  const m2 = v.sub(p2, p1);
  const out: Vec2[] = [];
  const segment = (a: Vec2, b: Vec2, ma: Vec2, mb: Vec2, includeStart: boolean) => {
    const steps = 10;
    for (let i = includeStart ? 0 : 1; i <= steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push({
        x: h00 * a.x + h10 * ma.x + h01 * b.x + h11 * mb.x,
        y: h00 * a.y + h10 * ma.y + h01 * b.y + h11 * mb.y,
      });
    }
  };
  segment(p0, p1, m0, m1, true);
  segment(p1, p2, m1, m2, false);
  return out;
}

/**
 * Two-bone IK in body-relative coordinates (shoulder joint at the origin, y =
 * down the torso). Of the two elbow solutions, picks the lower one (elbows
 * hang), breaking ties outward.
 */
function ikElbow(wrist: Vec2, upper: number, fore: number, side: -1 | 1): Vec2 {
  const dRaw = v.len(wrist);
  if (dRaw < 1e-6) return { x: side * 0.1, y: upper };
  const d = v.clamp(dRaw, Math.abs(upper - fore) + 1e-3, upper + fore - 1e-3);
  const dir = v.scale(wrist, 1 / dRaw);
  const cosA = v.clamp((upper * upper + d * d - fore * fore) / (2 * upper * d), -1, 1);
  const a = Math.acos(cosA);
  const rot = (ang: number): Vec2 => ({
    x: (dir.x * Math.cos(ang) - dir.y * Math.sin(ang)) * upper,
    y: (dir.x * Math.sin(ang) + dir.y * Math.cos(ang)) * upper,
  });
  const e1 = rot(a);
  const e2 = rot(-a);
  if (Math.abs(e1.y - e2.y) > 1e-3) return e1.y > e2.y ? e1 : e2;
  return e1.x * side > e2.x * side ? e1 : e2;
}

/** Is the predicted segment from `a` to `b` of plausible length (body-relative units)? */
function predictedFits(a: Vec2, b: Vec2, expect: number): boolean {
  const len = v.dist(a, b);
  return len >= 0.3 * expect && len <= 1.45 * expect;
}

function inFrame(x: number, y: number): number {
  const m = 0.02;
  const e = Math.min(x, 1 - x, y, 1 - y);
  return v.clamp((e + m) / (2 * m), 0, 1);
}

function smooth01(a: number, b: number, x: number): number {
  const t = v.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function invisible(): FitResult {
  return { quad: ZERO_QUAD, opacity: 0, visible: false };
}
