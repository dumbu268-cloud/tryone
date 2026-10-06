import { describe, it, expect } from 'vitest';
import { ArticulatedEngine } from './ArticulatedEngine';
import { buildGarmentMesh } from '@/core/garment/mesh';
import { LONG_SLEEVE, TEE } from '@/core/garment/catalog';
import { PoseLandmark as P } from '@/core/perception/landmarks';
import type { GarmentAsset, GarmentDescriptor, GarmentRig, Landmark, PoseFrame, Vec2 } from '@/core/types';

const asset = (d: GarmentDescriptor): GarmentAsset => ({
  id: d.id,
  name: d.name,
  type: d.type,
  textureWidth: d.textureWidth,
  textureHeight: d.textureHeight,
  image: {} as unknown as TexImageSource,
  anchors: d.anchors,
  layout: d.layout,
  zOrder: d.zOrder,
});
const LONG = asset(LONG_SLEEVE);
const SHORT = asset(TEE);

type Lm = Partial<Record<number, [number, number, number?]>>; // x, y, visibility

/** Upright user, 1000×1000 frame, shoulders 200px apart at y=300. */
function frame(over: Lm = {}, t = 0, valid = true): PoseFrame {
  const base: Lm = {
    0: [500, 150],
    9: [485, 205],
    10: [515, 205],
    [P.LEFT_SHOULDER]: [400, 300],
    [P.RIGHT_SHOULDER]: [600, 300],
    [P.LEFT_ELBOW]: [385, 470],
    [P.RIGHT_ELBOW]: [615, 470],
    [P.LEFT_WRIST]: [380, 620],
    [P.RIGHT_WRIST]: [620, 620],
    [P.LEFT_HIP]: [440, 640],
    [P.RIGHT_HIP]: [560, 640],
  };
  const image: Vec2[] = Array.from({ length: 33 }, () => ({ x: 500, y: 500 }));
  const normalized: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  for (const [k, val] of Object.entries({ ...base, ...over })) {
    const [x, y, vis] = val!;
    image[+k] = { x, y };
    normalized[+k] = { x: x / 1000, y: y / 1000, z: 0, visibility: vis ?? 1 };
  }
  return { timestamp: t, width: 1000, height: 1000, valid, confidence: 1, image, normalized };
}

function run(e: ArticulatedEngine, f: (i: number) => PoseFrame, n = 30) {
  let fit = e.fit(f(0));
  for (let i = 1; i < n; i++) fit = e.fit(f(i));
  return fit;
}

const regionVerts = (g: GarmentAsset, reg: number) => {
  const m = buildGarmentMesh(g);
  return [...m.region.keys()].filter((i) => m.region[i] === reg);
};
const at = (pos: Float32Array, i: number): Vec2 => ({ x: pos[i * 2]!, y: pos[i * 2 + 1]! });
const centroid = (pos: Float32Array, idx: number[]) => {
  let x = 0;
  let y = 0;
  for (const i of idx) {
    x += pos[i * 2]!;
    y += pos[i * 2 + 1]!;
  }
  return { x: x / idx.length, y: y / idx.length };
};

