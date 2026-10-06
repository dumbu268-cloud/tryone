import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { MlPrepReport } from '../src/dev/mlpreptest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Runs the ML garment extractor on real photos and saves the isolated cutout
// (over a checkerboard) for visual inspection, logging detection diagnostics.
const images = ['tshirt.jpg', 'longsleeve.jpg', 'person.jpg'];

for (const img of images) {
  test(`ML extraction on ${img}`, async ({ page }) => {
    await page.goto(`/?mlprep=1&img=/test/${img}`);
    const handle = await page.waitForFunction(
      () => (window as unknown as { __mlprep?: MlPrepReport }).__mlprep,
      undefined,
      { timeout: 60_000, polling: 500 },
    );
    const r = (await handle.jsonValue()) as MlPrepReport;
    console.log(`ML[${img}]:`, JSON.stringify(r));
    expect(r.ok, `error: ${r.error}`).toBe(true);
    await page
      .locator('#visual-canvas')
      .screenshot({ path: resolve(__dirname, '__artifacts__', `ml-${img}.png`) });
  });
}
