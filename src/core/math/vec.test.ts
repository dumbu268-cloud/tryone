import { describe, it, expect } from 'vitest';
import {
  add,
  sub,
  scale,
  mid,
  len,
  dist,
  normalize,
  perp,
  lerp,
  rotateAround,
  clamp,
} from './vec';

describe('vec', () => {
  it('add / sub / scale', () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(sub({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(scale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
  });

  it('mid / len / dist', () => {
    expect(mid({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual({ x: 2, y: 1 });
    expect(len({ x: 3, y: 4 })).toBeCloseTo(5);
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });

  it('normalize returns a unit vector (and zero for zero)', () => {
    const n = normalize({ x: 0, y: 10 });
    expect(len(n)).toBeCloseTo(1);
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('perp is orthogonal', () => {
    const a = { x: 2, y: 3 };
    const p = perp(a);
    expect(a.x * p.x + a.y * p.y).toBeCloseTo(0);
  });

  it('lerp interpolates endpoints', () => {
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0)).toEqual({ x: 0, y: 0 });
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 });
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });

  it('rotateAround rotates 90 degrees about origin', () => {
    const r = rotateAround({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
  });

  it('clamp bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});
