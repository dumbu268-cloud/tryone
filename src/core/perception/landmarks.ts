// MediaPipe Pose landmark indices (33-point model). Only the ones the Live
// Mirror uses are named; see the full list in the MediaPipe docs.
export const PoseLandmark = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const;

export const POSE_LANDMARK_COUNT = 33;

/** Landmarks that must be reasonably visible to attach a torso garment. */
export const TORSO_LANDMARKS: number[] = [
  PoseLandmark.LEFT_SHOULDER,
  PoseLandmark.RIGHT_SHOULDER,
  PoseLandmark.LEFT_HIP,
  PoseLandmark.RIGHT_HIP,
];

/** Category indices emitted by the selfie multiclass segmenter. */
export const SegClass = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  OTHERS: 5,
} as const;
