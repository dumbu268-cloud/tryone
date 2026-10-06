// Dev harness for Phase 3: prepare a GarmentAsset from an ordinary clothing
// image, then wear it on a still person image through the existing perception +
// articulated engine + renderer. Publishes diagnostics on window.__prep.
import { BodyPerception } from '@/core/perception/BodyPerception';
import { ArticulatedEngine } from '@/core/engine/ArticulatedEngine';
import { Renderer, DEFAULT_RENDER_SETTINGS } from '@/core/render/Renderer';
import { ClassicGarmentPreparer } from '@/core/garment/prep/prepare';
import { HybridGarmentPreparer } from '@/core/garment/prep/mlPrepare';
import type { GarmentPrepDiagnostics, GarmentPreparer } from '@/core/types';

export interface PrepTestReport extends Partial<GarmentPrepDiagnostics> {
  ok: boolean;
  error?: string;
  fitVisible?: boolean;
}

declare global {
  interface Window {
    __prep?: PrepTestReport;
  }
}

export async function runPrepTest(
  garmentUrl: string,
  personUrl: string,
  canvas: HTMLCanvasElement,
  useMl = false,
): Promise<void> {
  try {
    const garmentImg = await loadImage(garmentUrl);
    const preparer: GarmentPreparer = useMl
      ? new HybridGarmentPreparer()
      : new ClassicGarmentPreparer();
    const { asset, diagnostics } = await preparer.prepare(garmentImg);

    const person = await loadImage(personUrl);
    const w = person.naturalWidth;
    const h = person.naturalHeight;

    const perception = new BodyPerception();
    await perception.init({ segmentationStride: 1 });
    const engine = new ArticulatedEngine();
    engine.prepare(asset);
    const renderer = new Renderer(canvas, { preserveDrawingBuffer: true });
    renderer.setGarment(asset);
    renderer.resize(w, h);

    let frame = perception.detectOn(person, w, h, 1000);
    for (let i = 1; i < 4; i++) frame = perception.detectOn(person, w, h, 1000 + i * 40);
    let fit = engine.fit(frame);
    for (let i = 1; i < 45; i++) fit = engine.fit({ ...frame, timestamp: frame.timestamp + i * 33 });

    renderer.render({
      source: person,
      sourceReady: true,
      fit,
      frame,
      settings: { ...DEFAULT_RENDER_SETTINGS },
    });

    window.__prep = { ...diagnostics, ok: true, fitVisible: fit.visible };
  } catch (err) {
    window.__prep = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}
