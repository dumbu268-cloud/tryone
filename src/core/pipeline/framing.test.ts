import { describe, it, expect } from 'vitest';
import { computeFramingHint } from './framing';
import { PoseLandmark } from '@/core/perception/landmarks';
import type { Landmark, PoseFrame } from '@/core/types';

function frame(opts: { valid?: boolean; shoulderX?: [number, number]; wristY?: number }): PoseFrame {
  const normalized: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const [lx, rx] = opts.shoulderX ?? [0.4, 0.6];
  normalized[PoseLandmark.LEFT_SHOULDER] = { x: lx, y: 0.45, z: 0, visibility: 1 };
  normalized[PoseLandmark.RIGHT_SHOULDER] = { x: rx, y: 0.45, z: 0, visibility: 1 };
  const wy = opts.wristY ?? 0.8;
  normalized[PoseLandmark.LEFT_WRIST] = { x: 0.4, y: wy, z: 0, visibility: wy > 1 ? 0.1 : 1 };
  normalized[PoseLandmark.RIGHT_WRIST] = { x: 0.6, y: wy, z: 0, visibility: wy > 1 ? 0.1 : 1 };
  return {
    timestamp: 0,
    width: 1000,
    height: 1000,
    valid: opts.valid ?? true,
    confidence: 1,
    image: [],
    normalized,
  };
}

describe('computeFramingHint', () => {
  it('stays silent for a normal framing', () => {
    expect(computeFramingHint(frame({}))).toBeNull();
  });

  it('never asks the user to move their arms (wrists out of frame is normal)', () => {
    expect(computeFramingHint(frame({ wristY: 1.3 }))).toBeNull();
  });

  it('asks to step into frame when no pose is detected', () => {
    expect(computeFramingHint(frame({ valid: false }))).toMatch(/step into/i);
  });

  it('asks to step back only when a shoulder is outside the frame', () => {
    expect(computeFramingHint(frame({ shoulderX: [-0.05, 0.7] }))).toMatch(/step back/i);
    expect(computeFramingHint(frame({ shoulderX: [0.08, 0.92] }))).toBeNull();
  });
});
