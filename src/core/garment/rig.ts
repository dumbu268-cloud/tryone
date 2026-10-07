import type { GarmentLayout, GarmentRig, SleeveRig, Vec2 } from '@/core/types';
import { estimateBodyKeypoints, type LandmarkPx } from '@/core/fit/bodyRig';
import { fitPolylineLength, polylineLength } from '@/core/fit/tube';
import { rowRuns, runAt } from '@/core/garment/prep/maskOps';
import * as v from '@/core/math/vec';

// Garment rig extraction: named keypoints + sleeve skeletons in texture space.
//   - rigFromPose:       product photo of a model wearing the garment. Keypoints
//                        come from the model's own pose via the SAME estimator
//                        used on the live user → 1:1 body correspondence.
//   - rigFromSilhouette: flat-lay / person-less image, from the garment outline.
//   - rigFromLayout:     legacy coarse layouts (hand-authored quads).

export type SleeveClass = 'none' | 'short' | 'long';

export interface PoseRigResult {
  rig: GarmentRig;
  sleeveLength: SleeveClass;
}

const at = (mask: Uint8Array, w: number, h: number, p: Vec2): boolean => {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]! > 0;
};

// --- legacy layouts -------------------------------------------------------

export function rigFromLayout(layout: GarmentLayout): GarmentRig {
  const t = layout.torso;
  const sleeve = (s: GarmentLayout['leftSleeve']): SleeveRig | null => {
    const root = v.mid(s.rootTop, s.rootBottom);
    const tip = v.mid(s.tipTop, s.tipBottom);
    if (v.dist(root, tip) < 2) return null;
    return {
      axis: [root, tip],
      rootHalfWidth: v.dist(s.rootTop, s.rootBottom) / 2,
      tipHalfWidth: Math.max(1, v.dist(s.tipTop, s.tipBottom) / 2),
    };
  };
  const sl = sleeve(layout.leftSleeve);
  const sr = sleeve(layout.rightSleeve);
  const sideDrop = v.scale(v.sub(t.bl, t.tl), 0.3);
  return {
    neckL: v.lerp(t.tl, t.tr, 0.36),
    neckR: v.lerp(t.tl, t.tr, 0.64),
    shoulderL: t.tl,
    shoulderR: t.tr,
    armpitL: sl ? layout.leftSleeve.rootBottom : v.add(t.tl, sideDrop),
    armpitR: sr ? layout.rightSleeve.rootBottom : v.add(t.tr, sideDrop),
    hemL: t.bl,
    hemR: t.br,
    sleeveL: sl,
    sleeveR: sr,
    source: 'layout',
  };
}

// --- flat-lay silhouette --------------------------------------------------

