import { Camera, CameraError, type CameraOptions } from '@/core/camera/Camera';
import { BodyPerception, type PerceptionOptions } from '@/core/perception/BodyPerception';
import { ArticulatedEngine, type ArticulatedOptions } from '@/core/engine/ArticulatedEngine';
import { Renderer, DEFAULT_RENDER_SETTINGS, type RenderSettings } from '@/core/render/Renderer';
import { Metrics, type MetricsSnapshot } from '@/core/perf/Metrics';
import { loadGarment } from '@/core/garment/loader';
import { DEFAULT_GARMENT } from '@/core/garment/catalog';
import { computeFramingHint } from './framing';
import type { GarmentAsset, GarmentDescriptor } from '@/core/types';

export type MirrorStatus = 'idle' | 'initializing' | 'running' | 'stopped' | 'error';

export interface LiveMirrorCallbacks {
  onStatus?: (status: MirrorStatus, detail?: string) => void;
  onMetrics?: (snapshot: MetricsSnapshot) => void;
  onError?: (message: string, kind?: string) => void;
  /** Framing coach hint (null = looks good). Emitted only when it changes. */
  onHint?: (hint: string | null) => void;
}

export interface LiveMirrorConfig {
  cameraWidth?: number;
  cameraHeight?: number;
  perception?: PerceptionOptions;
  engine?: ArticulatedOptions;
  render?: Partial<RenderSettings>;
  /** How often (Hz) to emit metrics to the UI. */
  metricsHz?: number;
}

const hasRVFC = (video: HTMLVideoElement): boolean =>
  typeof (video as Partial<HTMLVideoElement>).requestVideoFrameCallback === 'function';

/**
 * Orchestrates the live loop: Camera -> BodyPerception -> ArticulatedEngine ->
 * Renderer, with performance metrics. Runs entirely outside React; the UI only
 * subscribes to low-frequency status + throttled metrics callbacks.
 */
export class LiveMirror {
  private readonly canvas: HTMLCanvasElement;
  private readonly config: LiveMirrorConfig;
  private readonly cb: LiveMirrorCallbacks;

  private readonly camera: Camera;
  private readonly perception = new BodyPerception();
  private readonly engine: ArticulatedEngine;
  private renderer: Renderer | null = null;
  private readonly metrics = new Metrics();
  private garmentDesc: GarmentDescriptor = DEFAULT_GARMENT;
  private pendingAsset: GarmentAsset | null = null;

  private settings: RenderSettings;
  private status: MirrorStatus = 'idle';
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private lastMetricsEmit = 0;
  private readonly metricsInterval: number;
  private lastHint: string | null = null;
  private hintPrimed = false;

  constructor(canvas: HTMLCanvasElement, config: LiveMirrorConfig = {}, cb: LiveMirrorCallbacks = {}) {
    this.canvas = canvas;
    this.config = config;
    this.cb = cb;
    this.engine = new ArticulatedEngine(config.engine);
    this.settings = { ...DEFAULT_RENDER_SETTINGS, ...config.render };
    this.metricsInterval = 1000 / (config.metricsHz ?? 3);
    this.camera = new Camera();
  }

  getStatus(): MirrorStatus {
    return this.status;
  }

  getRenderSettings(): RenderSettings {
    return { ...this.settings };
  }

