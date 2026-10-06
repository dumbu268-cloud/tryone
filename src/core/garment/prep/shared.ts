import type { GarmentAsset, GarmentPrepDiagnostics } from '@/core/types';
import type { GarmentAnalysis } from './analyze';

export const MAX_DIM = 512;

export function targetSize(source: CanvasImageSource, maxDim: number): { w: number; h: number } {
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

function sourceWidth(s: CanvasImageSource): number {
  if ('naturalWidth' in s && s.naturalWidth) return s.naturalWidth;
  if ('videoWidth' in s && s.videoWidth) return s.videoWidth;
  return (s as { width: number }).width;
}

function sourceHeight(s: CanvasImageSource): number {
  if ('naturalHeight' in s && s.naturalHeight) return s.naturalHeight;
  if ('videoHeight' in s && s.videoHeight) return s.videoHeight;
  return (s as { height: number }).height;
}

/** Draw a source image to an offscreen canvas at (w,h) and read back its pixels. */
export function rasterize(
  source: CanvasImageSource,
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; imageData: ImageData } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable for garment preparation.');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return { canvas, imageData: ctx.getImageData(0, 0, w, h) };
}

/** Compose an RGBA cutout canvas from source pixels + a 0/255 alpha mask. */
export function buildCutout(
  src: ImageData,
  alpha: Uint8Array,
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    out.data[j] = src.data[j]!;
    out.data[j + 1] = src.data[j + 1]!;
    out.data[j + 2] = src.data[j + 2]!;
    out.data[j + 3] = alpha[i]!;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function label(analysis: GarmentAnalysis): string {
  return analysis.sleeveLength === 'long'
    ? 'Long-Sleeve (auto)'
    : analysis.sleeveLength === 'none'
      ? 'Sleeveless (auto)'
      : 'T-Shirt (auto)';
}

export function assetFromAnalysis(
  analysis: GarmentAnalysis,
  image: TexImageSource,
  w: number,
  h: number,
  name?: string,
): GarmentAsset {
  return {
    id: `prepared-${Date.now()}`,
    name: name ?? label(analysis),
    type: analysis.type,
    textureWidth: w,
    textureHeight: h,
    image,
    anchors: analysis.anchors,
    layout: analysis.layout,
    zOrder: 10,
  };
}

export function diagnosticsFromAnalysis(
  analysis: GarmentAnalysis,
  extra?: Partial<GarmentPrepDiagnostics>,
): GarmentPrepDiagnostics {
  return {
    supported: analysis.supported,
    ...(analysis.reason ? { reason: analysis.reason } : {}),
    detectedType: analysis.type,
    sleeveLength: analysis.sleeveLength,
    bbox: analysis.bbox,
    foregroundRatio: Number(analysis.foregroundRatio.toFixed(3)),
    ...extra,
  };
}
