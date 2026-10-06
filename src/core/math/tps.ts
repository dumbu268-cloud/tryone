import type { Vec2 } from '@/core/types';

// 2D thin-plate spline: the smooth interpolating warp used by classic 2D virtual
// try-on (e.g. CP-VTON's geometric matching). Maps source control points
// exactly onto destination points with minimal bending in between. Solved once
// per frame for a handful of points (tiny dense system).

export interface Warp2D {
  map(p: Vec2): Vec2;
}

function kernel(r2: number): number {
  return r2 <= 1e-12 ? 0 : r2 * Math.log(r2);
}

/**
 * Solve a TPS from `src` to `dst` (same length, ≥3 non-collinear points).
 * `lambda` > 0 relaxes exact interpolation (smoothing). Returns null when the
 * system is degenerate.
 */
export function solveTps(src: readonly Vec2[], dst: readonly Vec2[], lambda = 0): Warp2D | null {
  const n = src.length;
  if (n < 3 || dst.length !== n) return null;

  // Normalize source coordinates for conditioning.
  let mx = 0;
  let my = 0;
  for (const p of src) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let scale = 0;
  for (const p of src) scale += Math.hypot(p.x - mx, p.y - my);
  scale /= n;
  if (!(scale > 1e-9)) return null;
  const sx = src.map((p) => (p.x - mx) / scale);
  const sy = src.map((p) => (p.y - my) / scale);

  const N = n + 3;
  const A: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = sx[i]! - sx[j]!;
      const dy = sy[i]! - sy[j]!;
      A[i]![j] = kernel(dx * dx + dy * dy) + (i === j ? lambda : 0);
    }
    A[i]![n] = 1;
    A[i]![n + 1] = sx[i]!;
    A[i]![n + 2] = sy[i]!;
    A[n]![i] = 1;
    A[n + 1]![i] = sx[i]!;
    A[n + 2]![i] = sy[i]!;
  }
  const bx = new Array<number>(N).fill(0);
  const by = new Array<number>(N).fill(0);
  for (let i = 0; i < n; i++) {
    bx[i] = dst[i]!.x;
    by[i] = dst[i]!.y;
  }

  const sol = solve(A, [bx, by]);
  if (!sol) return null;
  const [wx, wy] = sol as [number[], number[]];

  return {
    map(p: Vec2): Vec2 {
      const qx = (p.x - mx) / scale;
      const qy = (p.y - my) / scale;
      let x = wx[n]! + wx[n + 1]! * qx + wx[n + 2]! * qy;
      let y = wy[n]! + wy[n + 1]! * qx + wy[n + 2]! * qy;
      for (let i = 0; i < n; i++) {
        const dx = qx - sx[i]!;
        const dy = qy - sy[i]!;
        const k = kernel(dx * dx + dy * dy);
        x += wx[i]! * k;
        y += wy[i]! * k;
      }
      return { x, y };
    },
  };
}

/** Least-squares affine warp (fallback when the TPS is degenerate). */
export function solveAffine(src: readonly Vec2[], dst: readonly Vec2[]): Warp2D | null {
  const n = src.length;
  if (n < 3) return null;
  const M: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rx = [0, 0, 0];
  const ry = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = [src[i]!.x, src[i]!.y, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a]![b]! += r[a]! * r[b]!;
      rx[a]! += r[a]! * dst[i]!.x;
      ry[a]! += r[a]! * dst[i]!.y;
    }
  }
  const sol = solve(M, [rx, ry]);
  if (!sol) return null;
  const [cx, cy] = sol as [number[], number[]];
  return {
    map: (p) => ({
      x: cx[0]! * p.x + cx[1]! * p.y + cx[2]!,
      y: cy[0]! * p.x + cy[1]! * p.y + cy[2]!,
    }),
  };
}

/** Gaussian elimination with partial pivoting for multiple right-hand sides. */
function solve(Ain: number[][], rhs: number[][]): number[][] | null {
  const n = Ain.length;
  const k = rhs.length;
  const m = Ain.map((row, i) => [...row, ...rhs.map((b) => b[i]!)]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(m[r]![col]!);
      if (val > best) {
        best = val;
        piv = r;
      }
    }
    if (best < 1e-12) return null;
    if (piv !== col) [m[col], m[piv]] = [m[piv]!, m[col]!];
    const pr = m[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r]!;
      const f = row[col]! / pr[col]!;
      if (f === 0) continue;
      for (let c = col; c < n + k; c++) row[c]! -= f * pr[c]!;
    }
  }
  return rhs.map((_, j) => m.map((row, i) => row[n + j]! / row[i]!));
}
