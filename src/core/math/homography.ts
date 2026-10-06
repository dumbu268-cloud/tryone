import type { Mat3, Vec2 } from '@/core/types';

// Projective (homography) transforms. Used to map the garment texture plane
// onto the body's torso quad, giving perspective-correct scaling, tilt and
// yaw-rotation response (not a flat sticker).

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Apply a row-major 3x3 homography to a 2D point (perspective divide). */
export function project(h: Mat3, p: Vec2): Vec2 {
  const x = h[0] * p.x + h[1] * p.y + h[2];
  const y = h[3] * p.x + h[4] * p.y + h[5];
  const w = h[6] * p.x + h[7] * p.y + h[8];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 0;
  return { x: x * iw, y: y * iw };
}

/**
 * Solve the 3x3 homography mapping four source points to four destination
 * points (DLT with h22 fixed to 1). Points must be in general position
 * (no 3 collinear). Returns null if the system is degenerate.
 */
export function computeHomography(src: Vec2[], dst: Vec2[]): Mat3 | null {
  if (src.length < 4 || dst.length < 4) return null;

  // Build 8x8 system A * h = b, unknown h = [h0..h7], with h8 = 1.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }

  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Gaussian elimination with partial pivoting. Solves A x = b (A is n×n). */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Augmented matrix.
  const m = A.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let pivot = col;
    let maxAbs = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!);
      if (v > maxAbs) {
        maxAbs = v;
        pivot = r;
      }
    }
    if (maxAbs < 1e-12) return null; // singular
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }

    // Eliminate below.
    const pivRow = m[col]!;
    const pivVal = pivRow[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = m[r]!;
      const factor = row[col]! / pivVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        row[c]! -= factor * pivRow[c]!;
      }
    }
  }

  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const r = m[row]!;
    let sum = r[n]!;
    for (let c = row + 1; c < n; c++) {
      sum -= r[c]! * x[c]!;
    }
    const diag = r[row]!;
    if (Math.abs(diag) < 1e-12) return null;
    x[row] = sum / diag;
  }
  return x;
}

/** Convert a row-major Mat3 to the column-major Float32Array WebGL expects. */
export function toColumnMajorArray(h: Mat3): Float32Array {
  return new Float32Array([
    h[0], h[3], h[6], // column 0
    h[1], h[4], h[7], // column 1
    h[2], h[5], h[8], // column 2
  ]);
}
