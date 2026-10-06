import { describe, it, expect } from 'vitest';
import { computeHomography, project, toColumnMajorArray, IDENTITY } from './homography';
import type { Vec2 } from '@/core/types';

const square: Vec2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function expectClose(a: Vec2, b: Vec2, eps = 1e-6) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
}

describe('homography', () => {
  it('identity maps a point to itself', () => {
    expectClose(project(IDENTITY, { x: 3, y: 7 }), { x: 3, y: 7 });
  });

  it('recovers an identity transform from matching quads', () => {
    const h = computeHomography(square, square)!;
    expect(h).not.toBeNull();
    for (const p of square) expectClose(project(h, p), p);
  });

  it('solves pure translation', () => {
    const dst = square.map((p) => ({ x: p.x + 10, y: p.y - 5 }));
    const h = computeHomography(square, dst)!;
    expectClose(project(h, { x: 0.5, y: 0.5 }), { x: 10.5, y: -4.5 });
  });

  it('solves scaling + translation and interpolates interior points', () => {
    // Map unit square to a 100x200 rect offset by (50,20).
    const dst: Vec2[] = [
      { x: 50, y: 20 },
      { x: 150, y: 20 },
      { x: 150, y: 220 },
      { x: 50, y: 220 },
    ];
    const h = computeHomography(square, dst)!;
    for (let i = 0; i < 4; i++) expectClose(project(h, square[i]!), dst[i]!);
    // Center maps to center.
    expectClose(project(h, { x: 0.5, y: 0.5 }), { x: 100, y: 120 }, 1e-5);
  });

  it('solves a genuine projective (trapezoid) mapping', () => {
    // A keystone/trapezoid — exercises the perspective terms h6,h7.
    const dst: Vec2[] = [
      { x: 20, y: 0 },
      { x: 80, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const h = computeHomography(square, dst)!;
    for (let i = 0; i < 4; i++) expectClose(project(h, square[i]!), dst[i]!, 1e-5);
    // Perspective terms must be non-zero for a true projective map.
    expect(Math.abs(h[6]) + Math.abs(h[7])).toBeGreaterThan(1e-6);
  });

  it('returns null for a degenerate (collinear) source', () => {
    const collinear: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(computeHomography(collinear, square)).toBeNull();
  });

  it('converts to a column-major WebGL array', () => {
    const h = computeHomography(square, square)!;
    const col = toColumnMajorArray(h);
    expect(col.length).toBe(9);
    // Identity stays identity under transpose.
    expect(Array.from(col)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
