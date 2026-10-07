import type { PoseFrame } from '@/core/types';
import type { Delegate, PerceptionOptions } from './BodyPerception';

export type PerceptionRequest =
  | { type: 'init'; options?: PerceptionOptions }
  | {
      type: 'detect';
      id: number;
      bitmap: ImageBitmap;
      timestamp: number;
      outputWidth: number;
      outputHeight: number;
    }
  | { type: 'segmentation'; enabled: boolean }
  | { type: 'reset' }
  | { type: 'close' };

export type PerceptionResponse =
  | { type: 'ready'; delegate: Delegate }
  | { type: 'result'; id: number; frame: PoseFrame; inferenceMs: number }
  | { type: 'error'; message: string; id?: number };
