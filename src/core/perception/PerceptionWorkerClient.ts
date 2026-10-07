import type { PoseFrame } from '@/core/types';
import type { Delegate, PerceptionOptions } from './BodyPerception';
import type { PerceptionRequest, PerceptionResponse } from './workerProtocol';

export interface WorkerResult {
  frame: PoseFrame;
  inferenceMs: number;
}

/**
 * Main-thread facade for worker-based perception. At most one frame is in
 * flight; new camera frames are dropped while inference is busy (latest-frame
 * processing, no queue/latency buildup). The source is resized before transfer
 * so MediaPipe never receives the full 1280×720 camera frame.
 */
export class PerceptionWorkerClient {
  private worker: Worker | null = null;
  private readyPromise: Promise<{ delegate: Delegate }> | null = null;
  private readyResolve: ((value: { delegate: Delegate }) => void) | null = null;
  private readyReject: ((reason: Error) => void) | null = null;
  private resultHandler: ((result: WorkerResult) => void) | null = null;
  private busy = false;
  private requestId = 0;
  private dropped = 0;
  private segmentationEnabled = true;
  private scratch: HTMLCanvasElement | null = null;

  async init(options: PerceptionOptions = {}): Promise<{ delegate: Delegate }> {
    if (this.readyPromise) return this.readyPromise;
    this.worker = new Worker(new URL('./perception.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PerceptionResponse>) => this.onMessage(event.data);
    this.worker.onerror = (event) => this.readyReject?.(new Error(event.message || 'Perception worker failed.'));
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const workerOptions: PerceptionOptions = {
      ...options,
      // Live person segmentation caused visible holes/lag and made the hot loop
      // much slower. Torso/sleeve fitting is pose-driven; forearm occlusion uses
      // pose capsules. Keep segmentation for one-shot garment preparation only.
      enableSegmentation: false,
      wasmBaseUrl:
        options.wasmBaseUrl ??
        (import.meta.env.DEV ? '/runtime/mediapipe' : '/mediapipe/wasm'),
    };
    this.post({ type: 'init', options: workerOptions });
    this.post({ type: 'segmentation', enabled: this.segmentationEnabled });
    return this.readyPromise;
  }

  onResult(handler: (result: WorkerResult) => void): void {
    this.resultHandler = handler;
  }

  /** Returns false when a previous frame is still being processed. */
  dispatch(
    video: HTMLVideoElement,
    timestamp: number,
    outputWidth: number,
    outputHeight: number,
    maxInferenceSide = 512,
  ): boolean {
    if (!this.worker || this.busy || video.readyState < 2 || !video.videoWidth) {
      if (this.busy) this.dropped++;
      return false;
    }
    this.busy = true;
    const scale = Math.min(1, maxInferenceSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));
    const id = ++this.requestId;

    void this.makeBitmap(video, width, height)
      .then((bitmap) => {
        if (!this.worker) {
          bitmap.close();
          this.busy = false;
          return;
        }
        const message: PerceptionRequest = {
          type: 'detect',
          id,
          bitmap,
          timestamp,
          outputWidth,
          outputHeight,
        };
        this.worker.postMessage(message, [bitmap]);
      })
      .catch((error) => {
        this.busy = false;
        console.error('[perception-worker] frame capture failed', error);
      });
    return true;
  }

  setSegmentationEnabled(enabled: boolean): void {
    this.segmentationEnabled = enabled;
    if (this.worker) this.post({ type: 'segmentation', enabled });
  }

  consumeDropped(): number {
    const value = this.dropped;
    this.dropped = 0;
    return value;
  }

  reset(): void {
    this.busy = false;
    this.dropped = 0;
    if (this.worker) this.post({ type: 'reset' });
  }

  close(): void {
    if (this.worker) {
      this.post({ type: 'close' });
      this.worker.terminate();
    }
    this.worker = null;
    this.readyPromise = null;
    this.busy = false;
  }

  private onMessage(message: PerceptionResponse): void {
    if (message.type === 'ready') {
      this.readyResolve?.({ delegate: message.delegate });
      this.readyResolve = null;
      this.readyReject = null;
    } else if (message.type === 'result') {
      this.busy = false;
      this.resultHandler?.({ frame: message.frame, inferenceMs: message.inferenceMs });
    } else {
      this.busy = false;
      const error = new Error(message.message);
      if (this.readyReject) this.readyReject(error);
      else console.error('[perception-worker]', error);
    }
  }

  private post(message: PerceptionRequest): void {
    this.worker?.postMessage(message);
  }

  private async makeBitmap(video: HTMLVideoElement, width: number, height: number): Promise<ImageBitmap> {
    try {
      return await createImageBitmap(video, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'low',
      });
    } catch {
      // Safari/older Chromium fallback: resize through a small 2D canvas.
      const canvas = this.scratch ?? document.createElement('canvas');
      this.scratch = canvas;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext('2d', { alpha: false })!.drawImage(video, 0, 0, width, height);
      return createImageBitmap(canvas);
    }
  }
}
