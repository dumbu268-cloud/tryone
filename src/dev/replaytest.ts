// Dev harness: replays a REAL recorded video of a person through the exact live
// pipeline (BodyPerception VIDEO mode → ArticulatedEngine → Renderer), frame by
// frame with real timestamps, so temporal behaviour (filters, landmark loss,
// sleeve hold/decay) is exercised on real human motion. A zoom/crop simulates
// camera distance; an optional dropout window simulates arm-landmark loss.
// Driven by ?replay=1 (see main.tsx) and e2e/replay.spec.ts.
import { BodyPerception } from '@/core/perception/BodyPerception';
import { ArticulatedEngine } from '@/core/engine/ArticulatedEngine';
import { Renderer, DEFAULT_RENDER_SETTINGS, buildRegionCanvas, needsSegmentation, type RenderSettings } from '@/core/render/Renderer';
import { buildGarmentMesh } from '@/core/garment/mesh';
import { loadGarment } from '@/core/garment/loader';
import { CATALOG } from '@/core/garment/catalog';
import { ClassicGarmentPreparer } from '@/core/garment/prep/prepare';
import { HybridGarmentPreparer } from '@/core/garment/prep/mlPrepare';
import type { FitResult, GarmentAsset, PoseFrame } from '@/core/types';

export interface ReplayConfig {
  video: string;
  /** 'builtin:<id>' | 'ml:<imageUrl>' | 'classic:<imageUrl>' */
  garment: string;
  /** >1 zooms in (person closer to camera); <1 not supported. */
  zoom?: number;
  /** Zoom centre in normalized video coords. */
  cx?: number;
  cy?: number;
  /** Simulated arm-landmark loss window [startSec, endSec]. */
  dropout?: [number, number];
  settings?: Partial<RenderSettings>;
}

export interface ReplayFrameStat {
  t: number;
  inferMs: number;
  fitMs: number;
  renderMs: number;
  valid: boolean;
  vis: { le: number; re: number; lw: number; rw: number };
  arms?: unknown;
}

const W = 640;
const H = 360;

class Replay {
  private video!: HTMLVideoElement;
  private work!: HTMLCanvasElement;
  private perception = new BodyPerception();
  private engine = new ArticulatedEngine();
  private renderer!: Renderer;
  private cfg!: ReplayConfig;
  private settings!: RenderSettings;
  private t = 0;
  stats: ReplayFrameStat[] = [];
  garmentInfo: unknown = null;
  regionUrl = '';

  async init(cfg: ReplayConfig, out: HTMLCanvasElement): Promise<void> {
    this.cfg = cfg;
    this.settings = { ...DEFAULT_RENDER_SETTINGS, ...cfg.settings };
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.src = cfg.video;
    await new Promise<void>((res, rej) => {
      this.video.onloadeddata = () => res();
      this.video.onerror = () => rej(new Error(`video load failed: ${cfg.video}`));
    });

    this.work = document.createElement('canvas');
    this.work.width = W;
    this.work.height = H;

    await this.perception.init({ segmentationStride: 2 });
    const garment = await this.loadGarmentSpec(cfg.garment);
    this.engine.prepare(garment);
    this.perception.setSegmentationEnabled(needsSegmentation(this.settings, garment.layout.coversForearm));
    this.renderer = new Renderer(out, { preserveDrawingBuffer: true });
    this.renderer.setGarment(garment);
    this.renderer.resize(W, H);
    const mesh = buildGarmentMesh(garment);
    const rc = buildRegionCanvas(mesh, garment.textureWidth, garment.textureHeight);
    const ctx = rc.getContext('2d')!;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(garment.image as CanvasImageSource, 0, 0, rc.width, rc.height);
    this.regionUrl = rc.toDataURL();
    (this.garmentInfo as Record<string, unknown>).rig = mesh.rig;
  }

  private async loadGarmentSpec(spec: string): Promise<GarmentAsset> {
    const [kind, ref] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
    if (kind === 'builtin') {
      const d = CATALOG.find((g) => g.id === ref);
      if (!d) throw new Error(`unknown builtin ${ref}`);
      this.garmentInfo = { kind, id: d.id };
      return loadGarment(d);
    }
    const img = await loadImage(ref);
    const prep = kind === 'ml' ? new HybridGarmentPreparer() : new ClassicGarmentPreparer();
    const res = await prep.prepare(img);
    this.garmentInfo = { kind, ...res.diagnostics };
    return res.asset;
  }

  private async seek(t: number): Promise<void> {
    if (Math.abs(this.video.currentTime - t) < 1e-3) return;
    await new Promise<void>((res) => {
      this.video.onseeked = () => res();
      this.video.currentTime = t;
    });
  }

  private drawWork(): void {
    const ctx = this.work.getContext('2d')!;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const zoom = Math.max(1, this.cfg.zoom ?? 1);
    const sw = vw / zoom;
    const sh = vh / zoom;
    const cx = (this.cfg.cx ?? 0.5) * vw;
    const cy = (this.cfg.cy ?? 0.5) * vh;
    const sx = Math.min(Math.max(0, cx - sw / 2), vw - sw);
    const sy = Math.min(Math.max(0, cy - sh / 2), vh - sh);
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, W, H);
  }

  /** Process frames from the current time up to `until` (s) at `fps`, then render. */
  async runTo(until: number, fps: number): Promise<void> {
    const dt = 1 / fps;
    while (this.t <= until + 1e-6) {
      await this.seek(Math.min(this.t, this.video.duration - 0.05));
      this.drawWork();
      const t0 = performance.now();
      let frame = this.perception.detectOn(this.work, W, H, Math.round(this.t * 1000) + 1);
      const t1 = performance.now();
      frame = this.applyDropout(frame);
      const fit: FitResult = this.engine.fit(frame);
      const t2 = performance.now();
      this.renderer.render({ source: this.work, sourceReady: true, fit, frame, settings: this.settings });
      const t3 = performance.now();
      const n = frame.normalized;
      this.stats.push({
        t: Number(this.t.toFixed(2)),
        inferMs: Math.round(t1 - t0),
        fitMs: Number((t2 - t1).toFixed(2)),
        renderMs: Number((t3 - t2).toFixed(2)),
        valid: frame.valid,
        vis: {
          le: round2(n[13]?.visibility),
          re: round2(n[14]?.visibility),
          lw: round2(n[15]?.visibility),
          rw: round2(n[16]?.visibility),
        },
        arms: (fit as { debug?: { arms?: unknown } }).debug?.arms,
      });
      this.t += dt;
    }
  }

  private applyDropout(frame: PoseFrame): PoseFrame {
    const d = this.cfg.dropout;
    if (!d || this.t < d[0] || this.t > d[1] || frame.normalized.length < 33) return frame;
    const normalized = frame.normalized.map((p, i) =>
      i >= 13 && i <= 16 ? { ...p, visibility: 0 } : p,
    );
    return { ...frame, normalized };
  }
}

function round2(x: number | undefined): number {
  return Math.round((x ?? 0) * 100) / 100;
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

declare global {
  interface Window {
    __replay?: { init: (c: ReplayConfig) => Promise<void>; runTo: (t: number, fps: number) => Promise<void>; stats: () => ReplayFrameStat[]; garment: () => unknown; region: () => string };
  }
}

export function installReplay(out: HTMLCanvasElement): void {
  const r = new Replay();
  window.__replay = {
    init: (c) => r.init(c, out),
    runTo: (t, fps) => r.runTo(t, fps),
    stats: () => r.stats,
    garment: () => r.garmentInfo,
    region: () => r.regionUrl,
  };
}
