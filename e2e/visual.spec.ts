import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Composites the garment onto the still person image with the real renderer and
// saves a screenshot for visual review of the WebGL output.
test('visual: garment composites onto the person image', async ({ page }) => {
  await page.goto('/?visualtest=1&img=/test/person.jpg');

  await page.waitForFunction(() => (window as unknown as { __visualdone?: boolean }).__visualdone, undefined, {
    timeout: 45_000,
    polling: 300,
  });

  const err = await page.evaluate(
    () => (window as unknown as { __visualerror?: string }).__visualerror,
  );
  expect(err, `visual harness error: ${err}`).toBeUndefined();

  const canvas = page.locator('#visual-canvas');
  await expect(canvas).toBeVisible();
  await canvas.screenshot({ path: resolve(__dirname, '__artifacts__', 'tryon.png') });
});
