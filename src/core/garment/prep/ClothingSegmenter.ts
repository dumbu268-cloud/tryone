import { FilesetResolver, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';

// ML garment segmentation for still product images. Uses the MediaPipe
// multiclass selfie segmenter (gives a "clothes" class that excludes skin, hair,
// face and background) plus the pose landmarker (to find the hip line and torso,
// so pants below the hips can be dropped). IMAGE running mode, one-shot.

export type Delegate = 'GPU' | 'CPU';

export interface SegLandmark {
  x: number; // pixels
  y: number; // pixels
  visibility: number;
}

export interface ClothingSegResult {
  /** Per-pixel selfie-multiclass category (0 bg,1 hair,2 body-skin,3 face,4 clothes,5 other). */
  categories: Uint8Array;
  width: number;
  height: number;
  /** 33 pose landmarks in pixel space, or null if no person detected (flat-lay). */
  pose: SegLandmark[] | null;
  delegate: Delegate;
}

export interface ClothingSegmenterOptions {
  modelsBaseUrl?: string;
  wasmBaseUrl?: string;
}

export class ClothingSegmenter {
  private segmenter: ImageSegmenter | null = null;
  private pose: PoseLandmarker | null = null;
  private delegate: Delegate = 'GPU';

  get ready(): boolean {
    return this.segmenter !== null;
  }

  async init(opts: ClothingSegmenterOptions = {}): Promise<{ delegate: Delegate }> {
    const modelsBaseUrl = opts.modelsBaseUrl ?? '/models';
    const wasmBaseUrl = opts.wasmBaseUrl ?? '/mediapipe/wasm';
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl);

    const build = async (delegate: Delegate) => {
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${modelsBaseUrl}/selfie_multiclass_256x256.tflite`,
          delegate,
        },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${modelsBaseUrl}/pose_landmarker_lite.task`,
          delegate,
        },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
      });
    };

    try {
      await build('GPU');
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[clothing-seg] GPU unavailable, using CPU', err);
      this.dispose();
      await build('CPU');
      this.delegate = 'CPU';
    }
    return { delegate: this.delegate };
  }

  segment(source: HTMLCanvasElement | HTMLImageElement, w: number, h: number): ClothingSegResult {
    if (!this.segmenter || !this.pose) throw new Error('ClothingSegmenter not initialized');

    const segRes = this.segmenter.segment(source);
    const mask = segRes.categoryMask;
    if (!mask) {
      segRes.close();
      return { categories: new Uint8Array(w * h), width: w, height: h, pose: null, delegate: this.delegate };
    }
    const mw = mask.width;
    const mh = mask.height;
    const categories = new Uint8Array(mask.getAsUint8Array());
    segRes.close();

    const poseRes = this.pose.detect(source);
    const lm = poseRes.landmarks?.[0];
    const pose: SegLandmark[] | null = lm
      ? lm.map((p) => ({ x: p.x * mw, y: p.y * mh, visibility: p.visibility ?? 1 }))
      : null;

    return { categories, width: mw, height: mh, pose, delegate: this.delegate };
  }

  dispose(): void {
    this.segmenter?.close();
    this.pose?.close();
    this.segmenter = null;
    this.pose = null;
  }
}
