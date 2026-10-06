import { describe, it, expect } from 'vitest';
import { solveTps, solveAffine } from '@/core/math/tps';
import { estimateBodyKeypoints, type LandmarkPx } from './bodyRig';
import { makeTube, fitPolylineLength, polylineLength } from './tube';
import { rigFromPose, rigFromSilhouette } from '@/core/garment/rig';
import { analyzeGarment } from '@/core/garment/prep/analyze';
import type { Vec2 } from '@/core/types';

const close = (a: Vec2, b: Vec2, eps = 1e-6) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
};

describe('TPS', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 50, y: 40 },
  ];
  it('interpolates control points exactly', () => {
    const dst = src.map((p, i) => ({ x: p.x * 1.3 + (i === 4 ? 12 : 0), y: p.y * 0.8 + 5 }));
    const w = solveTps(src, dst)!;
    src.forEach((p, i) => close(w.map(p), dst[i]!, 1e-6));
  });
  it('reproduces an affine map everywhere', () => {
    const aff = (p: Vec2) => ({ x: 2 * p.x + 0.5 * p.y + 10, y: -0.3 * p.x + p.y - 4 });
    const w = solveTps(src, src.map(aff))!;
    close(w.map({ x: 23, y: 77 }), aff({ x: 23, y: 77 }), 1e-6);
    const a = solveAffine(src, src.map(aff))!;
    close(a.map({ x: 7, y: 3 }), aff({ x: 7, y: 3 }), 1e-6);
  });
  it('rejects degenerate input', () => {
    expect(solveTps([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
  });
});

function pose(over: Record<number, [number, number, number?]> = {}): LandmarkPx[] {
  const lm: LandmarkPx[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const base: Record<number, [number, number, number?]> = {
    9: [185, 105], 10: [215, 105], 11: [150, 200], 12: [250, 200],
    13: [140, 290], 14: [260, 290], 15: [135, 370], 16: [265, 370], 23: [165, 360], 24: [235, 360],
  };
  for (const [k, [x, y, vis]] of Object.entries({ ...base, ...over })) lm[+k] = { x, y, visibility: vis ?? 1 };
  return lm;
}

describe('body keypoints', () => {
  it('derives neck above the shoulder line, tips outside joints, armpits below', () => {
    const b = estimateBodyKeypoints(pose(), 1)!;
    expect(b.neckL.y).toBeLessThan(200);
    expect(b.neckL.x).toBeGreaterThan(150);
    expect(b.neckR.x).toBeLessThan(250);
    expect(b.shoulderL.x).toBeLessThan(150);
    expect(b.shoulderR.x).toBeGreaterThan(250);
    expect(b.armpitL.y).toBeGreaterThan(220);
    expect(b.up.y).toBeLessThan(0);
  });
});

describe('sleeve tube', () => {
  it('starts on the armhole line and follows a bent arm', () => {
    const axis = [{ x: 100, y: 100 }, { x: 100, y: 200 }, { x: 180, y: 260 }];
    const tube = makeTube(axis, { root: 30, mid: 20, tip: 10 }, 'L', { x: 1, y: 0 }, 0.2);
    close(tube.pointAt(0, -1), { x: 70, y: 100 }, 1e-6);
    close(tube.pointAt(0, 1), { x: 130, y: 100 }, 1e-6);
    close(tube.pointAt(1, 0), { x: 180, y: 260 }, 1e-6);
    expect(polylineLength(fitPolylineLength(axis, 150))).toBeCloseTo(150, 6);
  });
});

// Synthetic worn garment: torso + short sleeves around a model's arms.
const W = 400;
const H = 500;
function wornMask(sleeveTo: number): Uint8Array {
  const m = new Uint8Array(W * H);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 255;
  };
  fill(140, 180, 260, 420); // torso
  fill(112, 185, 142, sleeveTo); // left sleeve beside the hanging arm
  fill(258, 185, 288, sleeveTo); // right sleeve
  return m;
}

describe('garment rig extraction', () => {
  it('worn short sleeve: sleeves follow the model arm, classified short', () => {
    const p = pose({ 13: [128, 300], 14: [272, 300], 15: [125, 400], 16: [275, 400], 11: [150, 200], 12: [250, 200] });
    const r = rigFromPose(wornMask(240), W, H, p)!;
    expect(r.sleeveLength).toBe('short');
    expect(r.rig.sleeveL).not.toBeNull();
    expect(r.rig.source).toBe('pose');
  });

  it('worn long sleeve with arms DOWN is still detected as long', () => {
    const p = pose({ 13: [128, 300], 14: [272, 300], 15: [125, 400], 16: [275, 400] });
    const r = rigFromPose(wornMask(405), W, H, p)!;
    expect(r.sleeveLength).toBe('long');
  });

  it('flat-lay silhouette: neck between shoulder tips, sleeves point outward', () => {
    const m = new Uint8Array(200 * 240);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * 200 + x] = 255;
    };
    fill(70, 60, 130, 230);
    fill(40, 60, 70, 110);
    fill(130, 60, 160, 110);
    for (let y = 60; y < 74; y++) for (let x = 90; x < 110; x++) m[y * 200 + x] = 0;
    const a = analyzeGarment(m, 200, 240, 0.3);
    const rig = rigFromSilhouette(m, 200, 240, a.layout);
    expect(rig.neckL.x).toBeGreaterThan(rig.shoulderL.x);
    expect(rig.neckR.x).toBeLessThan(rig.shoulderR.x);
    expect(rig.sleeveL!.axis[1]!.x).toBeLessThan(rig.shoulderL.x);
    expect(rig.sleeveR!.axis[1]!.x).toBeGreaterThan(rig.shoulderR.x);
  });
});
