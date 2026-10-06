import type { PoseFrame } from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';

// Framing coach. Only speaks up when the TORSO fit is genuinely impossible:
// no person, or a shoulder outside the frame. Arm visibility never triggers a
// hint — sleeves follow arms when visible and hold/rest gracefully otherwise.

export function computeFramingHint(frame: PoseFrame): string | null {
  if (!frame.valid || frame.normalized.length < 33) {
    return 'Step into the frame so your head and shoulders are visible';
  }
  const out = (i: number) => {
    const p = frame.normalized[i];
    return !p || p.x < 0.01 || p.x > 0.99 || p.y < 0.01 || p.y > 0.99;
  };
  if (out(PoseLandmark.LEFT_SHOULDER) || out(PoseLandmark.RIGHT_SHOULDER)) {
    return 'Step back a little so both shoulders are in view';
  }
  return null;
}
