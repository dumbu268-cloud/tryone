// Lightweight rolling performance metrics for the live loop. Uses exponential
// moving averages so the numbers are stable enough to display without jitter.

export interface MetricsSnapshot {
  fps: number;
  frameMs: number;
  inferenceMs: number;
  renderMs: number;
  memoryMB: number | null;
  delegate: string;
}

const EMA = 0.1; // smoothing factor for per-stage timings

interface MemoryPerf {
  usedJSHeapSize: number;
}

export class Metrics {
  private fps = 0;
  private frameMs = 0;
  private inferenceMs = 0;
  private renderMs = 0;
  private lastFrameStart: number | null = null;
  private delegate = 'unknown';

  setDelegate(delegate: string): void {
    this.delegate = delegate;
  }

  beginFrame(now: number): void {
    if (this.lastFrameStart !== null) {
      const dt = now - this.lastFrameStart;
      if (dt > 0) {
        const instantaneousFps = 1000 / dt;
        this.fps = this.fps === 0 ? instantaneousFps : this.fps + EMA * (instantaneousFps - this.fps);
        this.frameMs = this.frameMs === 0 ? dt : this.frameMs + EMA * (dt - this.frameMs);
      }
    }
    this.lastFrameStart = now;
  }

  markInference(ms: number): void {
    this.inferenceMs = this.inferenceMs === 0 ? ms : this.inferenceMs + EMA * (ms - this.inferenceMs);
  }

  markRender(ms: number): void {
    this.renderMs = this.renderMs === 0 ? ms : this.renderMs + EMA * (ms - this.renderMs);
  }

  snapshot(): MetricsSnapshot {
    return {
      fps: Math.round(this.fps * 10) / 10,
      frameMs: round1(this.frameMs),
      inferenceMs: round1(this.inferenceMs),
      renderMs: round1(this.renderMs),
      memoryMB: readMemoryMB(),
      delegate: this.delegate,
    };
  }

  reset(): void {
    this.fps = 0;
    this.frameMs = 0;
    this.inferenceMs = 0;
    this.renderMs = 0;
    this.lastFrameStart = null;
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function readMemoryMB(): number | null {
  const mem = (performance as Performance & { memory?: MemoryPerf }).memory;
  if (mem && typeof mem.usedJSHeapSize === 'number') {
    return Math.round(mem.usedJSHeapSize / (1024 * 1024));
  }
  return null;
}
