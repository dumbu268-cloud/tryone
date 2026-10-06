import type { PoseFrame } from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';
import * as v from '@/core/math/vec';

// Lightweight framing coach. Turns the current pose into a short, actionable
// hint so the user positions themselves for a good fit (the single biggest
// lever on perceived quality for a 2.5D overlay). Pure + deterministic.

export function computeFramingHint(frame: PoseFrame): string | null {
  if (!frame.valid || frame.image.length < 33) {
    return 'Step into the frame so your head and shoulders are visible';
  }

  const ls = frame.image[PoseLandmark.LEFT_SHOULDER]!;
  const rs = frame.image[PoseLandmark.RIGHT_SHOULDER]!;
  const shoulderWidth = v.dist(ls, rs);

  if (frame.width > 0 && shoulderWidth / frame.width > 0.62) {
    return 'Step back a little — fit your whole upper body in view';
  }

  const n = frame.normalized;
  const armVis = Math.min(
    n[PoseLandmark.LEFT_ELBOW]?.visibility ?? 0,
    n[PoseLandmark.RIGHT_ELBOW]?.visibility ?? 0,
    n[PoseLandmark.LEFT_WRIST]?.visibility ?? 0,
    n[PoseLandmark.RIGHT_WRIST]?.visibility ?? 0,
  );
  if (armVis < 0.3) {
    return 'Lower your arms into view so the sleeves can follow';
  }

  return null;
}
