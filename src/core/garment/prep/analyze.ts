import type { BBox, GarmentAnchors, GarmentLayout, GarmentType, Vec2 } from '@/core/types';

// Garment understanding from a binary mask. Assumes a roughly symmetric,
// front-facing flat-lay top (t-shirt / long-sleeve / simple top). Uses a
// row/column occupancy profile to locate the torso, the armholes, the sleeve
// tips and the sleeve length. Pure + deterministic (operates on a Uint8 mask).

export interface GarmentAnalysis {
  supported: boolean;
  reason?: string;
  type: GarmentType;
  sleeveLength: 'short' | 'long' | 'none';
  coversForearm: boolean;
  bbox: BBox;
  foregroundRatio: number;
  layout: GarmentLayout;
  anchors: GarmentAnchors;
}

export interface AnalyzeOptions {
  /** Column distance beyond the torso edge counted as a sleeve, as a fraction of torso width. */
  sleeveMargin?: number;
  /** reach/torsoWidth above which sleeves are classified "long". */
  longSleeveRatio?: number;
}

const DEFAULTS: Required<AnalyzeOptions> = { sleeveMargin: 0.06, longSleeveRatio: 0.55 };

interface RowSpan {
  left: number;
  right: number;
  count: number;
}

export function analyzeGarment(
  alpha: Uint8Array,
  w: number,
  h: number,
  foregroundRatio: number,
  options: AnalyzeOptions = {},
): GarmentAnalysis {
  const opts = { ...DEFAULTS, ...options };

  const rows: RowSpan[] = new Array(h);
  let minY = -1;
  let maxY = -1;
  let minX = w;
  let maxX = -1;
  let fgCount = 0;
  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    let count = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[base + x]) {
        if (left < 0) left = x;
        right = x;
        count++;
      }
    }
    rows[y] = { left, right, count };
    if (count > 0) {
      if (minY < 0) minY = y;
      maxY = y;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      fgCount += count;
    }
  }

  const bbox: BBox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  // Guard rails for "not a prepared garment".
  const fallback = (reason: string): GarmentAnalysis =>
    makeFallback(bbox, foregroundRatio, reason, w, h);

  if (fgCount === 0) return fallback('No garment found after background removal.');
  if (foregroundRatio > 0.92) return fallback('Background could not be separated.');
  if (bbox.height < h * 0.15 || bbox.width < w * 0.1) return fallback('Garment region too small.');

  // Torso side bounds: median occupancy over the lower 45% (pure torso, below sleeves).
  const lo = Math.round(minY + bbox.height * 0.55);
  const hi = maxY;
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let y = lo; y <= hi; y++) {
    const r = rows[y]!;
    if (r.count > 0) {
      lefts.push(r.left);
      rights.push(r.right);
    }
  }
  const torsoLeft = medianOf(lefts, minX);
  const torsoRight = medianOf(rights, maxX);
  const torsoWidth = Math.max(1, torsoRight - torsoLeft);
  const margin = torsoWidth * opts.sleeveMargin;

  const torsoTopY = minY;
  const hemY = maxY;

  // Sleeves: rows (in the upper 65%) whose foreground reaches beyond the torso edges.
  const sleeveLimitY = Math.round(minY + bbox.height * 0.65);
  let armpitY = -1;
  let leftTipX = torsoLeft;
  let rightTipX = torsoRight;
  let hasLeft = false;
  let hasRight = false;
  for (let y = minY; y <= sleeveLimitY; y++) {
    const r = rows[y]!;
    if (r.count === 0) continue;
    if (r.left < torsoLeft - margin) {
      hasLeft = true;
      leftTipX = Math.min(leftTipX, r.left);
      armpitY = Math.max(armpitY, y);
    }
    if (r.right > torsoRight + margin) {
      hasRight = true;
      rightTipX = Math.max(rightTipX, r.right);
      armpitY = Math.max(armpitY, y);
    }
  }

  const hasSleeves = hasLeft || hasRight;
  if (armpitY < 0) armpitY = Math.round(minY + bbox.height * 0.33);

  const reach = Math.max(torsoLeft - leftTipX, rightTipX - torsoRight);
  const sleeveLength: 'short' | 'long' | 'none' = !hasSleeves
    ? 'none'
    : reach > torsoWidth * opts.longSleeveRatio
      ? 'long'
      : 'short';
  const coversForearm = sleeveLength === 'long';
  const type: GarmentType = sleeveLength === 'long' ? 'longsleeve' : 'tshirt';

  // Degenerate sleeve quads (collapsed to the armhole) render nothing for sleeveless tops.
  const leftSleeve = hasLeft
    ? sleeveQuad(torsoLeft, leftTipX, torsoTopY, armpitY)
    : collapsedSleeve(torsoLeft, torsoTopY, armpitY);
  const rightSleeve = hasRight
    ? sleeveQuad(torsoRight, rightTipX, torsoTopY, armpitY)
    : collapsedSleeve(torsoRight, torsoTopY, armpitY);

  const torso = {
    tl: { x: torsoLeft, y: torsoTopY },
    tr: { x: torsoRight, y: torsoTopY },
    br: { x: torsoRight, y: hemY },
    bl: { x: torsoLeft, y: hemY },
  };

  const cx = (torsoLeft + torsoRight) / 2;
  const anchors: GarmentAnchors = {
    neck: { x: cx, y: torsoTopY + bbox.height * 0.06 },
    leftShoulder: { x: torsoLeft, y: torsoTopY },
    rightShoulder: { x: torsoRight, y: torsoTopY },
    leftHem: { x: torsoLeft, y: hemY },
    rightHem: { x: torsoRight, y: hemY },
    leftSleeve: { x: leftTipX, y: (torsoTopY + armpitY) / 2 },
    rightSleeve: { x: rightTipX, y: (torsoTopY + armpitY) / 2 },
  };

  const layout: GarmentLayout = { torso, leftSleeve, rightSleeve, sleeveLength: sleeveLength === 'long' ? 'long' : 'short', coversForearm };

  return {
    supported: true,
    ...(hasSleeves ? {} : { reason: 'No sleeves detected (sleeveless/tank); torso only.' }),
    type,
    sleeveLength,
    coversForearm,
    bbox,
    foregroundRatio,
    layout,
    anchors,
  };
}

