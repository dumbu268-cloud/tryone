import { describe, it, expect } from 'vitest';
import { MeshWarpEngine } from './MeshWarpEngine';
import { project } from '@/core/math/homography';
import { PoseLandmark } from '@/core/perception/landmarks';
import { TEE } from '@/core/garment/catalog';
import type { GarmentAsset, PoseFrame, Vec2 } from '@/core/types';

const garment: GarmentAsset = {
  id: TEE.id,
  name: TEE.name,
  type: TEE.type,
  textureWidth: TEE.textureWidth,
  textureHeight: TEE.textureHeight,
  image: {} as unknown as TexImageSource, // engine never touches pixels
  anchors: TEE.anchors,
  layout: TEE.layout,
  zOrder: TEE.zOrder,
};

function makeFrame(opts: {
  shoulders: [Vec2, Vec2];
  hips: [Vec2, Vec2];
  valid?: boolean;
}): PoseFrame {
  const image: Vec2[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  image[PoseLandmark.LEFT_SHOULDER] = opts.shoulders[0];
  image[PoseLandmark.RIGHT_SHOULDER] = opts.shoulders[1];
  image[PoseLandmark.LEFT_HIP] = opts.hips[0];
  image[PoseLandmark.RIGHT_HIP] = opts.hips[1];
  return {
    timestamp: 0,
    width: 1000,
    height: 1000,
    valid: opts.valid ?? true,
    confidence: 1,
    image,
    normalized: [],
  };
}

const upright = () =>
  makeFrame({
    shoulders: [
      { x: 400, y: 300 },
      { x: 600, y: 300 },
    ],
    hips: [
      { x: 420, y: 600 },
      { x: 580, y: 600 },
    ],
  });

function settle(engine: MeshWarpEngine, frame: PoseFrame, n = 40) {
  let last = engine.fit(frame);
  for (let i = 1; i < n; i++) last = engine.fit(frame);
  return last;
}

describe('MeshWarpEngine v0', () => {
  it('is invisible before a garment is prepared', () => {
    const e = new MeshWarpEngine();
    expect(e.fit(upright()).visible).toBe(false);
  });

  it('fits a well-formed torso quad for an upright pose', () => {
    const e = new MeshWarpEngine();
    e.prepare(garment);
    const fit = settle(e, upright());

    expect(fit.visible).toBe(true);
    // Correct corner ordering.
    expect(fit.quad.tl.x).toBeLessThan(fit.quad.tr.x);
    expect(fit.quad.bl.x).toBeLessThan(fit.quad.br.x);
    expect(fit.quad.tl.y).toBeLessThan(fit.quad.bl.y);
    // Horizontally centred around the body midline (x=500).
    const cx = (fit.quad.tl.x + fit.quad.tr.x) / 2;
    expect(Math.abs(cx - 500)).toBeLessThan(1);
    // Torso wider than the raw shoulder span (shirt sits outside the joints).
    expect(fit.quad.tr.x - fit.quad.tl.x).toBeGreaterThan(200);
    // Hem extends below the hips (y=600).
    expect(fit.quad.bl.y).toBeGreaterThan(600);
  });

  it('maps the garment neck anchor above the shoulder line', () => {
    const e = new MeshWarpEngine();
    e.prepare(garment);
    const fit = settle(e, upright());
    const neck = project(fit.homography!, TEE.anchors.neck);
    expect(neck.y).toBeLessThan(300); // above shoulders (y=300)
    expect(Math.abs(neck.x - 500)).toBeLessThan(10); // near the midline
  });

  it('fades in over time rather than popping', () => {
    const e = new MeshWarpEngine();
    e.prepare(garment);
    const first = e.fit(upright());
    expect(first.opacity).toBeGreaterThan(0);
    expect(first.opacity).toBeLessThan(0.5);
    const settled = settle(e, upright());
    expect(settled.opacity).toBeGreaterThan(0.95);
  });

  it('narrows when the shoulders foreshorten (yaw/turn)', () => {
    const e = new MeshWarpEngine();
    e.prepare(garment);
    const front = settle(e, upright());
    const frontWidth = front.quad.tr.x - front.quad.tl.x;

    const turned = settle(
      e,
      makeFrame({
        shoulders: [
          { x: 470, y: 300 },
          { x: 560, y: 300 },
        ],
        hips: [
          { x: 475, y: 600 },
          { x: 555, y: 600 },
        ],
      }),
    );
    const turnedWidth = turned.quad.tr.x - turned.quad.tl.x;
    expect(turnedWidth).toBeLessThan(frontWidth);
  });

  it('fades out when tracking is lost', () => {
    const e = new MeshWarpEngine();
    e.prepare(garment);
    settle(e, upright());
    const invalid = makeFrame({
      shoulders: [
        { x: 400, y: 300 },
        { x: 600, y: 300 },
      ],
      hips: [
        { x: 420, y: 600 },
        { x: 580, y: 600 },
      ],
      valid: false,
    });
    let fit = e.fit(invalid);
    for (let i = 0; i < 60; i++) fit = e.fit(invalid);
    expect(fit.visible).toBe(false);
    expect(fit.opacity).toBeLessThan(0.05);
  });
});
