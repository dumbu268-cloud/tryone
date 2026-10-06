import {
  FilesetResolver,
  PoseLandmarker,
  ImageSegmenter,
} from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame, SegmentationMask, Vec2 } from '@/core/types';
import { Vec3Filter, type OneEuroOptions } from '@/core/math/oneEuro';
import { POSE_LANDMARK_COUNT, PoseLandmark, TORSO_LANDMARKS } from './landmarks';

export type Delegate = 'GPU' | 'CPU';

export interface PerceptionOptions {
  modelsBaseUrl?: string;
  wasmBaseUrl?: string;
  enableSegmentation?: boolean;
  /** Run segmentation every Nth frame (occlusion tolerates a lower cadence). */
  segmentationStride?: number;
  minPoseDetectionConfidence?: number;
  minTrackingConfidence?: number;
  /** Mean torso-landmark visibility required to consider a frame "valid". */
  minTorsoVisibility?: number;
  oneEuro?: OneEuroOptions;
}

const DEFAULTS = {
  modelsBaseUrl: '/models',
  wasmBaseUrl: '/mediapipe/wasm',
  enableSegmentation: true,
  segmentationStride: 1,
  minPoseDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  minTorsoVisibility: 0.5,
  // Tuned for body tracking: smooth at rest, responsive while moving.
  oneEuro: { minCutoff: 1.3, beta: 0.012, dCutoff: 1.0 } satisfies OneEuroOptions,
};

/**
 * Real-time body perception. Wraps MediaPipe PoseLandmarker + the multiclass
 * selfie ImageSegmenter and emits a smoothed, mirrored `PoseFrame`.
 *
 * Mirroring convention: landmark x is flipped here (1 - x) so landmarks live in
 * the same mirrored "screen space" the renderer presents. The segmentation mask
 * is left unmirrored; the renderer flips x when sampling it.
 */
export class BodyPerception {
  private pose: PoseLandmarker | null = null;
  private segmenter: ImageSegmenter | null = null;
  private delegate: Delegate = 'GPU';
  private opts = DEFAULTS;

  private readonly filters: Vec3Filter[] = [];
  private frameCount = 0;
  private lastTs = -1;

  // Retained outputs so a dropped/invalid frame can hold the last placement.
  private lastImage: Vec2[] = [];
  private lastNormalized: Landmark[] = [];
  private lastSeg: SegmentationMask | undefined;

  get ready(): boolean {
    return this.pose !== null;
  }

  get activeDelegate(): Delegate {
    return this.delegate;
  }

  async init(options: PerceptionOptions = {}): Promise<{ delegate: Delegate }> {
    this.opts = { ...DEFAULTS, ...options, oneEuro: { ...DEFAULTS.oneEuro, ...options.oneEuro } };

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      this.filters.push(new Vec3Filter(this.opts.oneEuro));
    }

    const fileset = await FilesetResolver.forVisionTasks(this.opts.wasmBaseUrl);

    // Prefer the GPU delegate; fall back to CPU if GPU init fails.
    try {
      await this.createTasks(fileset, 'GPU');
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('[perception] GPU delegate unavailable, falling back to CPU', gpuErr);
      this.disposeTasks();
      await this.createTasks(fileset, 'CPU');
      this.delegate = 'CPU';
    }

    return { delegate: this.delegate };
  }

  private async createTasks(
    fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    delegate: Delegate,
  ): Promise<void> {
    this.pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${this.opts.modelsBaseUrl}/pose_landmarker_lite.task`,
        delegate,
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: this.opts.minPoseDetectionConfidence,
      minPosePresenceConfidence: this.opts.minPoseDetectionConfidence,
      minTrackingConfidence: this.opts.minTrackingConfidence,
      outputSegmentationMasks: false,
    });

    if (this.opts.enableSegmentation) {
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${this.opts.modelsBaseUrl}/selfie_multiclass_256x256.tflite`,
          delegate,
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    }
  }

  /** Reset temporal smoothing (e.g. after the camera restarts or tracking is lost). */
  reset(): void {
    for (const f of this.filters) f.reset();
    this.lastImage = [];
    this.lastNormalized = [];
    this.lastSeg = undefined;
    this.lastTs = -1;
  }

  /**
   * Run perception on a video frame. `timestampMs` must be strictly increasing;
   * it is clamped internally if not.
   */
  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame {
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!this.pose || width === 0 || height === 0) {
      return this.emptyFrame(timestampMs, width, height);
    }

    // MediaPipe requires strictly increasing timestamps.
    let ts = timestampMs;
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    this.frameCount++;

    const result = this.pose.detectForVideo(video, ts);
    const lm = result.landmarks?.[0];

    if (!lm || lm.length < POSE_LANDMARK_COUNT) {
      // No pose this frame — hold the last placement, mark invalid (engine fades).
      return {
        timestamp: ts,
        width,
        height,
        valid: false,
        confidence: 0,
        image: this.lastImage,
        normalized: this.lastNormalized,
        segmentation: this.lastSeg,
      };
    }

    const confidence = this.torsoConfidence(lm);
    const valid = confidence >= this.opts.minTorsoVisibility;

    const image: Vec2[] = new Array(POSE_LANDMARK_COUNT);
    const normalized: Landmark[] = new Array(POSE_LANDMARK_COUNT);
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const p = lm[i]!;
      // Mirror x into screen space, then smooth.
      const s = this.filters[i]!.filter(1 - p.x, p.y, p.z, ts);
      normalized[i] = { x: s.x, y: s.y, z: s.z, visibility: p.visibility ?? 1 };
      image[i] = { x: s.x * width, y: s.y * height };
    }
    this.lastImage = image;
    this.lastNormalized = normalized;

    let segmentation = this.lastSeg;
    if (this.segmenter && valid && this.frameCount % this.opts.segmentationStride === 0) {
      segmentation = this.runSegmentation(video, ts) ?? this.lastSeg;
      this.lastSeg = segmentation;
    }

    return { timestamp: ts, width, height, valid, confidence, image, normalized, segmentation };
  }

  private runSegmentation(video: HTMLVideoElement, ts: number): SegmentationMask | undefined {
    if (!this.segmenter) return undefined;
    const res = this.segmenter.segmentForVideo(video, ts);
    const mask = res.categoryMask;
    if (!mask) {
      res.close();
      return undefined;
    }
    // Copy out before close(); the mask's backing memory is reused per frame.
    const data = new Uint8Array(mask.getAsUint8Array());
    const out: SegmentationMask = { width: mask.width, height: mask.height, data };
    res.close();
    return out;
  }

  private torsoConfidence(lm: { visibility?: number }[]): number {
    let sum = 0;
    for (const idx of TORSO_LANDMARKS) sum += lm[idx]?.visibility ?? 0;
    return sum / TORSO_LANDMARKS.length;
  }

  private emptyFrame(ts: number, width: number, height: number): PoseFrame {
    return {
      timestamp: ts,
      width,
      height,
      valid: false,
      confidence: 0,
      image: this.lastImage,
      normalized: this.lastNormalized,
      segmentation: this.lastSeg,
    };
  }

  close(): void {
    this.disposeTasks();
    this.reset();
    this.filters.length = 0;
  }

  private disposeTasks(): void {
    this.pose?.close();
    this.segmenter?.close();
    this.pose = null;
    this.segmenter = null;
  }
}

export { PoseLandmark };
