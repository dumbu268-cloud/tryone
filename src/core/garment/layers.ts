import type { GarmentAsset, Vec2 } from '@/core/types';
import { SLEEVE_S_EXTENT, SLEEVE_T_EXTENT, type GarmentMesh, type SleeveSource } from './mesh';
import * as v from '@/core/math/vec';

// Layered garment representation.
//
// A garment image is split into two textures:
//   - SLEEVE layer: only sleeve fabric. Sleeve pixels are classified from the
//     real garment pixels: covered by the sleeve skeleton's tube domain AND
//     outside the torso side line (or deep on the sleeve skeleton when the sleeve
//     overlaps the body). These pixels follow the arm.
//   - TORSO layer: the shirt body with the sleeves removed, plus the body fabric
//     the sleeves (or a model's hands) HID in the photo filled in by push-pull
//     inpainting. Raising an arm then reveals shirt instead of a hole.
// The torso layer is drawn first; sleeves are drawn over it, so the two warps
// never need to meet exactly (no cracks along the seam).

/** Max |s| (sleeve half-widths) a sleeve may claim; must be ≤ SLEEVE_S_EXTENT. */
export const SLEEVE_CLAIM = 1.9;
/** On the body side of the side line, a sleeve only claims its core. */
const SLEEVE_CORE = 0.85;
const MIN_ALPHA = 10;

export const LABEL_TORSO = 0;
export const LABEL_LEFT = 1;
export const LABEL_RIGHT = 2;
/** Fabric outside the body that no sleeve explains (likely sleeve remnants): not drawn. */
export const LABEL_DROP = 254;
export const LABEL_EMPTY = 255;

export interface LayerPixels {
  width: number;
  height: number;
  torso: Uint8ClampedArray;
  sleeves: Uint8ClampedArray;
  labels: Uint8Array;
  /** Torso pixels synthesized by inpainting. */
  filled: number;
}

interface TubeCoverage {
  t: Float32Array;
  s: Float32Array; // NaN where not covered
}

/** Rasterize a sleeve tube's (t, s) domain in image pixels; keeps the smallest |s|. */
function rasterizeTube(src: SleeveSource, scale: number, w: number, h: number): TubeCoverage {
  const t = new Float32Array(w * h).fill(NaN);
  const s = new Float32Array(w * h).fill(NaN);
  const NT = 48;
  const NS = 24;
  const verts: { x: number; y: number; t: number; s: number }[] = [];
  for (let r = 0; r <= NS; r++) {
    for (let c = 0; c <= NT; c++) {
      const tt = (c / NT) * SLEEVE_T_EXTENT;
      const ss = -SLEEVE_S_EXTENT + (2 * SLEEVE_S_EXTENT * r) / NS;
      const p = src.tube.pointAt(tt, ss);
      verts.push({ x: p.x * scale, y: p.y * scale, t: tt, s: ss });
    }
  }
  const tri = (a: (typeof verts)[0], b: (typeof verts)[0], c: (typeof verts)[0]) => {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-9) return;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const ss = w0 * a.s + w1 * b.s + w2 * c.s;
        const i = y * w + x;
        if (Number.isNaN(s[i]!) || Math.abs(ss) < Math.abs(s[i]!)) {
          s[i] = ss;
          t[i] = w0 * a.t + w1 * b.t + w2 * c.t;
        }
      }
    }
  };
  const stride = NT + 1;
  for (let r = 0; r < NS; r++) {
    for (let c = 0; c < NT; c++) {
      const i0 = r * stride + c;
      tri(verts[i0]!, verts[i0 + 1]!, verts[i0 + stride]!);
      tri(verts[i0 + 1]!, verts[i0 + stride + 1]!, verts[i0 + stride]!);
    }
  }
  return { t, s };
}

/** x of a top-to-bottom polyline at height y (clamped at its ends). */
function polyX(poly: readonly Vec2[], y: number): number {
  const pts = [...poly].sort((a, b) => a.y - b.y);
  if (y <= pts[0]!.y) return pts[0]!.x;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (y <= b.y) return b.y - a.y < 1e-6 ? b.x : v.lerpN(a.x, b.x, (y - a.y) / (b.y - a.y));
  }
  return pts[pts.length - 1]!.x;
}

