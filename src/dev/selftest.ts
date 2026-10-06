// Dev-only self-test. Runs the real perception -> PoseFrame -> fitting pipeline
// against a static image (no camera needed) and publishes the result on
// `window.__selftest`. Driven by the `?selftest=1` URL param (see main.tsx) and
// consumed by the Playwright e2e test. Not shipped in the normal app flow.
import { BodyPerception } from '@/core/perception/BodyPerception';
import { MeshWarpEngine } from '@/core/engine/MeshWarpEngine';
import { loadGarment } from '@/core/garment/loader';
import { DEFAULT_GARMENT } from '@/core/garment/catalog';
import type { FitResult, PoseFrame } from '@/core/types';

export interface SelfTestResult {
  ok: boolean;
  stage: string;
  delegate?: string;
  valid?: boolean;
  confidence?: number;
  landmarkCount?: number;
  hasSegmentation?: boolean;
  fitVisible?: boolean;
  fitOpacity?: number;
  quad?: FitResult['quad'];
  error?: string;
}

declare global {
  interface Window {
    __selftest?: SelfTestResult;
  }
}

export async function runSelfTest(imageUrl: string): Promise<SelfTestResult> {
  const result: SelfTestResult = { ok: false, stage: 'start' };
  try {
    result.stage = 'load-image';
    const img = await loadImage(imageUrl);

    result.stage = 'init-perception';
    const perception = new BodyPerception();
    const { delegate } = await perception.init({ segmentationStride: 1 });
    result.delegate = delegate;

    result.stage = 'detect';
    let frame: PoseFrame | null = null;
    // A few iterations: VIDEO running mode warms up its tracker.
    for (let i = 0; i < 4; i++) {
      frame = perception.detectOn(img, img.naturalWidth, img.naturalHeight, 1000 + i * 40);
    }
    if (!frame) throw new Error('no frame produced');
    result.valid = frame.valid;
    result.confidence = frame.confidence;
    result.landmarkCount = frame.image.length;
    result.hasSegmentation = !!frame.segmentation;

    result.stage = 'fit';
    const engine = new MeshWarpEngine();
    const garment = await loadGarment(DEFAULT_GARMENT);
    engine.prepare(garment);
    let fit: FitResult | null = null;
    for (let i = 0; i < 40; i++) fit = engine.fit(frame);
    if (!fit) throw new Error('no fit produced');
    result.fitVisible = fit.visible;
    result.fitOpacity = fit.opacity;
    result.quad = fit.quad;

    result.stage = 'done';
    result.ok = frame.valid && fit.visible;
    perception.close();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  window.__selftest = result;
  return result;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load test image: ${url}`));
    img.src = url;
  });
}
