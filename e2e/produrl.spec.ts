import { test, expect } from '@playwright/test';

// Drives the real URL → resolve → image-proxy → GarmentPreparer flow through the
// UI, against local fixtures served by the dev server (deterministic, offline).
const BASE = 'http://localhost:5173';

async function submit(page: import('@playwright/test').Page, url: string) {
  await page.goto('/');
  await page.getByTestId('url-input').fill(url);
  await page.getByTestId('url-fetch').click();
}

test('direct image URL → prepared garment', async ({ page }) => {
  await submit(page, `${BASE}/garments/samples/sample-tshirt.svg`);
  const ok = page.getByTestId('url-success');
  await expect(ok).toBeVisible({ timeout: 25_000 });
  await expect(ok).toContainText('tshirt');
});

test('product page with OpenGraph metadata → prepared garment', async ({ page }) => {
  await submit(page, `${BASE}/test/product.html`);
  const ok = page.getByTestId('url-success');
  await expect(ok).toBeVisible({ timeout: 25_000 });
  // og:image points at the long-sleeve sample, which must win ranking.
  await expect(ok).toContainText('longsleeve');
});

test('page with no usable image → clear error + fallback', async ({ page }) => {
  await submit(page, `${BASE}/test/noimage.html`);
  const err = page.getByTestId('url-error');
  await expect(err).toBeVisible({ timeout: 25_000 });
  await expect(err).toContainText(/no usable product image/i);
  await expect(page.getByText('Upload image instead')).toBeVisible();
});

test('invalid URL → validation error', async ({ page }) => {
  await submit(page, 'not a url');
  const err = page.getByTestId('url-error');
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText(/valid URL/i);
});

test('inaccessible resource (404) → clear error', async ({ page }) => {
  await submit(page, `${BASE}/test/does-not-exist.png`);
  const err = page.getByTestId('url-error');
  await expect(err).toBeVisible({ timeout: 25_000 });
});
