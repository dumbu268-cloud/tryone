import type { GarmentAsset, GarmentRig, SleeveRig, Vec2 } from '@/core/types';
import { rigFromLayout, sleeveCoverage } from './rig';
import { capFraction, makeTube, polylineLength, type Tube } from '@/core/fit/tube';
import * as v from '@/core/math/vec';

// Garment mesh built from the garment RIG (not a fixed template):
//   - torso: a grid over the garment's own texture region; each vertex carries
//     its texture position and is warped by the torso TPS at fit time.
//   - sleeves: grids in tube space (t along the source sleeve skeleton, s across);
//     texture coords come from the source tube, screen positions from the
//     user's arm tube. The torso and sleeves sample separate texture layers
//     (see layers.ts), so sleeve fabric never moves with the torso warp.

export type MeshRegionId = 0 | 1 | 2;

export interface MeshRange {
  start: number;
  count: number;
}

export interface SleeveSource {
  rig: SleeveRig;
  tube: Tube;
  /** Shoulder-cap fraction shared by texture and screen tubes. */
  cap: number;
  /** Half-width on the armhole line (shoulder tip → armpit), texture px. */
  armholeHalf: number;
  /** Fraction of the user's arm (armhole → wrist) this sleeve covers. */
  coverage: number;
}

export interface GarmentMesh {
  vertexCount: number;
  uv: Float32Array;
  alpha: Float32Array;
  region: Uint8Array;
  /** Texture-pixel position per vertex (used by the torso warp). */
  texPx: Float32Array;
  /** Sleeve tube parameters per vertex: t (along) / s (across). */
  paramA: Float32Array;
  paramB: Float32Array;
  indices: Uint16Array;
  ranges: { torso: MeshRange; leftSleeve: MeshRange; rightSleeve: MeshRange };
  rig: GarmentRig;
  sleeveL: SleeveSource | null;
  sleeveR: SleeveSource | null;
}

const TORSO_COLS = 16;
const TORSO_ROWS = 20;
const SLEEVE_LEN = 28;
const SLEEVE_WID = 12;
/**
 * Sleeve meshes cover a generous band around the sleeve skeleton (in sleeve
 * half-widths) and run slightly past the cuff. The sleeve LAYER texture is
 * transparent outside real sleeve fabric, so the extra coverage is invisible.
 */
export const SLEEVE_S_EXTENT = 2.0;
export const SLEEVE_T_EXTENT = 1.06;

export function resolveRig(garment: GarmentAsset): GarmentRig {
  return garment.layout.rig ?? rigFromLayout(garment.layout);
}

export function sleeveSource(rig: GarmentRig, side: 'L' | 'R'): SleeveSource | null {
  const s = side === 'L' ? rig.sleeveL : rig.sleeveR;
  if (!s || s.axis.length < 2) return null;
  const tip = side === 'L' ? rig.shoulderL : rig.shoulderR;
  const pit = side === 'L' ? rig.armpitL : rig.armpitR;
  const armholeHalf = Math.max(1, v.dist(tip, pit) / 2);
  const length = polylineLength(s.axis);
  if (length < 2) return null;
  const cap = capFraction(armholeHalf, length);
  const tube = makeTube(
    s.axis,
    { root: armholeHalf, mid: s.rootHalfWidth, tip: s.tipHalfWidth },
    side,
    v.sub(pit, tip),
    cap,
  );
  return { rig: s, tube, cap, armholeHalf, coverage: sleeveCoverage(rig, s) };
}

export function buildGarmentMesh(garment: GarmentAsset): GarmentMesh {
  const texW = garment.textureWidth;
  const texH = garment.textureHeight;
  const rig = resolveRig(garment);

  const uv: number[] = [];
  const alpha: number[] = [];
  const region: number[] = [];
  const texPx: number[] = [];
  const paramA: number[] = [];
  const paramB: number[] = [];
  const indices: number[] = [];

  const push = (p: Vec2, reg: number, a: number, b: number) => {
    uv.push(p.x / texW, p.y / texH);
    texPx.push(p.x, p.y);
    alpha.push(1);
    region.push(reg);
    paramA.push(a);
    paramB.push(b);
  };

  const grid = (cols: number, rows: number, place: (c: number, r: number) => void): MeshRange => {
    const base = uv.length / 2;
    const start = indices.length;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) place(c, r);
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = base + r * stride + c;
        indices.push(i0, i0 + 1, i0 + stride, i0 + 1, i0 + stride + 1, i0 + stride);
      }
    }
    return { start, count: indices.length - start };
  };

  // Torso: cover the garment's own texture region around the torso keypoints.
  const pts = [rig.neckL, rig.neckR, rig.shoulderL, rig.shoulderR, rig.armpitL, rig.armpitR, rig.hemL, rig.hemR];
  const tw = Math.max(1, v.dist(rig.shoulderL, rig.shoulderR));
  const th = Math.max(1, Math.max(rig.hemL.y, rig.hemR.y) - Math.min(rig.neckL.y, rig.neckR.y));
  const x0 = v.clamp(Math.min(...pts.map((p) => p.x)) - 0.3 * tw, 0, texW);
  const x1 = v.clamp(Math.max(...pts.map((p) => p.x)) + 0.3 * tw, 0, texW);
  const y0 = v.clamp(Math.min(...pts.map((p) => p.y)) - 0.18 * th, 0, texH);
  const y1 = v.clamp(Math.max(...pts.map((p) => p.y)) + 0.12 * th, 0, texH);
  const torso = grid(TORSO_COLS, TORSO_ROWS, (c, r) =>
    push({ x: v.lerpN(x0, x1, c / TORSO_COLS), y: v.lerpN(y0, y1, r / TORSO_ROWS) }, 0, 0, 0),
  );

  const sleeveL = sleeveSource(rig, 'L');
  const sleeveR = sleeveSource(rig, 'R');
  const sleeveGrid = (src: SleeveSource | null, reg: number): MeshRange => {
    if (!src) return { start: indices.length, count: 0 };
    return grid(SLEEVE_LEN, SLEEVE_WID, (c, r) => {
      const t = (c / SLEEVE_LEN) * SLEEVE_T_EXTENT;
      const s = (r / SLEEVE_WID) * 2 * SLEEVE_S_EXTENT - SLEEVE_S_EXTENT;
      push(src.tube.pointAt(t, s), reg, t, s);
    });
  };
  const leftSleeve = sleeveGrid(sleeveL, 1);
  const rightSleeve = sleeveGrid(sleeveR, 2);

  return {
    vertexCount: uv.length / 2,
    uv: new Float32Array(uv),
    alpha: new Float32Array(alpha),
    region: new Uint8Array(region),
    texPx: new Float32Array(texPx),
    paramA: new Float32Array(paramA),
    paramB: new Float32Array(paramB),
    indices: new Uint16Array(indices),
    ranges: { torso, leftSleeve, rightSleeve },
    rig,
    sleeveL,
    sleeveR,
  };
}
