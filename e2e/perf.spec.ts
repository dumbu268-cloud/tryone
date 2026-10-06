import { test } from '@playwright/test';
import type { MetricsSnapshot } from '../src/core/perf/Metrics';

// Informational perf smoke. Runs the live loop with the fake camera for a few
// seconds and prints the measured metrics. NOTE: this sandbox renders via
// CPU/SwiftShader, so absolute FPS is a floor, not representative of real GPU
// hardware. No hard thresholds are asserted here.
test('perf: measure live-loop metrics (informational)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-camera').click();
  await page.waitForFunction(() => document.documentElement.dataset.mirrorStatus === 'running', undefined, {
    timeout: 45_000,
  });

  await page.waitForTimeout(7000);

  const metrics = (await page.evaluate(
    () => (window as unknown as { __metrics?: MetricsSnapshot }).__metrics,
  )) as MetricsSnapshot | undefined;

  console.log('MEASURED METRICS:', JSON.stringify(metrics, null, 2));
});
