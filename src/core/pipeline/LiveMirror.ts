import { Camera, CameraError, type CameraOptions } from '@/core/camera/Camera';
import { PerceptionWorkerClient, type WorkerResult } from '@/core/perception/PerceptionWorkerClient';
import type { PerceptionOptions } from '@/core/perception/BodyPerception';
import { ArticulatedEngine, type ArticulatedOptions } from '@/core/engine/ArticulatedEngine';
import {
  Renderer,
  DEFAULT_RENDER_SETTINGS,
  needsSegmentation,
  type RenderSettings,
} from '@/core/render/Renderer';
import { Metrics, type MetricsSnapshot } from '@/core/perf/Metrics';
import { loadGarment } from '@/core/garment/loader';
import { DEFAULT_GARMENT } from '@/core/garment/catalog';
import { computeFramingHint } from './framing';
import type { FitResult, GarmentAsset, GarmentDescriptor, PoseFrame } from '@/core/types';

export type MirrorStatus = 'idle' | 'initializing' | 'running' | 'stopped' | 'error';

export interface LiveMirrorCallbacks {
  onStatus?: (status: MirrorStatus, detail?: string) => void;
  onMetrics?: (snapshot: MetricsSnapshot) => void;
  onError?: (message: string, kind?: string) => void;
  onHint?: (hint: string | null) => void;
}

export interface LiveMirrorConfig {
  cameraWidth?: number;
  cameraHeight?: number;
  cameraFrameRate?: number;
  /** Longest side of the frame sent to MediaPipe. Preview remains full-resolution. */
  inferenceMaxSide?: number;
  perception?: PerceptionOptions;
  engine?: ArticulatedOptions;
  render?: Partial<RenderSettings>;
  metricsHz?: number;
}

const hasRVFC = (video: HTMLVideoElement): boolean =>
  typeof video.requestVideoFrameCallback === 'function';

const EMPTY_FIT: FitResult = {
  quad: {
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
    bl: { x: 0, y: 0 },
  },
  opacity: 0,
  visible: false,
};

/**
 * Worker-decoupled live loop:
 *
 * camera rVFC ─┬─ render newest camera frame + latest fit (never waits for ML)
 *              └─ dispatch a resized ImageBitmap when the worker is free
 * worker result ── fit geometry, replace latest PoseFrame/FitResult
 *
 * At most one inference is in flight. Camera frames that arrive while the worker
 * is busy are dropped instead of queued, so latency never builds up.
 */
export class LiveMirror {
  private readonly canvas: HTMLCanvasElement;
  private readonly config: LiveMirrorConfig;
  private readonly cb: LiveMirrorCallbacks;
  private readonly camera = new Camera();
  private readonly perception = new PerceptionWorkerClient();
  private readonly engine: ArticulatedEngine;
  private readonly metrics = new Metrics();
  private renderer: Renderer | null = null;

