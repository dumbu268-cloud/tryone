// Pure binary-mask operations for ML garment extraction. Deterministic and
// DOM-free so they are unit-testable in Node. A mask is a Uint8Array of 0/255,
// one byte per pixel, row-major (length = width*height).

/** Build a 0/255 mask selecting pixels whose segmentation category == `klass`. */
export function categoryMask(categories: Uint8Array, klass: number): Uint8Array {
  const out = new Uint8Array(categories.length);
  for (let i = 0; i < categories.length; i++) out[i] = categories[i] === klass ? 255 : 0;
  return out;
}

/** Build a mask selecting pixels whose category is in `classes`. */
export function categoryMaskAny(categories: Uint8Array, classes: number[]): Uint8Array {
  const set = new Set(classes);
  const out = new Uint8Array(categories.length);
  for (let i = 0; i < categories.length; i++) out[i] = set.has(categories[i]!) ? 255 : 0;
  return out;
}

/** Zero out everything at or below row `y` (used to drop pants below the hips). */
export function zeroBelow(mask: Uint8Array, w: number, h: number, y: number): Uint8Array {
  const out = mask.slice();
  const start = Math.max(0, Math.min(h, Math.floor(y)));
  out.fill(0, start * w, h * w);
  return out;
}

interface Components {
  labels: Int32Array;
  sizes: number[];
  count: number;
}

/** 4-connected connected-components labelling of a 0/255 mask. */
function label(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i] !== -1) continue;
    const id = count++;
    let size = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) {
        labels[p - 1] = id;
        stack.push(p - 1);
      }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) {
        labels[p + 1] = id;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) {
        labels[p - w] = id;
        stack.push(p - w);
      }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) {
        labels[p + w] = id;
        stack.push(p + w);
      }
    }
    sizes[id] = size;
  }
  return { labels, sizes, count };
}

/** Keep only the single connected component (optionally the one containing a seed). */
export function keepMainComponent(
  mask: Uint8Array,
  w: number,
  h: number,
  seed?: { x: number; y: number },
): Uint8Array {
  const { labels, sizes, count } = label(mask, w, h);
  if (count === 0) return new Uint8Array(mask.length);

  let target = -1;
  if (seed) {
    const sx = Math.max(0, Math.min(w - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(h - 1, Math.round(seed.y)));
    target = labels[sy * w + sx]!;
  }
  if (target < 0) {
    // Largest component.
    let best = -1;
    for (let id = 0; id < count; id++) {
      if ((sizes[id] ?? 0) > best) {
        best = sizes[id]!;
        target = id;
      }
    }
  }

  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = labels[i] === target ? 255 : 0;
  return out;
}

function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < w - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - w]) ||
        (y < h - 1 && mask[i + w])
      ) {
        out[i] = 255;
      }
    }
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const keep =
        (x === 0 || !!mask[i - 1]) &&
        (x === w - 1 || !!mask[i + 1]) &&
        (y === 0 || !!mask[i - w]) &&
        (y === h - 1 || !!mask[i + w]);
      out[i] = keep ? 255 : 0;
    }
  }
  return out;
}

/** Morphological close (dilate then erode) — fills small holes (buttons, logos, text). */
export function closeMask(mask: Uint8Array, w: number, h: number, iterations = 2): Uint8Array {
  let m = mask;
  for (let i = 0; i < iterations; i++) m = dilate(m, w, h);
  for (let i = 0; i < iterations; i++) m = erode(m, w, h);
  return m;
}

/** Erode the garment edge by `n` px to remove segmentation fringe. */
export function erodeEdge(mask: Uint8Array, w: number, h: number, n = 1): Uint8Array {
  let m = mask;
  for (let i = 0; i < n; i++) m = erode(m, w, h);
  return m;
}

export function foregroundRatio(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c / mask.length;
}

/**
 * Soft-edge the cutout: separable box blur of a 0/255 mask → 0..255 alpha.
 * Interior stays opaque; only the boundary gets an anti-aliased ramp.
 */
export function featherMask(mask: Uint8Array, w: number, h: number, radius = 1): Uint8Array {
  if (radius <= 0) return mask.slice();
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  const n = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += mask[y * w + Math.min(w - 1, Math.max(0, x + k))]!;
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!;
      out[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}
