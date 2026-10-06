import type { GarmentAsset, Quad, SleeveLayout, Vec2 } from '@/core/types';

// Builds the deformable garment mesh from a garment's layout. Both the engine
// (which computes per-vertex screen positions) and the renderer (which draws
// them) call this deterministically, so vertex order matches on both sides.
//
// Vertex channels:
//   region : 0 torso, 1 left sleeve, 2 right sleeve
//   paramA : torso u (0..1 left→right)  | sleeve t (0 armhole → 1 cuff)
//   paramB : torso v (0..1 top→hem)     | sleeve s (-1 top/shoulder → +1 underarm)
//   uv     : garment texture coordinate (0..1)
//   alpha  : base edge feather (soft garment boundaries)

export type MeshRegionId = 0 | 1 | 2;

export interface MeshRange {
  /** First index (into `indices`) for this region. */
  start: number;
  count: number;
}

export interface GarmentMesh {
  vertexCount: number;
  uv: Float32Array; // 2 * N
  alpha: Float32Array; // N
  region: Uint8Array; // N
  paramA: Float32Array; // N
  paramB: Float32Array; // N
  indices: Uint16Array;
  ranges: { torso: MeshRange; leftSleeve: MeshRange; rightSleeve: MeshRange };
}

const TORSO_COLS = 8;
const TORSO_ROWS = 12;
const SLEEVE_LEN = 10;
const SLEEVE_WID = 4;

function bilinear(q: Quad, u: number, v: number): Vec2 {
  const top = { x: q.tl.x + (q.tr.x - q.tl.x) * u, y: q.tl.y + (q.tr.y - q.tl.y) * u };
  const bot = { x: q.bl.x + (q.br.x - q.bl.x) * u, y: q.bl.y + (q.br.y - q.bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

function sleevePoint(s: SleeveLayout, t: number, acrossU: number): Vec2 {
  const top = { x: s.rootTop.x + (s.tipTop.x - s.rootTop.x) * t, y: s.rootTop.y + (s.tipTop.y - s.rootTop.y) * t };
  const bot = {
    x: s.rootBottom.x + (s.tipBottom.x - s.rootBottom.x) * t,
    y: s.rootBottom.y + (s.tipBottom.y - s.rootBottom.y) * t,
  };
  return { x: top.x + (bot.x - top.x) * acrossU, y: top.y + (bot.y - top.y) * acrossU };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildGarmentMesh(garment: GarmentAsset): GarmentMesh {
  const texW = garment.textureWidth;
  const texH = garment.textureHeight;
  const layout = garment.layout;

  const uv: number[] = [];
  const alpha: number[] = [];
  const region: number[] = [];
  const paramA: number[] = [];
  const paramB: number[] = [];
  const indices: number[] = [];

  const pushVertex = (texPx: Vec2, a: number, reg: number, pa: number, pb: number) => {
    uv.push(texPx.x / texW, texPx.y / texH);
    alpha.push(a);
    region.push(reg);
    paramA.push(pa);
    paramB.push(pb);
  };

  const addGrid = (
    cols: number,
    rows: number,
    base: number,
    place: (c: number, r: number) => { texPx: Vec2; a: number; pa: number; pb: number },
    reg: number,
  ): MeshRange => {
    const start = indices.length;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const { texPx, a, pa, pb } = place(c, r);
        pushVertex(texPx, a, reg, pa, pb);
      }
    }
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = base + r * stride + c;
        const i1 = i0 + 1;
        const i2 = i0 + stride;
        const i3 = i2 + 1;
        indices.push(i0, i1, i2, i1, i3, i2);
      }
    }
    return { start, count: indices.length - start };
  };

  // --- Torso ---
  const torsoBase = 0;
  const torsoRange = addGrid(
    TORSO_COLS,
    TORSO_ROWS,
    torsoBase,
    (c, r) => {
      const u = c / TORSO_COLS;
      const v = r / TORSO_ROWS;
      const texPx = bilinear(layout.torso, u, v);
      // Feather the hem and the vertical side seams a touch.
      const hem = 1 - smoothstep(0.9, 1.0, v) * 0.5;
      const side = Math.min(smoothstep(0, 0.04, u), smoothstep(0, 0.04, 1 - u)) * 0.15 + 0.85;
      return { texPx, a: Math.min(hem, side), pa: u, pb: v };
    },
    0,
  );

  // --- Sleeves ---
  const sleevePlace = (s: SleeveLayout) => (c: number, r: number) => {
    const t = c / SLEEVE_LEN;
    const across = r / SLEEVE_WID; // 0..1 top→bottom
    const sParam = across * 2 - 1; // -1..+1
    const texPx = sleevePoint(s, t, across);
    // Feather the cuff (tip) and the long edges.
    const cuff = 1 - smoothstep(0.86, 1.0, t) * 0.55;
    const edge = Math.min(smoothstep(0, 0.12, across), smoothstep(0, 0.12, 1 - across)) * 0.2 + 0.8;
    return { texPx, a: Math.min(cuff, edge), pa: t, pb: sParam };
  };

  const leftBase = uv.length / 2;
  const leftRange = addGrid(SLEEVE_LEN, SLEEVE_WID, leftBase, sleevePlace(layout.leftSleeve), 1);

  const rightBase = uv.length / 2;
  const rightRange = addGrid(SLEEVE_LEN, SLEEVE_WID, rightBase, sleevePlace(layout.rightSleeve), 2);

  return {
    vertexCount: uv.length / 2,
    uv: new Float32Array(uv),
    alpha: new Float32Array(alpha),
    region: new Uint8Array(region),
    paramA: new Float32Array(paramA),
    paramB: new Float32Array(paramB),
    indices: new Uint16Array(indices),
    ranges: { torso: torsoRange, leftSleeve: leftRange, rightSleeve: rightRange },
  };
}