  setRenderSettings(partial: Partial<RenderSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  getGarmentId(): string {
    return this.pendingAsset?.id ?? this.garmentDesc.id;
  }

  /** Switch to a built-in garment descriptor (loaded from its texture URL). */
  async setGarment(descriptor: GarmentDescriptor): Promise<void> {
    this.pendingAsset = null;
    this.garmentDesc = descriptor;
    if (this.renderer) {
      const garment = await loadGarment(descriptor);
      this.applyGarment(garment);
    }
  }

  /** Wear an already-prepared GarmentAsset (e.g. from the garment preparer). */
  setGarmentAsset(asset: GarmentAsset): void {
    this.pendingAsset = asset;
    if (this.renderer) this.applyGarment(asset);
  }

  private applyGarment(garment: GarmentAsset): void {
    this.engine.prepare(garment);
    this.renderer?.setGarment(garment);
  }

  async start(): Promise<void> {
    if (this.running || this.status === 'initializing') return;
    this.setStatus('initializing', 'Starting camera…');
    try {
      // Renderer needs a WebGL2 context first (fail fast if unsupported).
      this.renderer = new Renderer(this.canvas);

      const cameraOpts: CameraOptions = {
        facingMode: 'user',
        width: this.config.cameraWidth ?? 1280,
        height: this.config.cameraHeight ?? 720,
        onDisconnect: (err) => this.handleDisconnect(err),
      };
      await this.camera.start(cameraOpts);

      this.setStatus('initializing', 'Loading perception models…');
      const { delegate } = await this.perception.init(this.config.perception);
      this.metrics.setDelegate(delegate);

      this.setStatus('initializing', 'Preparing garment…');
      const garment = this.pendingAsset ?? (await loadGarment(this.garmentDesc));
      this.applyGarment(garment);

      const { width, height } = this.camera.dimensions;
      this.renderer.resize(width || 1280, height || 720);

      this.running = true;
      this.setStatus('running');
      this.loop();
    } catch (err) {
      this.fail(err);
    }
  }

  stop(): void {
    this.running = false;
    const video = this.camera.video;
    if (this.rvfcHandle !== null && hasRVFC(video)) {
      video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.camera.stop();
    this.perception.reset();
    this.metrics.reset();
    this.lastHint = null;
    this.hintPrimed = false;
    this.cb.onHint?.(null);
    if (this.status !== 'error') this.setStatus('stopped');
  }

  dispose(): void {
    this.stop();
    this.perception.close();
    this.engine.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }

  private loop(): void {
    const video = this.camera.video;

    if (hasRVFC(video)) {
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        if (!this.running) return;
        this.processFrame(metadata.mediaTime * 1000);
        this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
      };
      this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const onRaf = () => {
        if (!this.running) return;
        this.processFrame(performance.now());
        this.rafHandle = requestAnimationFrame(onRaf);
      };
      this.rafHandle = requestAnimationFrame(onRaf);
    }
  }

  private processFrame(timestampMs: number): void {
    if (!this.renderer) return;
    const video = this.camera.video;
    const now = performance.now();
    this.metrics.beginFrame(now);

    try {
      // Keep the backing resolution matched to the (possibly late-arriving) video size.
      const { width, height } = this.camera.dimensions;
      if (width > 0 && height > 0) {
        this.renderer.resize(width, height);
      }

      const t0 = performance.now();
      const frame = this.perception.detect(video, timestampMs);
      const t1 = performance.now();
      this.metrics.markInference(t1 - t0);

      const fit = this.engine.fit(frame);

      const sourceReady = video.readyState >= 2 && video.videoWidth > 0;
      const t2 = performance.now();
      this.renderer.render({ source: video, sourceReady, fit, frame, settings: this.settings });
      const t3 = performance.now();
      this.metrics.markRender(t3 - t2);

      this.maybeEmitHint(computeFramingHint(frame));
    } catch (err) {
      // A transient per-frame error shouldn't kill the loop; log and continue.
      console.error('[live-mirror] frame error', err);
    }

    this.emitMetrics(now);
  }

  private emitMetrics(now: number): void {
    if (now - this.lastMetricsEmit >= this.metricsInterval) {
      this.lastMetricsEmit = now;
      this.cb.onMetrics?.(this.metrics.snapshot());
    }
  }

  private maybeEmitHint(hint: string | null): void {
    if (hint !== this.lastHint || !this.hintPrimed) {
      this.lastHint = hint;
      this.hintPrimed = true;
      this.cb.onHint?.(hint);
    }
  }

  private handleDisconnect(err: CameraError): void {
    this.running = false;
    this.setStatus('error', err.message);
    this.cb.onError?.(err.message, err.kind);
  }

  private fail(err: unknown): void {
    this.running = false;
    const kind = err instanceof CameraError ? err.kind : undefined;
    const message = err instanceof Error ? err.message : 'Failed to start the live mirror.';
    this.setStatus('error', message);
    this.cb.onError?.(message, kind);
  }

  private setStatus(status: MirrorStatus, detail?: string): void {
    this.status = status;
    this.cb.onStatus?.(status, detail);
  }
}
