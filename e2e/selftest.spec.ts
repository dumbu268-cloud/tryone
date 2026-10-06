import { test, expect } from '@playwright/test';
import type { SelfTestResult } from '../src/dev/selftest';

// Validates the real pipeline: image -> MediaPipe pose + segmentation ->
// PoseFrame -> MeshWarpEngine fit, against a static person image (no camera).
test('perception + fitting self-test on a still image', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/?selftest=1&img=/test/person.jpg');

  const result = await page.waitForFunction(
    () => (window as unknown as { __selftest?: SelfTestResult }).__selftest,
    undefined,
    { timeout: 45_000, polling: 500 },
  );
  const r = (await result.jsonValue()) as SelfTestResult;

  console.log('self-test result:', JSON.stringify(r, null, 2));

  // The pipeline must have run end to end without throwing.
  expect(r.error, `self-test errored at stage "${r.stage}"`).toBeUndefined();
  expect(r.stage).toBe('done');
  expect(['GPU', 'CPU']).toContain(r.delegate);

  // Perception produced a full 33-landmark pose for the person image.
  expect(r.landmarkCount).toBe(33);
  expect(r.valid).toBe(true);
  expect(r.confidence ?? 0).toBeGreaterThan(0.5);
  expect(r.hasSegmentation).toBe(true);

  // The engine produced a visible, well-formed torso quad.
  expect(r.fitVisible).toBe(true);
  expect(r.fitOpacity ?? 0).toBeGreaterThan(0.9);
  expect(r.quad!.tl.x).toBeLessThan(r.quad!.tr.x);
  expect(r.quad!.tl.y).toBeLessThan(r.quad!.bl.y);
});