function inPolygon(poly: readonly Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Push-pull (pyramid) inpainting: fills colors where `known` is 0, in place. */
export function pushPullFill(rgb: Float32Array, w: number, h: number, known: Uint8Array): void {
  type Level = { w: number; h: number; m: Float32Array; a: Float32Array };
  const levels: Level[] = [];
  const a0 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a0[i] = known[i] ? 1 : 0;
  levels.push({ w, h, m: rgb, a: a0 });
  while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
    const f = levels[levels.length - 1]!;
    const cw = Math.max(1, Math.ceil(f.w / 2));
    const ch = Math.max(1, Math.ceil(f.h / 2));
    const m = new Float32Array(cw * ch * 3);
    const a = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let ws = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx;
            const fy = 2 * y + dy;
            if (fx >= f.w || fy >= f.h) continue;
            const fi = fy * f.w + fx;
            const wt = f.a[fi]!;
            if (wt <= 0) continue;
            ws += wt;
            r += wt * f.m[fi * 3]!;
            g += wt * f.m[fi * 3 + 1]!;
            b += wt * f.m[fi * 3 + 2]!;
          }
        }
        const ci = y * cw + x;
        if (ws > 0) {
          m[ci * 3] = r / ws;
          m[ci * 3 + 1] = g / ws;
          m[ci * 3 + 2] = b / ws;
        }
        a[ci] = Math.min(1, ws);
      }
    }
    levels.push({ w: cw, h: ch, m, a });
  }
  // Push: blend each level with its (already filled) parent.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l]!;
    const c = levels[l + 1]!;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const fi = y * f.w + x;
        const wt = f.a[fi]!;
        if (wt >= 1) continue;
        const ci = (y >> 1) * c.w + (x >> 1);
        for (let k = 0; k < 3; k++) f.m[fi * 3 + k] = wt * f.m[fi * 3 + k]! + (1 - wt) * c.m[ci * 3 + k]!;
      }
    }
  }
}

/** Separable square dilation of a 0/1 mask by `r` pixels. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !on; k++) on = mask[y * w + k]!;
      tmp[y * w + x] = on;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !on; k++) on = tmp[k * w + x]!;
      out[y * w + x] = on;
    }
  }
  return out;
}

/**
 * Pure core: split RGBA garment pixels (image space, `scale` image px per
 * texture px) into torso + sleeve layers using the garment mesh's rig/sleeves.
 */
