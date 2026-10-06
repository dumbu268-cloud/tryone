import { describe, it, expect } from 'vitest';
import { ArticulatedEngine } from './ArticulatedEngine';
import { buildGarmentMesh } from '@/core/garment/mesh';
import { LONG_SLEEVE } from '@/core/garment/catalog';
import { PoseLandmark } from '@/core/perception/landmarks';
import type { GarmentAsset, Landmark, PoseFrame, Vec2 } from '@/core/types';

const garment: GarmentAsset = {
  id: LONG_SLEEVE.id,
  name: LONG_SLEEVE.name,
  type: LONG_SLEEVE.type,
  textureWidth: LONG_SLEEVE.textureWidth,
  textureHeight: LONG_SLEEVE.textureHeight,
  image: {} as unknown as TexImageSource,
  anchors: LONG_SLEEVE.anchors,
  layout: LONG_SLEEVE.layout,
  zOrder: LONG_SLEEVE.zOrder,
};

const mesh = buildGarmentMesh(garment);

/** Index of the left-sleeve cuff-centre vertex (region 1, t≈1, s≈0). */
function leftCuffCentreVertex(): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    if (mesh.region[i] !== 1) continue;
    const score = mesh.paramA[i]! - Math.abs(mesh.paramB[i]!);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

type Lm = Record<number, [number, number]>;

