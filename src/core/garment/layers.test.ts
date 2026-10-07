import { describe, it, expect } from 'vitest';
import { computeLayerPixels, pushPullFill, LABEL_LEFT, LABEL_RIGHT, LABEL_TORSO } from './layers';
import { buildGarmentMesh } from './mesh';
import { analyzeGarment } from './prep/analyze';
import { rigFromSilhouette, sleeveClassFromRig } from './rig';
import { armholeAnchoring } from '@/core/fit/tube';
import type { GarmentAsset, GarmentLayout } from '@/core/types';

// Synthetic product-style shirt (texture px == image px): body + two sleeves
// hanging down beside it with a background gap below the armpits.
const W = 200;
const H = 240;
function hangingShirt(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const j = (y * W + x) * 4;
        d[j] = rgb[0];
        d[j + 1] = rgb[1];
        d[j + 2] = rgb[2];
        d[j + 3] = 255;
      }
    }
  };
  paint(70, 30, 130, 200, [150, 190, 170]); // body
  paint(48, 34, 70, 64, [140, 180, 160]); // shoulder caps (sleeve tops fused to body)
  paint(130, 34, 152, 64, [140, 180, 160]);
  paint(46, 64, 66, 190, [140, 180, 160]); // left sleeve hanging, 4px gap to the body
  paint(134, 64, 154, 190, [140, 180, 160]); // right sleeve
  return d;
}
function maskOf(d: Uint8ClampedArray): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3]! > 0 ? 255 : 0;
  return m;
}

function assetFor(layout: GarmentLayout): GarmentAsset {
  return {
    id: 't',
    name: 't',
    type: 'longsleeve',
    textureWidth: W,
    textureHeight: H,
    image: {} as unknown as TexImageSource,
    anchors: {
      neck: { x: 100, y: 30 },
      leftShoulder: layout.torso.tl,
      rightShoulder: layout.torso.tr,
      leftHem: layout.torso.bl,
      rightHem: layout.torso.br,
    },
    layout,
    zOrder: 10,
  };
}

describe('hanging-sleeve garment analysis', () => {
  const px = hangingShirt();
  const mask = maskOf(px);
  const a = analyzeGarment(mask, W, H, 0.3);
  const rig = rigFromSilhouette(mask, W, H, a.layout);

  it('measures the body width from the central run, not the sleeves', () => {
    expect(Math.abs(a.layout.torso.tl.x - 70)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.layout.torso.tr.x - 129)).toBeLessThanOrEqual(1);
  });

  it('finds the armpit where the sleeve separates and classifies long sleeves', () => {
    expect(Math.abs(rig.armpitL.y - 64)).toBeLessThanOrEqual(2);
    expect(rig.sleeveL).not.toBeNull();
    expect(rig.sleeveL!.axis[1]!.y).toBeGreaterThan(170); // cuff near the bottom
    expect(sleeveClassFromRig(rig)).toBe('long');
  });

  it('splits sleeves from the body and fills the body behind them', () => {
    const mesh = buildGarmentMesh(assetFor({ ...a.layout, rig }));
    const L = computeLayerPixels(px, W, H, 1, mesh);
    const lab = (x: number, y: number) => L.labels[y * W + x];
    expect(lab(56, 150)).toBe(LABEL_LEFT); // hanging left sleeve
    expect(lab(144, 150)).toBe(LABEL_RIGHT);
    expect(lab(100, 150)).toBe(LABEL_TORSO); // body centre
    // Sleeve pixels are absent from the torso layer, present in the sleeve layer.
    expect(L.torso[(150 * W + 50) * 4 + 3]).toBe(0);
    expect(L.sleeves[(150 * W + 50) * 4 + 3]).toBe(255);
    // Body stays opaque at its side (seam padding under the sleeve).
    expect(L.torso[(150 * W + 71) * 4 + 3]).toBe(255);
  });
});

describe('torso completion', () => {
  it('push-pull fills unknown pixels from their neighbours', () => {
    const w = 8;
    const h = 8;
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const hole = i % w >= 3 && i % w <= 4;
      known[i] = hole ? 0 : 1;
      rgb[i * 3] = hole ? 0 : 200;
      rgb[i * 3 + 1] = hole ? 0 : 100;
    }
    pushPullFill(rgb, w, h, known);
    expect(rgb[(4 * w + 3) * 3]).toBeCloseTo(200, 0);
    expect(rgb[(4 * w + 4) * 3 + 1]).toBeCloseTo(100, 0);
  });
});

describe('sleeve root anchoring', () => {
  it('anchors on the armhole for a sleeve leaving at an angle, not for a hanging one', () => {
    expect(armholeAnchoring({ x: -1, y: 0.2 }, { x: 0, y: 1 })).toBeGreaterThan(0.95);
    expect(armholeAnchoring({ x: -0.1, y: 1 }, { x: 0, y: 1 })).toBeLessThan(0.05);
  });
});
