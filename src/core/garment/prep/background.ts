import type { RgbaImage } from '@/core/types';

// Deterministic background removal for flat-lay / product-style garment images
// on a plain background. Estimates the background colour from the image corners,
// flood-fills background-coloured regions connected to the border, then erodes
// the garment edge by 1px to kill anti-aliased halos. No ML, no network.

export interface BackgroundOptions {
  /** Per-pixel colour distance (0..441) below which a pixel matches background. */
  tolerance?: number;
  /** Erode the garment edge by this many pixels to remove fringe. */
  erode?: number;
}

export interface BackgroundResult {
  /** 0 = background, 255 = garment, per pixel (length width*height). */
  alpha: Uint8Array;
  bgColor: [number, number, number];
  foregroundRatio: number;
}

const DEFAULTS: Required<BackgroundOptions> = { tolerance: 42, erode: 1 };

export function removeBackground(img: RgbaImage, options: BackgroundOptions = {}): BackgroundResult {
  const opts = { ...DEFAULTS, ...options };
  const { data, width: w, height: h } = img;
  const n = w * h;
  const bgColor = estimateBackground(data, w, h);

  // Flood fill background from every border pixel.
  const isBg = new Uint8Array(n);
  const stack: number[] = [];
  const tol2 = opts.tolerance * opts.tolerance;

  const consider = (idx: number) => {
    if (isBg[idx]) return;
    if (colorDist2(data, idx, bgColor) <= tol2) {
      isBg[idx] = 1;
      stack.push(idx);
    }
  };

  for (let x = 0; x < w; x++) {
    consider(x); // top row
    consider((h - 1) * w + x); // bottom row
  }
  for (let y = 0; y < h; y++) {
    consider(y * w); // left col
    consider(y * w + (w - 1)); // right col
  }

  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) consider(idx - 1);
    if (x < w - 1) consider(idx + 1);
    if (y > 0) consider(idx - w);
    if (y < h - 1) consider(idx + w);
  }

  // Garment = not background.
  let alpha: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = isBg[i] ? 0 : 255;

  for (let e = 0; e < opts.erode; e++) alpha = erodeOnce(alpha, w, h);

  let fg = 0;
  for (let i = 0; i < n; i++) if (alpha[i]) fg++;

  return { alpha, bgColor, foregroundRatio: fg / n };
}

function estimateBackground(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): [number, number, number] {
  // Median of a small patch at each corner (robust to a stray edge pixel).
  const samples: Array<[number, number, number]> = [];
  const patch = 6;
  const corners: Array<[number, number]> = [
    [0, 0],
    [w - patch, 0],
    [0, h - patch],
    [w - patch, h - patch],
  ];
  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < patch; dy++) {
      for (let dx = 0; dx < patch; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx));
        const y = Math.min(h - 1, Math.max(0, cy + dy));
        const i = (y * w + x) * 4;
        samples.push([data[i]!, data[i + 1]!, data[i + 2]!]);
      }
    }
  }
  return [median(samples, 0), median(samples, 1), median(samples, 2)];
}

function median(samples: Array<[number, number, number]>, ch: number): number {
  const vals = samples.map((s) => s[ch] ?? 0).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

function colorDist2(
  data: Uint8ClampedArray | Uint8Array,
  idx: number,
  bg: [number, number, number],
): number {
  const i = idx * 4;
  const dr = data[i]! - bg[0];
  const dg = data[i + 1]! - bg[1];
  const db = data[i + 2]! - bg[2];
  return dr * dr + dg * dg + db * db;
}

function erodeOnce(alpha: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!alpha[i]) continue;
      const bgNeighbor =
        (x > 0 && !alpha[i - 1]) ||
        (x < w - 1 && !alpha[i + 1]) ||
        (y > 0 && !alpha[i - w]) ||
        (y < h - 1 && !alpha[i + w]);
      out[i] = bgNeighbor ? 0 : 255;
    }
  }
  return out;
}
