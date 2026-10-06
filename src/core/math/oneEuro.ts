// One-Euro filter — low-latency jitter smoothing for noisy signals.
// Reference: Casiez, Roussel, Vogel (CHI 2012), "1€ Filter".
//
// It adapts smoothing to speed: slow motion is smoothed hard (kills jitter),
// fast motion is smoothed little (kills lag). This is the key difference
// between "jittery tech demo" and "convincing" body tracking.

function smoothingAlpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

class LowPass {
  private filtered: number | null = null;
  private raw: number | null = null;

  filter(x: number, alpha: number): number {
    this.filtered =
      this.filtered === null ? x : alpha * x + (1 - alpha) * this.filtered;
    this.raw = x;
    return this.filtered;
  }

  get lastRaw(): number | null {
    return this.raw;
  }

  get initialized(): boolean {
    return this.filtered !== null;
  }

  reset(): void {
    this.filtered = null;
    this.raw = null;
  }
}

export interface OneEuroOptions {
  /** Minimum cutoff frequency (Hz). Lower = more smoothing at rest. */
  minCutoff?: number;
  /** Speed coefficient. Higher = less lag when moving fast. */
  beta?: number;
  /** Cutoff for the derivative low-pass (Hz). */
  dCutoff?: number;
  /** Fallback dt (seconds) used for the first sample. */
  defaultDt?: number;
}

export class OneEuroFilter {
  readonly minCutoff: number;
  readonly beta: number;
  readonly dCutoff: number;
  private readonly defaultDt: number;

  private readonly xFilter = new LowPass();
  private readonly dxFilter = new LowPass();
  private lastTimeMs: number | null = null;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 1.0;
    this.beta = opts.beta ?? 0.0;
    this.dCutoff = opts.dCutoff ?? 1.0;
    this.defaultDt = opts.defaultDt ?? 1 / 60;
  }

  filter(x: number, timestampMs: number): number {
    let dt = this.defaultDt;
    if (this.lastTimeMs !== null) {
      const delta = (timestampMs - this.lastTimeMs) / 1000;
      if (delta > 0) dt = delta;
    }
    this.lastTimeMs = timestampMs;

    const prevRaw = this.xFilter.lastRaw ?? x;
    const dx = (x - prevRaw) / dt;
    const edx = this.dxFilter.filter(dx, smoothingAlpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(x, smoothingAlpha(cutoff, dt));
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimeMs = null;
  }
}

/** A 3-component (x,y,z) One-Euro filter, e.g. for a single landmark. */
export class Vec3Filter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fz: OneEuroFilter;

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
    this.fz = new OneEuroFilter(opts);
  }

  filter(
    x: number,
    y: number,
    z: number,
    timestampMs: number,
  ): { x: number; y: number; z: number } {
    return {
      x: this.fx.filter(x, timestampMs),
      y: this.fy.filter(y, timestampMs),
      z: this.fz.filter(z, timestampMs),
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}