export function rigFromSilhouette(mask: Uint8Array, w: number, h: number, layout: GarmentLayout): GarmentRig {
  const t = layout.torso;
  const xL = Math.round(t.tl.x);
  const xR = Math.round(t.tr.x);
  const hemY = Math.round(t.bl.y);
  const width = Math.max(1, xR - xL);

  const topRow = (x: number): number => {
    const xx = v.clamp(Math.round(x), 0, w - 1);
    for (let y = 0; y < h; y++) if (mask[y * w + xx]) return y;
    return Math.round(t.tl.y);
  };

  // Neck sides: highest top-contour points either side of the collar dip.
  const cx = (xL + xR) / 2;
  const findPeak = (x0: number, x1: number): Vec2 => {
    let best = { x: (x0 + x1) / 2, y: Infinity };
    let worst = -Infinity;
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const y = topRow(x);
      worst = Math.max(worst, y);
      if (y < best.y) best = { x, y };
    }
    return worst - best.y < 0.01 * h ? { x: NaN, y: best.y } : best;
  };
  let neckL = findPeak(xL + 0.12 * width, cx - 0.04 * width);
  let neckR = findPeak(cx + 0.04 * width, xR - 0.12 * width);
  if (!Number.isFinite(neckL.x)) neckL = { x: cx - 0.18 * width, y: topRow(cx - 0.18 * width) };
  if (!Number.isFinite(neckR.x)) neckR = { x: cx + 0.18 * width, y: topRow(cx + 0.18 * width) };

  const shoulderL = { x: xL, y: topRow(xL) };
  const shoulderR = { x: xR, y: topRow(xR) };

  // Armpit per side: the first row below the shoulder where the body's central
  // run ends at the torso side, i.e. the sleeve has separated from the body.
  // Works for flat-lay sleeves (sticking out) and hanging sleeves (with a gap).
  const armpit = (side: -1 | 1, xs: number, y0: number): Vec2 => {
    const tol = Math.max(2, 0.03 * width);
    const out = Math.max(4, 0.06 * width); // the sleeve must clearly stick out first
    const yMax = Math.min(hemY - 1, Math.round(y0 + 1.1 * width));
    let seen = false;
    for (let y = Math.round(y0) + 1; y <= yMax; y++) {
      const run = runAt(rowRuns(mask, w, y), cx);
      if (!run) continue;
      const beyond = side < 0 ? xs - run.s : run.e - xs; // how far the body run extends past the side
      if (beyond > out) seen = true;
      else if (seen && beyond <= tol) return { x: xs, y };
    }
    return { x: xs, y: Math.round(y0 + Math.min(0.45 * width, (hemY - y0) * 0.3)) };
  };
  const armpitL = armpit(-1, xL, shoulderL.y);
  const armpitR = armpit(1, xR, shoulderR.y);

  const sleeveFrom = (side: -1 | 1, tip: Vec2, pit: Vec2): SleeveRig | null => {
    const sideLayout = side < 0 ? layout.leftSleeve : layout.rightSleeve;
    if (v.dist(sideLayout.rootTop, sideLayout.tipTop) < 2) return null;
    const root = v.mid(tip, pit);
    // Sleeve pixels: beyond the torso side, above the hem.
    let far: Vec2 | null = null;
    let farD = 0;
    const xs = side < 0 ? 0 : Math.round(tip.x) + 2;
    const xe = side < 0 ? Math.round(tip.x) - 2 : w - 1;
    for (let y = 0; y < hemY; y++) {
      for (let x = xs; x <= xe; x++) {
        if (!mask[y * w + x]) continue;
        const d = Math.hypot(x - root.x, y - root.y);
        if (d > farD) {
          farD = d;
          far = { x, y };
        }
      }
    }
    if (!far || farD < 0.08 * width) return null;
    const dir = v.normalize(v.sub(far, root));
    // Cuff centre: centroid of the outermost 12% of sleeve pixels along dir.
    let sx = 0;
    let sy = 0;
    let n = 0;
    let minP = Infinity;
    let maxP = -Infinity;
    const perp = { x: -dir.y, y: dir.x };
    for (let y = 0; y < hemY; y++) {
      for (let x = xs; x <= xe; x++) {
        if (!mask[y * w + x]) continue;
        const proj = (x - root.x) * dir.x + (y - root.y) * dir.y;
        if (proj < 0.88 * farD) continue;
        sx += x;
        sy += y;
        n++;
        const q = (x - root.x) * perp.x + (y - root.y) * perp.y;
        minP = Math.min(minP, q);
        maxP = Math.max(maxP, q);
      }
    }
    if (n === 0) return null;
    const cuff = { x: sx / n, y: sy / n };
    const len = v.dist(root, cuff);
    // Measured fabric half-width across the sleeve (outward of the torso side only).
    const sdir = v.normalize(v.sub(cuff, root));
    const sn = { x: -sdir.y, y: sdir.x };
    const outward = (p: Vec2) => (side < 0 ? p.x < tip.x - 1 : p.x > tip.x + 1);
    const widthAt = (f: number): number => {
      const c = v.add(root, v.scale(sdir, f * len));
      const lim = 0.6 * width;
      let a = 0;
      let b = 0;
      while (a < lim && at(mask, w, h, v.add(c, v.scale(sn, a + 1))) && outward(v.add(c, v.scale(sn, a + 1)))) a++;
      while (b < lim && at(mask, w, h, v.sub(c, v.scale(sn, b + 1))) && outward(v.sub(c, v.scale(sn, b + 1)))) b++;
      return (a + b) / 2;
    };
    const midHalf = widthAt(0.4);
    return {
      axis: [root, cuff],
      rootHalfWidth: midHalf >= 2 ? Math.min(midHalf, v.dist(tip, pit) / 2) : v.dist(tip, pit) / 2,
      tipHalfWidth: Math.max(2, (maxP - minP) / 2),
    };
  };

  const hasSleeves =
    v.dist(layout.leftSleeve.rootTop, layout.leftSleeve.tipTop) >= 2 ||
    v.dist(layout.rightSleeve.rootTop, layout.rightSleeve.tipTop) >= 2;
  return {
    neckL,
    neckR,
    shoulderL,
    shoulderR,
    armpitL,
    armpitR,
    hemL: { x: xL, y: hemY },
    hemR: { x: xR, y: hemY },
    sleeveL: hasSleeves ? sleeveFrom(-1, shoulderL, armpitL) : null,
    sleeveR: hasSleeves ? sleeveFrom(1, shoulderR, armpitR) : null,
    source: 'silhouette',
  };
}

