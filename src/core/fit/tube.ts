import type { Vec2 } from '@/core/types';
import * as v from '@/core/math/vec';

// A sleeve tube: a polyline skeleton with a cross-section, parameterized by
// t ∈ [0,1] (arc length) and s ∈ [-1,1] (across).
//   - s = -1 is the shoulder-tip side, s = +1 the armpit/underside, in texture
//     space and on the user alike (fixed rotation sense per side).
//   - At t = 0 the cross-section lies exactly on the armhole line (shoulder tip →
//     armpit), then rotates to be perpendicular to the arm over the "cap". This
//     keeps the sleeve attached to the torso at any arm angle (no gap/crease).

export interface TubeProfile {
  /** Half-width at the armhole (t = 0). */
  root: number;
  /** Half-width just past the shoulder cap. */
  mid: number;
  /** Half-width at the cuff (t = 1). */
  tip: number;
}

export interface Tube {
  length: number;
  pointAt(t: number, s: number): Vec2;
}

export function polylineLength(pts: readonly Vec2[]): number {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += v.dist(pts[i]!, pts[i + 1]!);
  return L;
}

/** Truncate or extend a polyline to exactly `length` (extends along the last segment). */
export function fitPolylineLength(pts: readonly Vec2[], length: number): Vec2[] {
  if (pts.length < 2 || length <= 1e-6) return [pts[0]!, pts[0]!];
  const out: Vec2[] = [pts[0]!];
  let remaining = length;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = v.dist(a, b);
    if (seg < 1e-6) continue;
    if (seg >= remaining) {
      out.push(v.add(a, v.scale(v.sub(b, a), remaining / seg)));
      return out;
    }
    out.push(b);
    remaining -= seg;
  }
  const last = out[out.length - 1]!;
  let dir: Vec2 = { x: 0, y: 1 };
  for (let i = out.length - 1; i > 0; i--) {
    const d = v.sub(out[i]!, out[i - 1]!);
    if (v.len(d) > 1e-6) {
      dir = v.normalize(d);
      break;
    }
  }
  out[out.length - 1] = v.add(last, v.scale(dir, remaining));
  return out;
}

/** Shoulder-cap fraction shared by the texture-space and screen-space tubes. */
export function capFraction(rootHalf: number, length: number): number {
  return length > 1e-6 ? v.clamp((1.3 * rootHalf) / length, 0.12, 0.45) : 0.3;
}

function sideNormal(dir: Vec2, side: 'L' | 'R'): Vec2 {
  return side === 'L' ? { x: dir.y, y: -dir.x } : { x: -dir.y, y: dir.x };
}

/** Rotate unit vector a toward b by fraction w along the shorter arc. */
function slerp2(a: Vec2, b: Vec2, w: number): Vec2 {
  const aa = Math.atan2(a.y, a.x);
  let d = Math.atan2(b.y, b.x) - aa;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const ang = aa + d * v.clamp(w, 0, 1);
  return { x: Math.cos(ang), y: Math.sin(ang) };
}

export function makeTube(
  axis: readonly Vec2[],
  profile: TubeProfile,
  side: 'L' | 'R',
  rootNormal: Vec2,
  cap: number,
): Tube {
  const segs: { a: Vec2; dir: Vec2; n: Vec2; len: number; start: number }[] = [];
  let total = 0;
  for (let i = 0; i < axis.length - 1; i++) {
    const a = axis[i]!;
    const b = axis[i + 1]!;
    const len = v.dist(a, b);
    if (len < 1e-6) continue;
    const dir = v.scale(v.sub(b, a), 1 / len);
    segs.push({ a, dir, n: sideNormal(dir, side), len, start: total });
    total += len;
  }
  const origin = axis[0] ?? { x: 0, y: 0 };
  if (segs.length === 0) return { length: 0, pointAt: () => origin };
  const rn = v.len(rootNormal) > 1e-6 ? v.normalize(rootNormal) : segs[0]!.n;

  const halfAt = (t: number): number =>
    t < cap
      ? v.lerpN(profile.root, profile.mid, t / cap)
      : v.lerpN(profile.mid, profile.tip, (t - cap) / Math.max(1e-6, 1 - cap));

  return {
    length: total,
    pointAt(tIn: number, s: number): Vec2 {
      const t = v.clamp(tIn, 0, 1);
      const d = t * total;
      let k = segs.length - 1;
      for (let i = 0; i < segs.length; i++) {
        if (d <= segs[i]!.start + segs[i]!.len) {
          k = i;
          break;
        }
      }
      const seg = segs[k]!;
      const local = d - seg.start;
      const center = v.add(seg.a, v.scale(seg.dir, local));

      // Segment normal, smoothly blended across the elbow.
      let n = seg.n;
      const blend = Math.min(seg.len * 0.3, 0.08 * total);
      if (k > 0 && local < blend) n = slerp2(segs[k - 1]!.n, seg.n, 0.5 + 0.5 * (local / blend));
      else if (k < segs.length - 1 && seg.len - local < blend)
        n = slerp2(segs[k + 1]!.n, seg.n, 0.5 + 0.5 * ((seg.len - local) / blend));
      // Shoulder cap: start on the armhole line, rotate to the arm normal.
      if (t < cap) {
        const w = t / cap;
        n = slerp2(rn, n, w * w * (3 - 2 * w));
      }
      return v.add(center, v.scale(n, s * halfAt(t)));
    },
  };
}