export function computeLayerPixels(
  src: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  scale: number,
  mesh: GarmentMesh,
): LayerPixels {
  const n = w * h;
  const rig = mesh.rig;
  const sc = (p: Vec2): Vec2 => ({ x: p.x * scale, y: p.y * scale });
  const sideL = [sc(rig.shoulderL), sc(rig.armpitL), sc(rig.hemL)];
  const sideR = [sc(rig.shoulderR), sc(rig.armpitR), sc(rig.hemR)];
  const covL = mesh.sleeveL ? rasterizeTube(mesh.sleeveL, scale, w, h) : null;
  const covR = mesh.sleeveR ? rasterizeTube(mesh.sleeveR, scale, w, h) : null;
  const torsoTop = Math.min(rig.neckL.y, rig.neckR.y) * scale;
  const hemY = Math.max(rig.hemL.y, rig.hemR.y) * scale;
  const dropAbove = hemY - 0.06 * (hemY - torsoTop);

  const labels = new Uint8Array(n).fill(LABEL_EMPTY);
  const claim = (cov: TubeCoverage | null, cap: number, i: number, outward: boolean): number => {
    if (!cov) return Infinity;
    const s = cov.s[i]!;
    if (Number.isNaN(s)) return Infinity;
    const as = Math.abs(s);
    if (as > SLEEVE_CLAIM) return Infinity;
    if (outward) return as;
    return cov.t[i]! > cap && as <= SLEEVE_CORE ? as : Infinity;
  };
  for (let y = 0; y < h; y++) {
    const xL = polyX(sideL, y + 0.5);
    const xR = polyX(sideR, y + 0.5);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i * 4 + 3]! < MIN_ALPHA) continue;
      const outL = x + 0.5 < xL - 1;
      const outR = x + 0.5 > xR + 1;
      const cl = claim(covL, mesh.sleeveL?.cap ?? 1, i, outL);
      const cr = claim(covR, mesh.sleeveR?.cap ?? 1, i, outR);
      if (cl < Infinity || cr < Infinity) labels[i] = cl <= cr ? LABEL_LEFT : LABEL_RIGHT;
      else if ((outL || outR) && y < dropAbove && (mesh.sleeveL || mesh.sleeveR)) labels[i] = LABEL_DROP;
      else labels[i] = LABEL_TORSO;
    }
  }

  // Torso completion region: the body between the armpits and the hem.
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) known[i] = labels[i] === LABEL_TORSO ? 1 : 0;
  const colMax = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (labels[y * w + x] !== LABEL_EMPTY) colMax[x] = y;
  const body = [sc(rig.armpitL), sc(rig.hemL), sc(rig.hemR), sc(rig.armpitR)];
  const bx0 = Math.max(0, Math.floor(Math.min(...body.map((p) => p.x))));
  const bx1 = Math.min(w - 1, Math.ceil(Math.max(...body.map((p) => p.x))));
  const by0 = Math.max(0, Math.floor(Math.min(...body.map((p) => p.y))));
  const by1 = Math.min(h - 1, Math.ceil(Math.max(...body.map((p) => p.y))));
  const fill = new Uint8Array(n);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x;
      if (!known[i] && y <= colMax[x]! && inPolygon(body, x + 0.5, y + 0.5)) fill[i] = 1;
    }
  }
  // Seam padding: extend body fabric a little under the sleeves.
  const near = dilate(known, w, h, Math.max(1, Math.round(2 * scale)));
  for (let i = 0; i < n; i++) {
    if (near[i] && (labels[i] === LABEL_LEFT || labels[i] === LABEL_RIGHT)) fill[i] = 1;
  }

  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = src[i * 4]!;
    rgb[i * 3 + 1] = src[i * 4 + 1]!;
    rgb[i * 3 + 2] = src[i * 4 + 2]!;
  }
  let filled = 0;
  for (let i = 0; i < n; i++) if (fill[i]) filled++;
  if (filled > 0) pushPullFill(rgb, w, h, known);

  const torso = new Uint8ClampedArray(n * 4);
  const sleeves = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    if (known[i]) {
      torso[j] = src[j]!;
      torso[j + 1] = src[j + 1]!;
      torso[j + 2] = src[j + 2]!;
      torso[j + 3] = src[j + 3]!;
    } else if (fill[i]) {
      torso[j] = rgb[i * 3]!;
      torso[j + 1] = rgb[i * 3 + 1]!;
      torso[j + 2] = rgb[i * 3 + 2]!;
      torso[j + 3] = 255;
    }
    if (labels[i] === LABEL_LEFT || labels[i] === LABEL_RIGHT) {
      sleeves[j] = src[j]!;
      sleeves[j + 1] = src[j + 1]!;
      sleeves[j + 2] = src[j + 2]!;
      sleeves[j + 3] = src[j + 3]!;
    }
  }
  return { width: w, height: h, torso, sleeves, labels, filled };
}

export interface GarmentLayers {
  torso: HTMLCanvasElement;
  sleeves: HTMLCanvasElement;
  pixels: LayerPixels;
}

function sourceSize(img: TexImageSource): { w: number; h: number } {
  const s = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  return { w: s.naturalWidth || s.width || 0, h: s.naturalHeight || s.height || 0 };
}

/** DOM wrapper: rasterize the garment image and build the two layer canvases. */
export function buildGarmentLayers(garment: GarmentAsset, mesh: GarmentMesh): GarmentLayers {
  const { w, h } = sourceSize(garment.image);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(garment.image as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixels = computeLayerPixels(data, canvas.width, canvas.height, canvas.width / garment.textureWidth, mesh);
  const toCanvas = (rgba: Uint8ClampedArray): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const cctx = c.getContext('2d')!;
    const img = cctx.createImageData(c.width, c.height);
    img.data.set(rgba);
    cctx.putImageData(img, 0, 0);
    return c;
  };
  return { torso: toCanvas(pixels.torso), sleeves: toCanvas(pixels.sleeves), pixels };
}