describe('ArticulatedEngine (rig + TPS)', () => {
  it('produces a full, finite mesh', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    const fit = run(e, (i) => frame({}, i * 33));
    expect(fit.visible).toBe(true);
    for (const n of fit.positions!) expect(Number.isFinite(n)).toBe(true);
  });

  it('places the collar ABOVE the shoulder joints (neck is modelled)', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    const fit = run(e, (i) => frame({}, i * 33));
    const [neckL, neckR] = fit.debug!.keypoints;
    expect(neckL!.y).toBeLessThan(300 - 25);
    expect(neckR!.y).toBeLessThan(300 - 25);
    expect(neckL!.x).toBeGreaterThan(400);
    expect(neckR!.x).toBeLessThan(600);
  });

  it('torso fit is independent of arm landmarks', () => {
    const torso = regionVerts(LONG, 0);
    const a = new ArticulatedEngine();
    a.prepare(LONG);
    const fa = run(a, (i) => frame({}, i * 33));
    const b = new ArticulatedEngine();
    b.prepare(LONG);
    const fb = run(b, (i) =>
      frame({ [P.LEFT_ELBOW]: [250, 250], [P.LEFT_WRIST]: [150, 120], [P.RIGHT_WRIST]: [0, 0, 0] }, i * 33),
    );
    for (const i of torso.slice(0, 60)) {
      expect(at(fa.positions!, i).x).toBeCloseTo(at(fb.positions!, i).x, 6);
      expect(at(fb.positions!, i).y).toBeCloseTo(at(fa.positions!, i).y, 6);
    }
  });

  it("upper sleeve follows the elbow even when the wrist is out of frame", () => {
    const m = buildGarmentMesh(SHORT);
    let cuff = -1;
    for (let i = 0; i < m.vertexCount; i++)
      if (m.region[i] === 1 && (cuff < 0 || m.paramA[i]! - Math.abs(m.paramB[i]!) > m.paramA[cuff]! - Math.abs(m.paramB[cuff]!))) cuff = i;
    const left = [cuff];
    const e = new ArticulatedEngine();
    e.prepare(SHORT);
    const offscreenWrists = { [P.LEFT_WRIST]: [380, 1100], [P.RIGHT_WRIST]: [620, 1100] } as Lm;
    const down = run(e, (i) => frame({ ...offscreenWrists }, i * 33));
    expect(down.debug!.arms[0]!.state).toBe('partial');
    const c0 = centroid(down.positions!, left);
    const raised = run(e, (i) => frame({ ...offscreenWrists, [P.LEFT_ELBOW]: [230, 300] }, 2000 + i * 33));
    const c1 = centroid(raised.positions!, left);
    expect(raised.debug!.arms[0]!.state).toBe('partial');
    expect(c1.x).toBeLessThan(c0.x - 50); // cuff moved out with the elbow
    expect(c1.y).toBeLessThan(c0.y - 50); // and up
  });

  it('holds the last arm pose on landmark loss, then eases to rest (never vanishes)', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    run(e, (i) => frame({ [P.LEFT_ELBOW]: [230, 300], [P.LEFT_WRIST]: [100, 300] }, i * 33));
    const lost = { [P.LEFT_ELBOW]: [230, 300, 0], [P.LEFT_WRIST]: [100, 300, 0] } as Lm;
    const soon = e.fit(frame(lost, 30 * 33 + 50));
    const soonFit = e.fit(frame(lost, 30 * 33 + 100));
    expect(['held', 'tracked', 'partial']).toContain(soonFit.debug!.arms[0]!.state);
    void soon;
    const heldElbow = soonFit.debug!.arms[0]!.chain[1]!;
    expect(heldElbow.x).toBeLessThan(330); // still near the last good (raised) elbow

    const later = run(e, (i) => frame(lost, 5000 + i * 100), 40);
    expect(later.debug!.arms[0]!.state).toBe('rest');
    const restElbow = later.debug!.arms[0]!.chain[1]!;
    expect(restElbow.y).toBeGreaterThan(400); // hanging down at the side
    expect(later.leftSleeveOpacity ?? 1).toBe(1);
    expect(later.visible).toBe(true);
  });

  it('infers the elbow from a visible wrist when the elbow is out of frame (IK)', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    // Close framing, hand raised near the face, elbow below the frame.
    const f = run(e, (i) => frame({ [P.LEFT_ELBOW]: [330, 1080, 0.2], [P.LEFT_WRIST]: [430, 190] }, i * 33));
    const arm = f.debug!.arms[0]!;
    expect(arm.state).toBe('partial');
    const [shoulder, elbow, wrist] = arm.chain;
    expect(Math.abs(wrist!.x - 430) + Math.abs(wrist!.y - 190)).toBeLessThan(1); // sleeve ends at the real hand
    // Valid two-bone chain (upper arm ≈ 0.85 × 200px) with the elbow below the hand.
    expect(Math.hypot(elbow!.x - shoulder!.x, elbow!.y - shoulder!.y)).toBeCloseTo(170, 0);
    expect(elbow!.y).toBeGreaterThan(wrist!.y);
  });

  it('different garments produce different geometry on the same body', () => {
    // Same shoulders/armpits; a cropped boxy top vs a long flared tunic.
    const rigGarment = (hemDepth: number, hemHalf: number, sleeveLen: number): GarmentAsset => {
      const rig: GarmentRig = {
        neckL: { x: 170, y: 100 },
        neckR: { x: 230, y: 100 },
        shoulderL: { x: 100, y: 110 },
        shoulderR: { x: 300, y: 110 },
        armpitL: { x: 100, y: 200 },
        armpitR: { x: 300, y: 200 },
        hemL: { x: 200 - hemHalf, y: 110 + hemDepth },
        hemR: { x: 200 + hemHalf, y: 110 + hemDepth },
        sleeveL: sleeveLen ? { axis: [{ x: 100, y: 155 }, { x: 100 - sleeveLen, y: 175 }], rootHalfWidth: 40, tipHalfWidth: 25 } : null,
        sleeveR: sleeveLen ? { axis: [{ x: 300, y: 155 }, { x: 300 + sleeveLen, y: 175 }], rootHalfWidth: 40, tipHalfWidth: 25 } : null,
        source: 'silhouette',
      };
      return { ...LONG, id: `rig-${hemDepth}`, textureWidth: 700, textureHeight: 700, layout: { ...LONG.layout, rig } };
    };
    const measure = (g: GarmentAsset) => {
      const e = new ArticulatedEngine();
      e.prepare(g);
      const f = run(e, (i) => frame({}, i * 33));
      const k = f.debug!.keypoints;
      const m = buildGarmentMesh(g);
      return { hemY: (k[6]!.y + k[7]!.y) / 2, hemW: k[7]!.x - k[6]!.x, sleeveVerts: m.ranges.leftSleeve.count };
    };
    const crop = measure(rigGarment(130, 95, 0));
    const tunic = measure(rigGarment(420, 140, 260));
    expect(tunic.hemY - crop.hemY).toBeGreaterThan(150); // much longer
    expect(tunic.hemW).toBeGreaterThan(crop.hemW * 1.3); // flared hem
    expect(crop.sleeveVerts).toBe(0); // sleeveless
    expect(tunic.sleeveVerts).toBeGreaterThan(0);
  });

  it('never renders upside down when hips are detected above the shoulders', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    const fit = run(e, (i) => frame({ [P.LEFT_HIP]: [440, 150], [P.RIGHT_HIP]: [560, 150] }, i * 33));
    expect(fit.quad.tl.y).toBeLessThan(fit.quad.bl.y);
    expect(fit.quad.tr.y).toBeLessThan(fit.quad.br.y);
  });

  it('keeps the garment length when hips are out of frame (seated / close)', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    const fit = run(e, (i) => frame({ [P.LEFT_HIP]: [440, 1200, 0.2], [P.RIGHT_HIP]: [560, 1200, 0.2] }, i * 33));
    expect(fit.quad.bl.y).toBeGreaterThan(560);
  });

  it('holds the fit briefly when the person is lost, then fades out', () => {
    const e = new ArticulatedEngine();
    e.prepare(LONG);
    run(e, (i) => frame({}, i * 33));
    const held = e.fit(frame({}, 30 * 33 + 200, false));
    expect(held.visible).toBe(true);
    const gone = run(e, (i) => frame({}, 5000 + i * 100, false), 40);
    expect(gone.visible).toBe(false);
  });
});
