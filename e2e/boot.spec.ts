import { test, expect } from '@playwright/test';

// Boots the full app with a fake camera and verifies the live loop runs:
// camera starts, models load, the render loop produces frames (FPS > 0), and
// no uncaught/runtime errors occur. The fake stream has no human, so garment
// tracking itself is covered by the self-test spec.
test('app boots, camera starts, and the live loop runs', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Live Mirror/i })).toBeVisible();

  await page.getByTestId('start-camera').click();

  // Wait for the pipeline to reach the running state.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.mirrorStatus), {
      timeout: 45_000,
    })
    .toBe('running');

  // Stats overlay appears and FPS climbs above zero as frames are processed.
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect
    .poll(
      async () => {
        const txt = await page.getByTestId('fps').textContent();
        return Number(txt ?? '0');
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  // No fatal runtime errors (ignore benign resource warnings).
  const fatal = errors.filter(
    (e) => !/favicon|ERR_|Failed to load resource/i.test(e),
  );
  expect(fatal, `console errors:\n${fatal.join('\n')}`).toHaveLength(0);
});