function sleeveQuad(rootX: number, tipX: number, topY: number, armpitY: number) {
  return {
    rootTop: { x: rootX, y: topY },
    rootBottom: { x: rootX, y: armpitY },
    tipTop: { x: tipX, y: topY + (armpitY - topY) * 0.12 },
    tipBottom: { x: tipX, y: armpitY },
  };
}

function collapsedSleeve(rootX: number, topY: number, armpitY: number) {
  const p: Vec2 = { x: rootX, y: topY };
  return { rootTop: p, rootBottom: { x: rootX, y: armpitY }, tipTop: p, tipBottom: { x: rootX, y: armpitY } };
}

function medianOf(xs: number[], fallbackVal: number): number {
  if (xs.length === 0) return fallbackVal;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function makeFallback(
  bbox: BBox,
  foregroundRatio: number,
  reason: string,
  w: number,
  h: number,
): GarmentAnalysis {
  // Treat the whole (or bbox) region as a torso-only garment so rendering still works.
  const x0 = bbox.width > 0 ? bbox.x : Math.round(w * 0.2);
  const y0 = bbox.height > 0 ? bbox.y : Math.round(h * 0.1);
  const x1 = bbox.width > 0 ? bbox.x + bbox.width - 1 : Math.round(w * 0.8);
  const y1 = bbox.height > 0 ? bbox.y + bbox.height - 1 : Math.round(h * 0.9);
  const torso = {
    tl: { x: x0, y: y0 },
    tr: { x: x1, y: y0 },
    br: { x: x1, y: y1 },
    bl: { x: x0, y: y1 },
  };
  const anchors: GarmentAnchors = {
    neck: { x: (x0 + x1) / 2, y: y0 + (y1 - y0) * 0.06 },
    leftShoulder: { x: x0, y: y0 },
    rightShoulder: { x: x1, y: y0 },
    leftHem: { x: x0, y: y1 },
    rightHem: { x: x1, y: y1 },
  };
  return {
    supported: false,
    reason,
    type: 'tshirt',
    sleeveLength: 'none',
    coversForearm: false,
    bbox,
    foregroundRatio,
    layout: {
      torso,
      leftSleeve: collapsedSleeve(x0, y0, Math.round((y0 + y1) / 3)),
      rightSleeve: collapsedSleeve(x1, y0, Math.round((y0 + y1) / 3)),
      sleeveLength: 'short',
      coversForearm: false,
    },
    anchors,
  };
}
