import { describe, it, expect } from 'vitest';
import {
  categoryMask,
  zeroBelow,
  keepMainComponent,
  closeMask,
  foregroundRatio,
} from './maskOps';

const W = 20;
const H = 20;

function blank(): Uint8Array {
  return new Uint8Array(W * H);
}
function rect(m: Uint8Array, x0: number, y0: number, x1: number, y1: number, val = 255) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = val;
}

describe('maskOps', () => {
  it('categoryMask selects only the requested class', () => {
    const cats = new Uint8Array(W * H);
    cats[0] = 4;
    cats[1] = 2;
    cats[2] = 4;
    const m = categoryMask(cats, 4);
    expect(m[0]).toBe(255);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(255);
  });

  it('zeroBelow clears rows at/below the hip line (drops pants)', () => {
    const m = blank();
    rect(m, 5, 2, 15, 18); // vertical band
    const cut = zeroBelow(m, W, H, 10);
    expect(cut[8 * W + 7]).toBe(255); // above the line kept
    expect(cut[12 * W + 7]).toBe(0); // below the line removed
  });

  it('keepMainComponent drops stray blobs, keeping the largest', () => {
    const m = blank();
    rect(m, 2, 2, 10, 16); // big blob (torso)
    rect(m, 16, 1, 19, 4); // small stray (background object)
    const out = keepMainComponent(m, W, H);
    expect(out[8 * W + 5]).toBe(255); // big kept
    expect(out[2 * W + 17]).toBe(0); // stray removed
  });

  it('keepMainComponent follows a seed into a specific component', () => {
    const m = blank();
    rect(m, 1, 1, 4, 4); // small blob A
    rect(m, 10, 10, 18, 18); // bigger blob B
    const out = keepMainComponent(m, W, H, { x: 2, y: 2 }); // seed in A
    expect(out[2 * W + 2]).toBe(255); // A kept despite being smaller
    expect(out[14 * W + 14]).toBe(0); // B removed
  });

  it('closeMask fills a small interior hole (button/logo)', () => {
    const m = blank();
    rect(m, 4, 4, 14, 14);
    m[9 * W + 9] = 0; // a 1px hole
    const closed = closeMask(m, W, H, 1);
    expect(closed[9 * W + 9]).toBe(255);
  });

  it('foregroundRatio counts set pixels', () => {
    const m = blank();
    rect(m, 0, 0, 10, 20); // half
    expect(foregroundRatio(m)).toBeCloseTo(0.5, 2);
  });
});
