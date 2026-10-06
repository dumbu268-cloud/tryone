import { describe, it, expect } from 'vitest';
import { OneEuroFilter } from './oneEuro';

const DT = 1000 / 60; // ms per frame at 60fps

function run(filter: OneEuroFilter, samples: number[]): number[] {
  return samples.map((x, i) => filter.filter(x, i * DT));
}

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    const f = new OneEuroFilter();
    expect(f.filter(42, 0)).toBeCloseTo(42, 6);
  });

  it('converges toward a constant signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    const out = run(f, Array(60).fill(10));
    expect(out[out.length - 1]).toBeCloseTo(10, 3);
  });

  it('substantially reduces jitter around a constant', () => {
    const f = new OneEuroFilter({ minCutoff: 0.5, beta: 0 });
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    const out = run(f, noisy);

    const tail = out.slice(100);
    const rawTailVar = variance(noisy.slice(100));
    const outTailVar = variance(tail);
    expect(outTailVar).toBeLessThan(rawTailVar * 0.25);
  });

  it('tracks a step change (does not get stuck)', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.1 });
    const signal = [...Array(30).fill(0), ...Array(60).fill(100)];
    const out = run(f, signal);
    expect(out[out.length - 1]).toBeGreaterThan(95);
  });

  it('higher beta responds faster to fast motion (less lag)', () => {
    const ramp = Array.from({ length: 40 }, (_, i) => i * 10); // fast motion
    const low = run(new OneEuroFilter({ minCutoff: 1, beta: 0 }), ramp);
    const high = run(new OneEuroFilter({ minCutoff: 1, beta: 2 }), ramp);
    const target = ramp[ramp.length - 1]!;
    // Higher beta should be closer to the true (fast-moving) value.
    expect(Math.abs(high[high.length - 1]! - target)).toBeLessThan(
      Math.abs(low[low.length - 1]! - target),
    );
  });

  it('reset clears state so the next sample passes through', () => {
    const f = new OneEuroFilter();
    run(f, Array(30).fill(5));
    f.reset();
    expect(f.filter(999, 0)).toBeCloseTo(999, 6);
  });
});

function variance(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}
