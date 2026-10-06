import type { GarmentDescriptor } from '@/core/types';

// Phase 1 ships exactly one bundled garment. Anchors are in the SVG's viewBox
// coordinate space (400 x 440). Shoulders + hem form the homography source quad;
// neck and sleeve points are carried for later deformation (Phase 2).
export const BUNDLED_TEE: GarmentDescriptor = {
  id: 'tee-classic-blue',
  name: 'Classic Crew Tee',
  type: 'tshirt',
  textureUrl: '/garments/tee.svg',
  textureWidth: 400,
  textureHeight: 440,
  anchors: {
    neck: { x: 200, y: 96 },
    leftShoulder: { x: 118, y: 100 },
    rightShoulder: { x: 282, y: 100 },
    leftHem: { x: 120, y: 420 },
    rightHem: { x: 280, y: 420 },
    leftSleeve: { x: 76, y: 176 },
    rightSleeve: { x: 324, y: 176 },
  },
  zOrder: 10,
  colorHints: { dominant: [79, 114, 180] },
};

export const DEFAULT_GARMENT = BUNDLED_TEE;
