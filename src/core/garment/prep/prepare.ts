import type { GarmentPrepResult, GarmentPreparer, RgbaImage } from '@/core/types';
import { removeBackground, type BackgroundOptions } from './background';
import { analyzeGarment, type AnalyzeOptions } from './analyze';
import {
  MAX_DIM,
  assetFromAnalysis,
  buildCutout,
  diagnosticsFromAnalysis,
  rasterize,
  targetSize,
} from './shared';

export interface PrepareOptions {
  /** Longest edge the image is scaled to before processing (perf + stable analysis). */
  maxDim?: number;
  background?: BackgroundOptions;
  analyze?: AnalyzeOptions;
  name?: string;
}

/**
 * Classical, deterministic garment preparer. Scales the image, removes the
 * background (border flood-fill), analyzes the silhouette, and emits a
 * GarmentAsset. Best for clean flat-lay images; used as the fallback when the
 * ML preparer is unavailable or finds no garment.
 */
export class ClassicGarmentPreparer implements GarmentPreparer {
  private readonly opts: PrepareOptions;

  constructor(opts: PrepareOptions = {}) {
    this.opts = opts;
  }

  async prepare(source: CanvasImageSource): Promise<GarmentPrepResult> {
    const { w, h } = targetSize(source, this.opts.maxDim ?? MAX_DIM);
    const { imageData } = rasterize(source, w, h);

    const rgba: RgbaImage = { data: imageData.data, width: w, height: h };
    const bg = removeBackground(rgba, this.opts.background);
    const analysis = analyzeGarment(bg.alpha, w, h, bg.foregroundRatio, this.opts.analyze);

    const image = buildCutout(imageData, bg.alpha, w, h);
    const asset = assetFromAnalysis(analysis, image, w, h, this.opts.name);

    return { asset, diagnostics: diagnosticsFromAnalysis(analysis, { method: 'classic' }) };
  }
}
