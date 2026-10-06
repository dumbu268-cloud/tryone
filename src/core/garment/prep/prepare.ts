import type {
  GarmentAsset,
  GarmentPrepResult,
  GarmentPreparer,
  RgbaImage,
} from '@/core/types';
import { removeBackground, type BackgroundOptions } from './background';
import { analyzeGarment, type AnalyzeOptions, type GarmentAnalysis } from './analyze';

export interface PrepareOptions {
  /** Longest edge the image is scaled to before processing (perf + stable analysis). */
  maxDim?: number;
  background?: BackgroundOptions;
  analyze?: AnalyzeOptions;
  name?: string;
}

const MAX_DIM = 512;

/**
 * Classical, deterministic garment preparer. Scales the image, removes the
 * background, analyzes the silhouette, and emits a GarmentAsset (cutout texture
 * + torso/sleeve layout + anchors) that drops straight into the Phase 2 engine.
 */
export class ClassicGarmentPreparer implements GarmentPreparer {
  private readonly opts: PrepareOptions;

  constructor(opts: PrepareOptions = {}) {
    this.opts = opts;
  }

  async prepare(source: CanvasImageSource): Promise<GarmentPrepResult> {
    const maxDim = this.opts.maxDim ?? MAX_DIM;
    const { w, h } = targetSize(source, maxDim);

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w;
    srcCanvas.height = h;
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable for garment preparation.');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const rgba: RgbaImage = { data: imageData.data, width: w, height: h };
    const bg = removeBackground(rgba, this.opts.background);
    const analysis = analyzeGarment(bg.alpha, w, h, bg.foregroundRatio, this.opts.analyze);

    const image = buildCutout(imageData, bg.alpha, w, h);
    const asset = this.toAsset(analysis, image, w, h);

    return {
      asset,
      diagnostics: {
        supported: analysis.supported,
        ...(analysis.reason ? { reason: analysis.reason } : {}),
        detectedType: analysis.type,
        sleeveLength: analysis.sleeveLength,
        bbox: analysis.bbox,
        foregroundRatio: Number(analysis.foregroundRatio.toFixed(3)),
      },
    };
  }

  private toAsset(
    analysis: GarmentAnalysis,
    image: TexImageSource,
    w: number,
    h: number,
  ): GarmentAsset {
    const label =
      analysis.sleeveLength === 'long'
        ? 'Long-Sleeve (auto)'
        : analysis.sleeveLength === 'none'
          ? 'Sleeveless (auto)'
          : 'T-Shirt (auto)';
    return {
      id: `prepared-${Date.now()}`,
      name: this.opts.name ?? label,
      type: analysis.type,
      textureWidth: w,
      textureHeight: h,
      image,
      anchors: analysis.anchors,
      layout: analysis.layout,
      zOrder: 10,
    };
  }
}

function targetSize(source: CanvasImageSource, maxDim: number): { w: number; h: number } {
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

function buildCutout(src: ImageData, alpha: Uint8Array, w: number, h: number): HTMLCanvasElement {
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