/** Typical shoulder-seam → wrist length relative to shoulder width. */
const ARM_PER_SHOULDER = 1.42;

/** Fraction of the arm a sleeve covers (see SleeveRig.coverage). */
export function sleeveCoverage(rig: GarmentRig, s: SleeveRig): number {
  if (s.coverage !== undefined) return v.clamp(s.coverage, 0.1, 1.05);
  const sw = Math.max(1, v.dist(rig.shoulderL, rig.shoulderR));
  const ratio = polylineLength(s.axis) / sw;
  const raw = ratio / ARM_PER_SHOULDER;
  // A long sleeve ends at the wrist whatever its flat-lay proportions.
  return ratio > 0.9 ? v.clamp(raw, 1.0, 1.05) : v.clamp(raw, 0.12, 0.7);
}

/**
 * Sleeve length class from a rig: a sleeve's own length relative to the shoulder
 * width (shoulder seam → cuff). Robust to sleeve DIRECTION, unlike measuring how
 * far a sleeve sticks out sideways (which reads hanging long sleeves as short).
 */
export function sleeveClassFromRig(rig: GarmentRig): SleeveClass {
  const sw = Math.max(1, v.dist(rig.shoulderL, rig.shoulderR));
  const len = (s: SleeveRig | null) => (s ? polylineLength(s.axis) : 0);
  const ratio = Math.max(len(rig.sleeveL), len(rig.sleeveR)) / sw;
  if (!rig.sleeveL && !rig.sleeveR) return 'none';
  return ratio > 0.9 ? 'long' : 'short';
}

// --- worn garment (source pose) --------------------------------------------

