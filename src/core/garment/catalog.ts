import type { GarmentDescriptor } from '@/core/types';

// Phase 2 ships two bundled garments to exercise the articulated engine. All
// coordinates are in each SVG's viewBox (texture) space. The `layout` regions
// must match the SVG artwork so mesh UVs line up with the drawn fabric.

export const LONG_SLEEVE: GarmentDescriptor = {
  id: 'shirt-long-green',
  name: 'Long-Sleeve Shirt',
  type: 'longsleeve',
  textureUrl: '/garments/longsleeve.svg',
  textureWidth: 520,
  textureHeight: 460,
  anchors: {
    neck: { x: 260, y: 128 },
    leftShoulder: { x: 185, y: 120 },
    rightShoulder: { x: 335, y: 120 },
    leftHem: { x: 185, y: 440 },
    rightHem: { x: 335, y: 440 },
    leftSleeve: { x: 48, y: 200 },
    rightSleeve: { x: 472, y: 200 },
  },
  layout: {
    torso: {
      tl: { x: 185, y: 120 },
      tr: { x: 335, y: 120 },
      br: { x: 335, y: 440 },
      bl: { x: 185, y: 440 },
    },
    leftSleeve: {
      rootTop: { x: 185, y: 120 },
      rootBottom: { x: 185, y: 235 },
      tipTop: { x: 40, y: 150 },
      tipBottom: { x: 55, y: 250 },
    },
    rightSleeve: {
      rootTop: { x: 335, y: 120 },
      rootBottom: { x: 335, y: 235 },
      tipTop: { x: 480, y: 150 },
      tipBottom: { x: 465, y: 250 },
    },
    sleeveLength: 'long',
    coversForearm: true,
  },
  zOrder: 10,
  colorHints: { dominant: [63, 125, 106] },
};

export const TEE: GarmentDescriptor = {
  id: 'tee-classic-blue',
  name: 'Classic Crew Tee',
  type: 'tshirt',
  textureUrl: '/garments/tee.svg',
  textureWidth: 400,
  textureHeight: 440,
  anchors: {
    neck: { x: 200, y: 108 },
    leftShoulder: { x: 120, y: 100 },
    rightShoulder: { x: 280, y: 100 },
    leftHem: { x: 120, y: 420 },
    rightHem: { x: 280, y: 420 },
    leftSleeve: { x: 63, y: 150 },
    rightSleeve: { x: 337, y: 150 },
  },
  layout: {
    torso: {
      tl: { x: 120, y: 100 },
      tr: { x: 280, y: 100 },
      br: { x: 280, y: 420 },
      bl: { x: 120, y: 420 },
    },
    leftSleeve: {
      rootTop: { x: 120, y: 100 },
      rootBottom: { x: 120, y: 185 },
      tipTop: { x: 60, y: 112 },
      tipBottom: { x: 66, y: 195 },
    },
    rightSleeve: {
      rootTop: { x: 280, y: 100 },
      rootBottom: { x: 280, y: 185 },
      tipTop: { x: 340, y: 112 },
      tipBottom: { x: 334, y: 195 },
    },
    sleeveLength: 'short',
    coversForearm: false,
  },
  zOrder: 10,
  colorHints: { dominant: [79, 114, 180] },
};

export const CATALOG: GarmentDescriptor[] = [LONG_SLEEVE, TEE];

/** Default garment: the long sleeve best demonstrates sleeve articulation. */
export const DEFAULT_GARMENT = LONG_SLEEVE;

/**
 * Bundled sample clothing images for the automatic preparation pipeline (Phase 3).
 * These are ordinary flat-lay garment images on a plain background — the preparer
 * derives the layout/regions from them (no hand-authored layout).
 */
export interface SampleImage {
  id: string;
  name: string;
  url: string;
}

export const SAMPLE_IMAGES: SampleImage[] = [
  { id: 'sample-tshirt', name: 'Tee (auto)', url: '/garments/samples/sample-tshirt.svg' },
  { id: 'sample-longsleeve', name: 'Long sleeve (auto)', url: '/garments/samples/sample-longsleeve.svg' },
  { id: 'sample-tank', name: 'Tank (auto)', url: '/garments/samples/sample-tank.svg' },
];
