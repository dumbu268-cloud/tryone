import { describe, it, expect } from 'vitest';
import { removeBackground } from './background';
import { analyzeGarment } from './analyze';
import type { RgbaImage } from '@/core/types';

// --- helpers ---------------------------------------------------------------

function solidImage(w: number, h: number, bg: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = bg[0];
    d[i * 4 + 1] = bg[1];
    d[i * 4 + 2] = bg[2];
    d[i * 4 + 3] = 255;
  }
  return d;
}

function fillRect(
  d: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: [number, number, number],
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
}

function maskRect(m: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255;
}

function ratio(m: Uint8Array): number {
  let c = 0;
  for (const v of m) if (v) c++;
  return c / m.length;
}

// --- background removal ----------------------------------------------------

describe('removeBackground', () => {
  it('isolates a garment-coloured rectangle on a white background', () => {
    const w = 120;
    const h = 160;
    const data = solidImage(w, h, [255, 255, 255]);
    fillRect(data, w, 40, 40, 80, 130, [40, 90, 180]); // blue block
    const img: RgbaImage = { data, width: w, height: h };

    const { alpha, foregroundRatio } = removeBackground(img);
    // Corners are background.
    expect(alpha[0]).toBe(0);
    expect(alpha[w - 1]).toBe(0);
    // Interior of the block is garment.
    expect(alpha[80 * w + 60]).toBe(255);
    // Roughly the block area (minus a 1px erode).
    expect(foregroundRatio).toBeGreaterThan(0.1);
    expect(foregroundRatio).toBeLessThan(0.3);
  });
});

// --- silhouette analysis ---------------------------------------------------

const W = 200;
const H = 240;

function tshirtMask(sleeveX0: number): Uint8Array {
  const m = new Uint8Array(W * H);
  maskRect(m, W, 70, 60, 130, 230); // torso
  maskRect(m, W, sleeveX0, 60, 70, 110); // left sleeve
  maskRect(m, W, 130, 60, 200 - sleeveX0, 110); // right sleeve (mirror)
  // collar notch (open to the top edge)
  for (let y = 60; y < 74; y++) for (let x = 90; x < 110; x++) m[y * W + x] = 0;
  return m;
}

describe('analyzeGarment', () => {
  it('detects a short-sleeve t-shirt', () => {
    const m = tshirtMask(40); // sleeves reach 30px beyond torso (ratio 0.5)
    const a = analyzeGarment(m, W, H, ratio(m));
    expect(a.supported).toBe(true);
    expect(a.type).toBe('tshirt');
    expect(a.sleeveLength).toBe('short');
    expect(a.coversForearm).toBe(false);
    expect(Math.abs(a.layout.torso.tl.x - 70)).toBeLessThan(4);
    expect(Math.abs(a.layout.torso.tr.x - 130)).toBeLessThan(4);
    expect(a.layout.leftSleeve.tipTop.x).toBeLessThan(60); // sleeve extends left of torso
  });

  it('detects a long-sleeve shirt', () => {
    const m = tshirtMask(10); // sleeves reach 60px beyond torso (ratio 1.0)
    const a = analyzeGarment(m, W, H, ratio(m));
    expect(a.supported).toBe(true);
    expect(a.type).toBe('longsleeve');
    expect(a.sleeveLength).toBe('long');
    expect(a.coversForearm).toBe(true);
  });

  it('handles a sleeveless top gracefully (torso only, collapsed sleeves)', () => {
    const m = new Uint8Array(W * H);
    maskRect(m, W, 70, 60, 130, 230); // torso only
    const a = analyzeGarment(m, W, H, ratio(m));
    expect(a.supported).toBe(true);
    expect(a.sleeveLength).toBe('none');
    expect(a.reason).toMatch(/sleeve/i);
    // Collapsed sleeve: root and tip coincide → zero-area → renders nothing.
    expect(a.layout.leftSleeve.rootTop).toEqual(a.layout.leftSleeve.tipTop);
  });

  it('flags an unsupported image when the background cannot be separated', () => {
    const m = new Uint8Array(W * H).fill(255); // whole image is "foreground"
    const a = analyzeGarment(m, W, H, 1);
    expect(a.supported).toBe(false);
    expect(a.reason).toBeTruthy();
    // Still returns a usable torso-only fallback layout (no NaN).
    expect(Number.isFinite(a.layout.torso.tl.x)).toBe(true);
  });

  it('produces finite, ordered torso geometry', () => {
    const a = analyzeGarment(tshirtMask(40), W, H, 0.3);
    const q = a.layout.torso;
    expect(q.tl.x).toBeLessThan(q.tr.x);
    expect(q.tl.y).toBeLessThan(q.bl.y);
    for (const p of [q.tl, q.tr, q.br, q.bl]) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
