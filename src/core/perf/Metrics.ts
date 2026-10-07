// Separates camera, tracking and render metrics. The old single "fps" mixed
// camera cadence, synchronous inference and browser scheduling; `fps` remains an
// alias for camera FPS for UI compatibility.

export interface MetricsSnapshot {
  /** Actual presented camera frames/sec (rVFC cadence). */
  fps: number;
  cameraFps: number;
  /** Completed perception results/sec. */
  trackingFps: number;
  /** Camera frame interval. */
  frameMs: number;
  inferenceMs: number;
  fitMs: number;
  renderMs: number;
  droppedFrames: number;
  memoryMB: number | null;
  delegate: string;
  capture: string;
}

const EMA = 0.1;
interface MemoryPerf { usedJSHeapSize: number }

export class Metrics {
  private cameraFps = 0;
  private trackingFps = 0;
  private frameMs = 0;
  private inferenceMs = 0;
  private fitMs = 0;
  private renderMs = 0;
  private lastCameraAt: number | null = null;
  private lastTrackingAt: number | null = null;
  private droppedFrames = 0;
  private delegate = 'unknown';
  private capture = 'unknown';

  setDelegate(delegate: string): void { this.delegate = delegate; }

  setCapture(settings: MediaTrackSettings | null): void {
    if (!settings) return;
    const w = settings.width ?? '?';
    const h = settings.height ?? '?';
    const fps = settings.frameRate ? ` @ ${round1(settings.frameRate)}fps` : '';
    this.capture = `${w}×${h}${fps}`;
  }

  markCameraFrame(now: number): void {
    if (this.lastCameraAt !== null) {
      const dt = now - this.lastCameraAt;
      if (dt > 0) {
        this.cameraFps = ema(this.cameraFps, 1000 / dt);
        this.frameMs = ema(this.frameMs, dt);
      }
    }
    this.lastCameraAt = now;
  }

  markInference(ms: number, now: number): void {
    this.inferenceMs = ema(this.inferenceMs, ms);
    if (this.lastTrackingAt !== null) {
      const dt = now - this.lastTrackingAt;
      if (dt > 0) this.trackingFps = ema(this.trackingFps, 1000 / dt);
    }
    this.lastTrackingAt = now;
  }

  markFit(ms: number): void { this.fitMs = ema(this.fitMs, ms); }
  markRender(ms: number): void { this.renderMs = ema(this.renderMs, ms); }
  markDropped(count = 1): void { this.droppedFrames += count; }

  snapshot(): MetricsSnapshot {
    return {
      fps: round1(this.cameraFps),
      cameraFps: round1(this.cameraFps),
      trackingFps: round1(this.trackingFps),
      frameMs: round1(this.frameMs),
      inferenceMs: round1(this.inferenceMs),
      fitMs: round1(this.fitMs),
      renderMs: round1(this.renderMs),
      droppedFrames: this.droppedFrames,
      memoryMB: readMemoryMB(),
      delegate: this.delegate,
      capture: this.capture,
    };
  }

  reset(): void {
    this.cameraFps = 0;
    this.trackingFps = 0;
    this.frameMs = 0;
    this.inferenceMs = 0;
    this.fitMs = 0;
    this.renderMs = 0;
    this.lastCameraAt = null;
    this.lastTrackingAt = null;
    this.droppedFrames = 0;
  }
}

function ema(current: number, next: number): number {
  return current === 0 ? next : current + EMA * (next - current);
}
function round1(x: number): number { return Math.round(x * 10) / 10; }
function readMemoryMB(): number | null {
  const mem = (performance as Performance & { memory?: MemoryPerf }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : null;
}
