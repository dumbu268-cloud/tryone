import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ReplayConfig } from '../src/dev/replaytest';

// Real-footage regression bench. Replays recorded video of real people through
// the live pipeline and screenshots fixed checkpoints. Select scenarios with
// RUNS=a,b,c and tag outputs with TAG=before|after. Opt-in (slow under
// software rendering): skipped unless RUNS is set.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = process.env.TAG ?? 'run';
const RUNS = (process.env.RUNS ?? '').split(',').filter(Boolean);
const OUT = resolve(__dirname, '__artifacts__', 'replay', TAG);

const LONG = 'builtin:shirt-long-green';
const TEE_ML = 'ml:/test/tshirt.jpg';
const TANK = 'classic:/garments/samples/sample-tank.svg';

interface Scenario {
  cfg: ReplayConfig;
  fps: number;
  checkpoints: number[];
}

const SIGN = '/test/video/sign.webm';
const JUMP = '/test/video/jump.webm';
// Sign clip: hands clasped in front (~0.9s), hand on hip (~2.1s), both hands
// raised (~3.1s), back to front (~5.0s).
const SIGN_CP = [0.9, 2.1, 3.1, 5.0];

const SCENARIOS: Record<string, Scenario> = {
  'long-normal': { cfg: { video: SIGN, garment: LONG }, fps: 5, checkpoints: SIGN_CP },
  'long-close': { cfg: { video: SIGN, garment: LONG, zoom: 1.7, cy: 0.42 }, fps: 5, checkpoints: SIGN_CP },
  'long-dropout': { cfg: { video: SIGN, garment: LONG, dropout: [2.5, 4.4] }, fps: 5, checkpoints: [2.3, 2.9, 3.9, 5.0] },
  'long-far': { cfg: { video: JUMP, garment: LONG, zoom: 1.5, cy: 0.42 }, fps: 3, checkpoints: [1.5, 4.5, 7.5, 9.0] },
  'tee-normal': { cfg: { video: SIGN, garment: TEE_ML }, fps: 5, checkpoints: SIGN_CP },
  'tee-close': { cfg: { video: SIGN, garment: TEE_ML, zoom: 1.7, cy: 0.42 }, fps: 5, checkpoints: SIGN_CP },
  'tee-far': { cfg: { video: JUMP, garment: TEE_ML, zoom: 1.5, cy: 0.42 }, fps: 3, checkpoints: [1.5, 4.5, 7.5, 9.0] },
  'tank-normal': { cfg: { video: SIGN, garment: TANK }, fps: 5, checkpoints: SIGN_CP },
  'long-debug': { cfg: { video: SIGN, garment: LONG, settings: { debug: true } }, fps: 5, checkpoints: [0.9, 3.1] },
  'tank-close': { cfg: { video: SIGN, garment: TANK, zoom: 1.7, cy: 0.42 }, fps: 5, checkpoints: SIGN_CP },
};

for (const name of RUNS) {
  test(`replay ${TAG}: ${name}`, async ({ page }) => {
    test.setTimeout(600_000);
    const sc = SCENARIOS[name];
    expect(sc, `unknown scenario ${name}`).toBeTruthy();
    mkdirSync(OUT, { recursive: true });

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/?replay=1');
    await page.waitForFunction(() => !!window.__replay, undefined, { timeout: 30_000 });
    await page.evaluate((cfg) => window.__replay!.init(cfg), sc!.cfg);

    const canvas = page.locator('#visual-canvas');
    for (const cp of sc!.checkpoints) {
      await page.evaluate(([t, fps]) => window.__replay!.runTo(t!, fps!), [cp, sc!.fps]);
      await canvas.screenshot({ path: resolve(OUT, `${name}-${cp.toFixed(1)}.png`) });
    }

    const stats = await page.evaluate(() => window.__replay!.stats());
    const garment = await page.evaluate(() => window.__replay!.garment());
    const region = await page.evaluate(() => window.__replay!.region());
    writeFileSync(resolve(OUT, `${name}-region.png`), Buffer.from(region.split(',')[1] ?? '', 'base64'));
    writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify({ garment, stats }, null, 1));
    const infer = stats.map((s) => s.inferMs).sort((a, b) => a - b);
    const render = stats.map((s) => s.renderMs).sort((a, b) => a - b);
    console.log(
      `REPLAY ${TAG} ${name}: frames=${stats.length} valid=${stats.filter((s) => s.valid).length}` +
        ` inferMedian=${infer[infer.length >> 1]}ms renderMedian=${render[render.length >> 1]}ms` +
        ` garment=${JSON.stringify(garment)}`,
    );
    expect(errors, errors.join('\n')).toHaveLength(0);
  });
}
