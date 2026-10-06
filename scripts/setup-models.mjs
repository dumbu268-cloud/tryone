// Downloads the MediaPipe model files used by the Live Mirror into public/models.
// These are not committed (see .gitignore). Safe to re-run; existing files are skipped.
import { mkdir, access, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'public', 'models');

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  },
  {
    name: 'selfie_multiclass_256x256.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const model of MODELS) {
    const dest = resolve(outDir, model.name);
    if (await exists(dest)) {
      const { size } = await stat(dest);
      console.log(`[setup-models] ${model.name} already present (${size} bytes), skipping`);
      continue;
    }
    console.log(`[setup-models] downloading ${model.name} ...`);
    await download(model.url, dest);
    const { size } = await stat(dest);
    console.log(`[setup-models] saved ${model.name} (${size} bytes)`);
  }
  console.log('[setup-models] done');
}

main().catch((err) => {
  console.error('[setup-models] failed:', err);
  process.exitCode = 1;
});
