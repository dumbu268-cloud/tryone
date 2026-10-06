// Dev-only visual harness. Runs the full pipeline on a still image and composites
// the garment onto it with the real WebGL renderer, so the output can be
// screenshotted and inspected. Driven by `?visualtest=1` (see main.tsx).
import { BodyPerception } from '@/core/perception/BodyPerception';
import { ArticulatedEngine } from '@/core/engine/ArticulatedEngine';
import { Renderer, DEFAULT_RENDER_SETTINGS } from '@/core/render/Renderer';
import { loadGarment } from '@/core/garment/loader';
import { CATALOG, DEFAULT_GARMENT } from '@/core/garment/catalog';

declare global {
  interface Window {
    __visualdone?: boolean;
    __visualerror?: string;
  }
}

export async function runVisualTest(
  imageUrl: string,
  canvas: HTMLCanvasElement,
  garmentId?: string,
  cropFrac = 1,
): Promise<void> {
  try {
    const img = await loadImage(imageUrl);
    const w = img.naturalWidth;

    // Optionally crop to the top portion to simulate seated / upper-body framing
    // (hips out of frame).
    let source: TexImageSource = img;
    let sh = img.naturalHeight;
    if (cropFrac < 1) {
      const cc = document.createElement('canvas');
      cc.width = w;
      cc.height = Math.round(img.naturalHeight * cropFrac);
      cc.getContext('2d')!.drawImage(img, 0, 0);
      source = cc;
      sh = cc.height;
    }

    const perception = new BodyPerception();
    await perception.init({ segmentationStride: 1 });

    const engine = new ArticulatedEngine();
    const descriptor = CATALOG.find((g) => g.id === garmentId) ?? DEFAULT_GARMENT;
    const garment = await loadGarment(descriptor);
    engine.prepare(garment);

    const renderer = new Renderer(canvas, { preserveDrawingBuffer: true });
    renderer.setGarment(garment);
    renderer.resize(w, sh);

    let frame = perception.detectOn(source, w, sh, 1000);
    for (let i = 1; i < 4; i++) frame = perception.detectOn(source, w, sh, 1000 + i * 40);

    let fit = engine.fit(frame);
    for (let i = 1; i < 45; i++) fit = engine.fit({ ...frame, timestamp: frame.timestamp + i * 33 });

    renderer.render({
      source,
      sourceReady: true,
      fit,
      frame,
      settings: { ...DEFAULT_RENDER_SETTINGS },
    });

    window.__visualdone = true;
  } catch (err) {
    window.__visualerror = err instanceof Error ? err.message : String(err);
    window.__visualdone = true;
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
