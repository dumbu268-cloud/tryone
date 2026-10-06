import { describe, it, expect } from 'vitest';
import { computeFramingHint } from './framing';
import { PoseLandmark } from '@/core/perception/landmarks';
import type { Landmark, PoseFrame, Vec2 } from '@/core/types';

function frame(opts: {
  valid?: boolean;
  shoulders?: [Vec2, Vec2];
  armVis?: number;
  width?: number;
}): PoseFrame {
  const image: Vec2[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  const normalized: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  const [ls, rs] = opts.shoulders ?? [
    { x: 400, y: 300 },
    { x: 600, y: 300 },
  ];
  image[PoseLandmark.LEFT_SHOULDER] = ls;
  image[PoseLandmark.RIGHT_SHOULDER] = rs;
  const av = opts.armVis ?? 1;
  for (const i of [
    PoseLandmark.LEFT_ELBOW,
    PoseLandmark.RIGHT_ELBOW,
    PoseLandmark.LEFT_WRIST,
    PoseLandmark.RIGHT_WRIST,
  ]) {
    normalized[i] = { x: 0, y: 0, z: 0, visibility: av };
  }
  return {
    timestamp: 0,
    width: opts.width ?? 1000,
    height: 1000,
    valid: opts.valid ?? true,
    confidence: 1,
    image,
    normalized,
  };
}

describe('computeFramingHint', () => {
  it('returns null for well-framed, arms-visible poses', () => {
    expect(computeFramingHint(frame({}))).toBeNull();
  });

  it('asks to step into frame when no pose is detected', () => {
    expect(computeFramingHint(frame({ valid: false }))).toMatch(/step into/i);
  });

  it('asks to step back when the user fills the frame', () => {
    const hint = computeFramingHint(
      frame({ shoulders: [{ x: 150, y: 300 }, { x: 850, y: 300 }], width: 1000 }),
    );
    expect(hint).toMatch(/step back/i);
  });

  it('asks to lower arms when they are not visible', () => {
    expect(computeFramingHint(frame({ armVis: 0 }))).toMatch(/lower your arms/i);
  });
});
