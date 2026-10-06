import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { PrepTestReport } from '../src/dev/preptest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// End-to-end Phase 3: each sample clothing image is auto-prepared into a
// GarmentAsset and worn on the person image through the existing articulated
// engine. Verifies detection + that the prepared garment renders.
const cases = [
  { file: 'sample-tshirt.svg', expectType: 'tshirt', expectSleeve: 'short' },
  { file: 'sample-longsleeve.svg', expectType: 'longsleeve', expectSleeve: 'long' },
  { file: 'sample-tank.svg', expectType: 'tshirt', expectSleeve: 'none' },
] as const;

for (const c of cases) {
  test(`auto-prepares ${c.file} and wears it`, async ({ page }) => {
    await page.goto(`/?preptest=1&garment=/garments/samples/${c.file}&img=/test/person.jpg`);

    const handle = await page.waitForFunction(
      () => (window as unknown as { __prep?: PrepTestReport }).__prep,
      undefined,
      { timeout: 45_000, polling: 400 },
    );
    const r = (await handle.jsonValue()) as PrepTestReport;
    console.log(`prep[${c.file}]:`, JSON.stringify(r));

    expect(r.ok, `error: ${r.error}`).toBe(true);
    expect(r.supported).toBe(true);
    expect(r.detectedType).toBe(c.expectType);
    expect(r.sleeveLength).toBe(c.expectSleeve);
    expect(r.fitVisible).toBe(true);

    await page
      .locator('#visual-canvas')
      .screenshot({ path: resolve(__dirname, '__artifacts__', `prep-${c.file}.png`) });
  });
}
