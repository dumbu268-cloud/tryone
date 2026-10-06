import { describe, it, expect } from 'vitest';
import { rankCandidates } from './rank';
import type { RawCandidate } from './metadata';

const base = 'https://shop.example.com/products/shirt';

describe('rankCandidates', () => {
  it('resolves relative URLs to absolute', () => {
    const out = rankCandidates([{ url: '/img/a.jpg', source: 'og' }], base);
    expect(out[0]!.url).toBe('https://shop.example.com/img/a.jpg');
  });

  it('ranks og/product images above plain and logo images', () => {
    const raw: RawCandidate[] = [
      { url: '/img/site-logo.png', source: 'img', width: 120, height: 40 },
      { url: '/img/product-main.jpg', source: 'og', width: 800, height: 900 },
      { url: '/img/random.jpg', source: 'img', width: 500, height: 500 },
    ];
    const out = rankCandidates(raw, base);
    expect(out[0]!.url).toContain('product-main.jpg');
    // Logo ranks last (penalized) or is filtered out.
    const logo = out.find((c) => c.url.includes('logo'));
    if (logo) expect(logo.score).toBeLessThan(out[0]!.score);
  });

  it('dedupes identical URLs keeping the best score', () => {
    const raw: RawCandidate[] = [
      { url: '/img/a.jpg', source: 'img' },
      { url: '/img/a.jpg', source: 'og' },
    ];
    const out = rankCandidates(raw, base);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('og');
  });

  it('drops tracking pixels and data URIs', () => {
    const raw: RawCandidate[] = [
      { url: '/img/pixel.gif', source: 'img', width: 1, height: 1 },
      { url: 'data:image/png;base64,AAAA', source: 'img' },
      { url: '/img/real.jpg', source: 'og', width: 600, height: 600 },
    ];
    const out = rankCandidates(raw, base);
    expect(out.every((c) => !c.url.includes('pixel') && !c.url.startsWith('data:'))).toBe(true);
    expect(out[0]!.url).toContain('real.jpg');
  });
});