export function rigFromPose(
  mask: Uint8Array,
  w: number,
  h: number,
  pose: readonly LandmarkPx[],
): PoseRigResult | null {
  const hipVis = Math.min(pose[23]?.visibility ?? 0, pose[24]?.visibility ?? 0);
  const body = estimateBodyKeypoints(pose, hipVis > 0.5 ? 1 : 0, 6);
  if (!body) return null;
  const span = body.span;

  // Hem: lowest garment row inside the torso band, measured just above the bottom.
  const bandL = Math.round(body.armpitL.x - 0.3 * span);
  const bandR = Math.round(body.armpitR.x + 0.3 * span);
  let hemY = -1;
  for (let y = h - 1; y >= 0 && hemY < 0; y--) {
    for (let x = Math.max(0, bandL); x <= Math.min(w - 1, bandR); x++) {
      if (mask[y * w + x]) {
        hemY = y;
        break;
      }
    }
  }
  if (hemY < body.armpitL.y + 0.2 * span) return null; // no real torso garment
  const rowY = Math.round(hemY - 0.04 * (hemY - body.neckL.y));
  let hx0 = -1;
  let hx1 = -1;
  for (let x = Math.max(0, bandL); x <= Math.min(w - 1, bandR); x++) {
    if (mask[rowY * w + x]) {
      if (hx0 < 0) hx0 = x;
      hx1 = x;
    }
  }
  if (hx0 < 0) return null;

  // Sleeve = garment pixels OUTSIDE the torso side line (armpit, along the torso
  // direction) and near the model's arm. Its extent is measured along the arm
  // from the shoulder JOINT, which is how sleeve length is defined (a tee sleeve
  // reaches ~⅓ of the upper arm, a long sleeve reaches the wrist).
  const sleeve = (side: 'L' | 'R'): { rig: SleeveRig | null; ratio: number } => {
    const chain = side === 'L' ? body.armL : body.armR;
    const tip = side === 'L' ? body.shoulderL : body.shoulderR;
    const pit = side === 'L' ? body.armpitL : body.armpitR;
    const joint = side === 'L' ? body.jointL : body.jointR;
    const elbow = pose[chain.elbow];
    const wrist = pose[chain.wrist];
    if (!elbow || elbow.visibility < 0.3) return { rig: null, ratio: 0 };
    const upperLen = Math.max(1, v.dist(joint, elbow));
    const arm: Vec2[] = [joint, elbow];
    if (wrist && wrist.visibility > 0.3) arm.push(wrist);

    // Sleeve extent = contiguous fabric along the arm's CENTRE LINE, starting at
    // the shoulder joint. Torso fabric lies beside a hanging arm, not on its
    // centre line, so it is never mistaken for sleeve; bare skin ends the run.
    const ext = fitPolylineLength(arm, polylineLength(arm) * 1.12); // cuffs may pass the wrist point
    const total = polylineLength(ext);
    const step = Math.max(1, total / 160);
    const tol = Math.max(1, 0.03 * span);
    const onFabric = (d: number): boolean => {
      const { p, dir } = frameAlong(ext, d);
      if (at(mask, w, h, p)) return true;
      const n = { x: -dir.y, y: dir.x };
      return at(mask, w, h, v.add(p, v.scale(n, tol))) && at(mask, w, h, v.sub(p, v.scale(n, tol)));
    };
    let end = -1;
    let misses = 0;
    const maxMiss = Math.max(2, Math.round((0.04 * upperLen) / step));
    for (let d = 0; d <= total; d += step) {
      if (onFabric(d)) {
        end = d;
        misses = 0;
      } else if (end < 0 && d > 0.25 * upperLen) break; // shoulder uncovered → sleeveless
      else if (end >= 0 && ++misses > maxMiss) break;
    }
    const ratio = end < 0 ? 0 : end / upperLen;
    if (ratio < 0.15) return { rig: null, ratio };

    // Axis: armhole centre → along the arm to the sleeve end.
    const root = v.mid(tip, pit);
    const rootArc = Math.max(0, projectOnPolyline(arm, root).arc);
    const length = Math.max(4, end - rootArc);
    const axis = fitPolylineLength([root, ...ext.slice(1)], length);

    // Cross-section half-width: scan outward from the centre line on both sides.
    const halfAt = (d: number): number => {
      const { p, dir } = frameAlong(ext, d);
      const n = { x: -dir.y, y: dir.x };
      const lim = 0.35 * span;
      let a = 0;
      let b = 0;
      while (a < lim && at(mask, w, h, v.add(p, v.scale(n, a + 1)))) a++;
      while (b < lim && at(mask, w, h, v.sub(p, v.scale(n, b + 1)))) b++;
      return Math.max(2, (a + b) / 2);
    };
    const armLen = upperLen + (arm.length > 2 ? v.dist(elbow, arm[2]!) : upperLen * (0.75 / 0.85));
    return {
      rig: {
        axis,
        rootHalfWidth: Math.max(halfAt(rootArc + 0.3 * length), 0.12 * span),
        tipHalfWidth: halfAt(Math.max(0, end - 2 * step)),
        coverage: v.clamp(end / armLen, 0.1, 1.05),
      },
      ratio,
    };
  };
  const sl = sleeve('L');
  const sr = sleeve('R');
  const ratio = Math.max(sl.ratio, sr.ratio);
  const sleeveLength: SleeveClass = !sl.rig && !sr.rig ? 'none' : ratio > 1.15 ? 'long' : 'short';

  return {
    rig: {
      neckL: body.neckL,
      neckR: body.neckR,
      shoulderL: body.shoulderL,
      shoulderR: body.shoulderR,
      armpitL: body.armpitL,
      armpitR: body.armpitR,
      hemL: { x: hx0, y: rowY },
      hemR: { x: hx1, y: rowY },
      sleeveL: sl.rig,
      sleeveR: sr.rig,
      source: 'pose',
    },
    sleeveLength,
  };
}

/** Point and unit direction at arc length `d` along a polyline. */
function frameAlong(pts: readonly Vec2[], d: number): { p: Vec2; dir: Vec2 } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = v.dist(a, b);
    if (seg < 1e-6) continue;
    if (acc + seg >= d || i === pts.length - 2) {
      const dir = v.scale(v.sub(b, a), 1 / seg);
      return { p: v.add(a, v.scale(dir, Math.min(seg, Math.max(0, d - acc)))), dir };
    }
    acc += seg;
  }
  return { p: pts[pts.length - 1]!, dir: { x: 0, y: 1 } };
}

/** Nearest-point projection onto a polyline: arc length, distance, signed offset. */
function projectOnPolyline(pts: readonly Vec2[], p: Vec2): { arc: number; dist: number; signed: number } {
  let best = { arc: 0, dist: Infinity, signed: 0 };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const ab = v.sub(b, a);
    const len = v.len(ab);
    if (len < 1e-6) continue;
    const dir = v.scale(ab, 1 / len);
    const ap = v.sub(p, a);
    // Let the last segment extend past its end (cuffs can pass the wrist point).
    const tMax = i === pts.length - 2 ? len * 1.5 : len;
    const t = v.clamp(v.dot(ap, dir), i === 0 ? -0.2 * len : 0, tMax);
    const q = v.add(a, v.scale(dir, t));
    const d = v.dist(p, q);
    if (d < best.dist) best = { arc: acc + t, dist: d, signed: dir.x * ap.y - dir.y * ap.x };
    acc += len;
  }
  return best;
}
