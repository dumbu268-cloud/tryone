/// <reference lib="webworker" />
import { BodyPerception } from './BodyPerception';
import type { PerceptionRequest, PerceptionResponse } from './workerProtocol';

const scope = self as DedicatedWorkerGlobalScope;
const perception = new BodyPerception();

scope.onmessage = (event: MessageEvent<PerceptionRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init': {
      const options = request.options ?? {};
      // MediaPipe's loader assumes importScripts when present. Module workers do
      // expose importScripts, but calling it throws; pre-import the ES-module
      // loader so globalThis.ModuleFactory exists before FilesetResolver runs.
      const base = options.wasmBaseUrl ?? '/mediapipe/wasm';
      void import(/* @vite-ignore */ `${base}/vision_wasm_module_internal.js`)
        .then(() => perception.init(options))
        .then(({ delegate }) => post({ type: 'ready', delegate }))
        .catch((error) => post({ type: 'error', message: messageOf(error) }));
      break;
    }
    case 'detect': {
      const { bitmap, id, timestamp, outputWidth, outputHeight } = request;
      try {
        const started = performance.now();
        const frame = perception.detectOn(bitmap, outputWidth, outputHeight, timestamp);
        const inferenceMs = performance.now() - started;
        post({ type: 'result', id, frame, inferenceMs });
      } catch (error) {
        post({ type: 'error', id, message: messageOf(error) });
      } finally {
        bitmap.close();
      }
      break;
    }
    case 'segmentation':
      perception.setSegmentationEnabled(request.enabled);
      break;
    case 'reset':
      perception.reset();
      break;
    case 'close':
      perception.close();
      scope.close();
      break;
  }
};

function post(message: PerceptionResponse): void {
  scope.postMessage(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
