// Copies the MediaPipe Tasks-Vision WASM runtime from node_modules into
// public/mediapipe/wasm so the app serves it locally (no runtime CDN dependency).
// Runs automatically on postinstall; safe to re-run.
import { cp, mkdir, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(root, 'public/mediapipe/wasm');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    console.warn(
      '[copy-wasm] @mediapipe/tasks-vision not installed yet; skipping. ' +
        'Run `npm install` first.',
    );
    return;
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
  const files = await readdir(dest);
  console.log(`[copy-wasm] Copied ${files.length} files -> public/mediapipe/wasm`);
}

main().catch((err) => {
  console.error('[copy-wasm] failed:', err);
  process.exitCode = 1;
});
