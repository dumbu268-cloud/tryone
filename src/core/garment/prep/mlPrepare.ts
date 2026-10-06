import type { GarmentPrepResult, GarmentPreparer } from '@/core/types';
import { analyzeGarment } from './analyze';
import { ClassicGarmentPreparer } from './prepare';
import { ClothingSegmenter, type ClothingSegmenterOptions } from './ClothingSegmenter';
import {
  categoryMask,
  closeMask,
  erodeEdge,
  foregroundRatio,
  keepMainComponent,
  zeroBelow,
} from './maskOps';
import {
  MAX_DIM,
  assetFromAnalysis,
  buildCutout,
  diagnosticsFromAnalysis,
  rasterize,
  targetSize,
} from './shared';
import { PoseLandmark, SegClass } from '@/core/perception/landmarks';

export interface MlPrepareOptions extends ClothingSegmenterOptions {
  maxDim?: number;
  name?: string;
}

/**
 * ML garment preparer. Segments the "clothes" class (excludes skin/hair/face/
 * background) and uses pose to crop pants below the hips and seed the torso
 * component, then reuses the Phase 3 region analysis on the clean mask.
 */
export class MlGarmentPreparer implements GarmentPreparer {
  private readonly seg = new ClothingSegmenter();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly opts: MlPrepareOptions = {}) {}

  private ensureReady(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.seg.init(this.opts).then(() => undefined);
    return this.initPromise;
  }

  async prepare(source: CanvasImageSource): Promise<GarmentPrepResult> {
    await this.ensureReady();

    const { w, h } = targetSize(source, this.opts.maxDim ?? MAX_DIM);
    const { canvas, imageData } = rasterize(source, w, h);
    const { categories, pose } = this.seg.segment(canvas, w, h);

    let mask = categoryMask(categories, SegClass.CLOTHES);

    // Pose-guided cleanup: seed on the torso, drop pants below the hip line.
    let seed: { x: number; y: number } | undefined;
    if (pose) {
      const ls = pose[PoseLandmark.LEFT_SHOULDER];
      const rs = pose[PoseLandmark.RIGHT_SHOULDER];
      if (ls && rs && (ls.visibility > 0.3 || rs.visibility > 0.3)) {
        seed = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
      }
      const hipYs = [pose[PoseLandmark.LEFT_HIP], pose[PoseLandmark.RIGHT_HIP]]
        .filter((p): p is NonNullable<typeof p> => !!p && p.visibility > 0.3)
        .map((p) => p.y);
      if (hipYs.length) {
        const hipY = Math.max(...hipYs);
        const torsoH = seed ? hipY - seed.y : h * 0.4;
        mask = zeroBelow(mask, w, h, hipY + Math.max(8, torsoH * 0.12));
      }
    }

    mask = keepMainComponent(mask, w, h, seed);
    mask = closeMask(mask, w, h, 2);
    mask = erodeEdge(mask, w, h, 1);

    const fg = foregroundRatio(mask);
    const analysis = analyzeGarment(mask, w, h, fg);
    const image = buildCutout(imageData, mask, w, h);
    const asset = assetFromAnalysis(analysis, image, w, h, this.opts.name);

    return { asset, diagnostics: diagnosticsFromAnalysis(analysis, { method: 'ml' }) };
  }

  dispose(): void {
    this.seg.dispose();
  }
}

/**
 * Tries the ML preparer first; falls back to the classical flood-fill preparer
 * if the model is unavailable or no garment is detected. This is the default
 * preparer used by the app.
 */
export class HybridGarmentPreparer implements GarmentPreparer {
  constructor(
    private readonly ml: MlGarmentPreparer = new MlGarmentPreparer(),
    private readonly classic: ClassicGarmentPreparer = new ClassicGarmentPreparer(),
  ) {}

  async prepare(source: CanvasImageSource): Promise<GarmentPrepResult> {
    try {
      const result = await this.ml.prepare(source);
      if (result.diagnostics.supported) return result;
    } catch (err) {
      console.warn('[prep] ML preparer failed; falling back to classic.', err);
    }
    return this.classic.prepare(source);
  }
}