  private garmentDesc: GarmentDescriptor = DEFAULT_GARMENT;
  private pendingAsset: GarmentAsset | null = null;
  private coversForearm = true;
  private latestFrame: PoseFrame | null = null;
  private latestFit: FitResult = EMPTY_FIT;
  private settings: RenderSettings;
  private status: MirrorStatus = 'idle';
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private lastFallbackMediaTime = -1;
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
    this.perception.onResult((result) => this.onPerceptionResult(result));
  }

  getStatus(): MirrorStatus { return this.status; }
  getRenderSettings(): RenderSettings { return { ...this.settings }; }

  setRenderSettings(partial: Partial<RenderSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.syncSegmentation();
  }

  getGarmentId(): string { return this.pendingAsset?.id ?? this.garmentDesc.id; }

  async setGarment(descriptor: GarmentDescriptor): Promise<void> {
    this.pendingAsset = null;
    this.garmentDesc = descriptor;
    if (this.renderer) this.applyGarment(await loadGarment(descriptor));
  }

  setGarmentAsset(asset: GarmentAsset): void {
    this.pendingAsset = asset;
    if (this.renderer) this.applyGarment(asset);
  }

  private applyGarment(garment: GarmentAsset): void {
    this.engine.prepare(garment);
    this.renderer?.setGarment(garment);
    this.coversForearm = garment.layout.coversForearm;
    this.syncSegmentation();
  }

  private syncSegmentation(): void {
    this.perception.setSegmentationEnabled(needsSegmentation(this.settings, this.coversForearm));
  }

  async start(): Promise<void> {
    if (this.running || this.status === 'initializing') return;
    this.setStatus('initializing', 'Starting camera…');
    try {
      this.renderer = new Renderer(this.canvas);
      const cameraOpts: CameraOptions = {
        facingMode: 'user',
        width: this.config.cameraWidth ?? 960,
        height: this.config.cameraHeight ?? 540,
        frameRate: this.config.cameraFrameRate ?? 30,
        onDisconnect: (err) => this.handleDisconnect(err),
      };
      await this.camera.start(cameraOpts);
      this.metrics.setCapture(this.camera.settings);

      this.setStatus('initializing', 'Loading perception worker…');
      const { delegate } = await this.perception.init(this.config.perception);
      this.metrics.setDelegate(`${delegate} worker`);

      this.setStatus('initializing', 'Preparing garment…');
      this.applyGarment(this.pendingAsset ?? (await loadGarment(this.garmentDesc)));

      const { width, height } = this.camera.dimensions;
      this.renderer.resize(width || 960, height || 540);
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
    if (this.rvfcHandle !== null && hasRVFC(video)) video.cancelVideoFrameCallback(this.rvfcHandle);
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = null;
    this.rafHandle = null;
    this.camera.stop();
    this.perception.reset();
    this.metrics.reset();
    this.latestFrame = null;
    this.latestFit = EMPTY_FIT;
    this.lastFallbackMediaTime = -1;
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
      const onFrame: VideoFrameRequestCallback = (now, metadata) => {
        if (!this.running) return;
        // Register first: inference is asynchronous and never blocks callback delivery.
        this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
        this.onCameraFrame(now, metadata.mediaTime * 1000);
      };
      this.rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const onRaf = (now: number) => {
        if (!this.running) return;
        this.rafHandle = requestAnimationFrame(onRaf);
        const mediaTime = video.currentTime * 1000;
        // Do not infer repeatedly on the same camera frame.
        if (mediaTime !== this.lastFallbackMediaTime) {
          this.lastFallbackMediaTime = mediaTime;
          this.onCameraFrame(now, mediaTime);
        }
      };
      this.rafHandle = requestAnimationFrame(onRaf);
    }
  }

  private onCameraFrame(now: number, timestampMs: number): void {
    const renderer = this.renderer;
    if (!renderer) return;
    this.metrics.markCameraFrame(now);

    const { width, height } = this.camera.dimensions;
    if (width > 0 && height > 0) renderer.resize(width, height);

    this.perception.dispatch(
      this.camera.video,
      timestampMs,
      width,
      height,
      this.config.inferenceMaxSide ?? 384,
    );

    const renderStarted = performance.now();
    renderer.render({
      source: this.camera.video,
      sourceReady: this.camera.video.readyState >= 2,
      fit: this.latestFit,
      frame: this.latestFrame ?? emptyFrame(timestampMs, width, height),
      settings: this.settings,
    });
    this.metrics.markRender(performance.now() - renderStarted);
    this.emitMetrics(now);
  }

  private onPerceptionResult({ frame, inferenceMs }: WorkerResult): void {
    if (!this.running) return;
    this.metrics.markInference(inferenceMs, performance.now());
    this.metrics.markDropped(this.perception.consumeDropped());

    const fitStarted = performance.now();
    this.latestFit = this.engine.fit(frame);
    this.metrics.markFit(performance.now() - fitStarted);
    this.latestFrame = frame;
    this.maybeEmitHint(computeFramingHint(frame));
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

function emptyFrame(timestamp: number, width: number, height: number): PoseFrame {
  return { timestamp, width, height, valid: false, confidence: 0, image: [], normalized: [] };
}
