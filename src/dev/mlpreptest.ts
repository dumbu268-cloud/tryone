// Dev harness for Phase 3.5: run the ML garment preparer on a real image and
// draw the extracted cutout over a checkerboard so the isolation (person/
// background/skin/pants removal) is visible. Publishes diagnostics on
// window.__mlprep. Driven by ?mlprep=1&img=...
import { MlGarmentPreparer } from '@/core/garment/prep/mlPrepare';
import type { GarmentPrepDiagnostics } from '@/core/types';

export interface MlPrepReport extends Partial<GarmentPrepDiagnostics> {
  ok: boolean;
  error?: string;
  ms?: number;
  textureWidth?: number;
  textureHeight?: number;
}

declare global {
  interface Window {
    __mlprep?: MlPrepReport;
  }
}

export async function runMlPrepTest(imageUrl: string, canvas: HTMLCanvasElement): Promise<void> {
  try {
    const img = await loadImage(imageUrl);
    const prep = new MlGarmentPreparer();

    const t0 = performance.now();
    const result = await prep.prepare(img);
    const ms = Math.round(performance.now() - t0);

    const w = result.asset.textureWidth;
    const h = result.asset.textureHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    drawChecker(ctx, w, h);
    ctx.drawImage(result.asset.image as CanvasImageSource, 0, 0, w, h);
    const rig = result.asset.layout.rig;
    const dot = (p: { x: number; y: number }, c: string, r = 4) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const p of prep.lastPose ?? []) dot(p, p.visibility > 0.5 ? "#fff" : "#888", 3);
    if (rig) {
      for (const k of ["neckL", "neckR", "shoulderL", "shoulderR", "armpitL", "armpitR", "hemL", "hemR"] as const) dot(rig[k], "#0ff", 4);
      for (const s of [rig.sleeveL, rig.sleeveR]) {
        if (!s) continue;
        ctx.strokeStyle = "#f00";
        ctx.lineWidth = 3;
        ctx.beginPath();
        s.axis.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
    }

    window.__mlprep = {
      ok: true,
      ms,
      textureWidth: w,
      textureHeight: h,
      ...result.diagnostics,
      rig: result.asset.layout.rig,
      pose: prep.lastPose?.map((p) => [Math.round(p.x), Math.round(p.y), Number(p.visibility.toFixed(2))]),
    } as MlPrepReport;
  } catch (err) {
    window.__mlprep = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const s = 16;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      ctx.fillStyle = ((x / s + y / s) & 1) === 0 ? '#d048d0' : '#ffffff';
      ctx.fillRect(x, y, s, s);
    }
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