function makeFrame(positions: Lm, hidden: number[] = []): PoseFrame {
  const image: Vec2[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  const normalized: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  const base: Lm = {
    [PoseLandmark.LEFT_SHOULDER]: [400, 300],
    [PoseLandmark.RIGHT_SHOULDER]: [600, 300],
    [PoseLandmark.LEFT_ELBOW]: [385, 450],
    [PoseLandmark.RIGHT_ELBOW]: [615, 450],
    [PoseLandmark.LEFT_WRIST]: [375, 590],
    [PoseLandmark.RIGHT_WRIST]: [625, 590],
    [PoseLandmark.LEFT_HIP]: [430, 620],
    [PoseLandmark.RIGHT_HIP]: [570, 620],
  };
  const merged = { ...base, ...positions };
  for (const key of Object.keys(merged)) {
    const idx = Number(key);
    const [x, y] = merged[idx]!;
    image[idx] = { x, y };
    normalized[idx] = { x: x / 1000, y: y / 1000, z: 0, visibility: 1 };
  }
  for (const idx of hidden) normalized[idx] = { ...normalized[idx]!, visibility: 0 };
  return { timestamp: 0, width: 1000, height: 1000, valid: true, confidence: 1, image, normalized };
}

function vertexPos(positions: Float32Array, idx: number): Vec2 {
  return { x: positions[idx * 2]!, y: positions[idx * 2 + 1]! };
}

describe('ArticulatedEngine', () => {
  it('produces a full, finite mesh for an upright pose', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    const fit = e.fit(makeFrame({}));
    expect(fit.visible).toBe(true);
    expect(fit.positions).toBeDefined();
    expect(fit.positions!.length).toBe(mesh.vertexCount * 2);
    for (const n of fit.positions!) expect(Number.isFinite(n)).toBe(true);
  });

  it('left sleeve cuff follows the left wrist when the arm is raised sideways', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    const cuff = leftCuffCentreVertex();
    expect(cuff).toBeGreaterThanOrEqual(0);

    const armDown = e.fit(makeFrame({})).positions!;
    const downCuff = vertexPos(armDown, cuff);

    // Raise the (screen-left) arm out horizontally to the left.
    const raised = e.fit(
      makeFrame({
        [PoseLandmark.LEFT_ELBOW]: [300, 300],
        [PoseLandmark.LEFT_WRIST]: [180, 300],
      }),
    ).positions!;
    const raisedCuff = vertexPos(raised, cuff);

    // The cuff should move far to the left (toward the wrist) and up to ~shoulder height.
    expect(raisedCuff.x).toBeLessThan(downCuff.x - 120);
    expect(raisedCuff.y).toBeLessThan(downCuff.y - 120);
    // And land in the neighbourhood of the actual wrist.
    expect(Math.abs(raisedCuff.x - 180)).toBeLessThan(90);
    expect(Math.abs(raisedCuff.y - 300)).toBeLessThan(90);
  });

  it('elbow bend puts the cuff near the wrist (two-bone chain)', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    const cuff = leftCuffCentreVertex();
    // Elbow out to the side, forearm bent downward.
    const bent = e.fit(
      makeFrame({
        [PoseLandmark.LEFT_ELBOW]: [300, 330],
        [PoseLandmark.LEFT_WRIST]: [340, 500],
      }),
    ).positions!;
    const c = vertexPos(bent, cuff);
    expect(Math.abs(c.x - 340)).toBeLessThan(110);
    expect(Math.abs(c.y - 500)).toBeLessThan(120);
  });

  it('falls back to a stable hanging sleeve when the arm is untracked', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    const cuff = leftCuffCentreVertex();
    const fit = e.fit(
      makeFrame(
        { [PoseLandmark.LEFT_ELBOW]: [9999, 9999], [PoseLandmark.LEFT_WRIST]: [9999, 9999] },
        [PoseLandmark.LEFT_ELBOW, PoseLandmark.LEFT_WRIST],
      ),
    );
    const c = vertexPos(fit.positions!, cuff);
    // Not driven to the bogus (9999) coordinates; hangs below the shoulder.
    expect(Number.isFinite(c.x)).toBe(true);
    expect(c.x).toBeLessThan(1000);
    expect(c.y).toBeGreaterThan(300);
  });

  it('synthesizes a full torso when the hips are not visible (seated/cropped framing)', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);

    // Hips hidden; their image coords are a bad high guess near the chest.
    const cropped = e.fit(
      makeFrame(
        { [PoseLandmark.LEFT_HIP]: [470, 360], [PoseLandmark.RIGHT_HIP]: [530, 360] },
        [PoseLandmark.LEFT_HIP, PoseLandmark.RIGHT_HIP],
      ),
    );
    // Shoulders at y=300, width 200 => synthesized torso extends well below the chest,
    // not collapsing onto the bad hip guess at y=360.
    expect(cropped.quad.bl.y).toBeGreaterThan(600);
    // Torso stays a sensible width (near the shoulder span), not a narrow bib.
    expect(cropped.quad.tr.x - cropped.quad.tl.x).toBeGreaterThan(180);
  });

  it('extends a too-short torso to a realistic length (close/seated framing)', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    // Hips VISIBLE but detected high near the chest (person close to camera).
    const fit = e.fit(
      makeFrame({
        [PoseLandmark.LEFT_HIP]: [470, 360],
        [PoseLandmark.RIGHT_HIP]: [530, 360],
      }),
    );
    // Shoulders span 200 at y=300 → torso clamped to ≥1.5×width, hem well below.
    expect(fit.quad.bl.y).toBeGreaterThan(600);
    expect(fit.quad.tr.x - fit.quad.tl.x).toBeGreaterThan(180);
  });

  it('fades a sleeve out when its arm is not tracked (no stuck blob)', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    const fit = e.fit(
      makeFrame({}, [PoseLandmark.LEFT_ELBOW, PoseLandmark.LEFT_WRIST]),
    );
    expect(fit.leftSleeveOpacity ?? 1).toBeLessThan(0.1);
    expect(fit.rightSleeveOpacity ?? 0).toBeGreaterThan(0.9);
  });

  it('fades out and hides when tracking is lost', () => {
    const e = new ArticulatedEngine();
    e.prepare(garment);
    e.fit(makeFrame({}));
    const invalid: PoseFrame = { ...makeFrame({}), valid: false };
    let fit = e.fit(invalid);
    for (let i = 0; i < 60; i++) fit = e.fit(invalid);
    expect(fit.visible).toBe(false);
    expect(fit.opacity).toBeLessThan(0.05);
  });
});
