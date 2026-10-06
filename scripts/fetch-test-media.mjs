// Downloads the real-footage clips used by the replay bench (e2e/replay.spec.ts)
// into public/test/video. Not committed (see .gitignore).
//   - sign.webm: Armenian Sign Language "kidney" (signer, waist-up, arms crossing
//     the torso / hand on hip / both hands raised). Wikimedia Commons; see the
//     file page for license/attribution.
//   - jump.webm: U.S. Army "Conditioning Drill 1 - Power Jump" (full body, far
//     distance, arms down / hands on hips). U.S. federal government work, public domain.
// If FFMPEG (or `ffmpeg` on PATH) is available, clips are downscaled to 960×540
// with dense keyframes for fast, accurate seeking; otherwise originals are kept.
import { mkdir, writeFile, rename, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/test/video');
const UA = 'TryOneTest/0.1 (test fixtures; github.com/dumbu268-cloud/tryone)';
const CLIPS = [
  {
    name: 'sign.webm',
    file: 'Armenian_Sign_Language_(ArSL)_-_%D5%A5%D6%80%D5%AB%D5%AF%D5%A1%D5%B4_-_kidney.webm',
    trim: null,
  },
  { name: 'jump.webm', file: 'Conditioning_Drill_1-_Power_Jump.webm', trim: 11 },
];

const exists = (p) => access(p).then(() => true, () => false);

function ffmpegBin() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

await mkdir(outDir, { recursive: true });
const ff = ffmpegBin();
for (const clip of CLIPS) {
  const dest = resolve(outDir, clip.name);
  if (await exists(dest)) {
    console.log(`[test-media] ${clip.name} present, skipping`);
    continue;
  }
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${clip.file}`;
  console.log(`[test-media] downloading ${clip.name} ...`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const raw = resolve(outDir, `raw-${clip.name}`);
  await writeFile(raw, Buffer.from(await res.arrayBuffer()));
  if (ff) {
    const trim = clip.trim ? ['-t', String(clip.trim)] : [];
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...trim, '-i', raw, '-an', '-vf', 'scale=960:540',
      '-c:v', 'libvpx', '-b:v', '1.5M', '-g', '3', dest]);
  } else {
    await rename(raw, dest);
  }
  console.log(`[test-media] saved ${clip.name}${ff ? ' (transcoded)' : ''}`);
}
