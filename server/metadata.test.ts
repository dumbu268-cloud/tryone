import { describe, it, expect } from 'vitest';
import { parseHtml } from './metadata';

const HTML = `
<!doctype html><html><head>
<title>Fallback Title</title>
<meta property="og:title" content="Nice Shirt" />
<meta property="og:image" content="https://cdn.example.com/p/shirt-large.jpg" />
<meta property="og:image:width" content="800" />
<meta property="og:image:height" content="1000" />
<meta name="twitter:image" content="/img/twitter.jpg" />
<link rel="image_src" href="/img/linked.jpg" />
<script type="application/ld+json">
{"@type":"Product","name":"Shirt","image":["https://cdn.example.com/p/ld-1.jpg","https://cdn.example.com/p/ld-2.jpg"]}
</script>
</head><body>
<img src="/img/product.jpg" width="600" height="700" alt="front view" />
<img data-src="/img/logo.png" width="40" height="40" />
</body></html>`;

describe('parseHtml', () => {
  it('extracts the og:title in preference to <title>', () => {
    expect(parseHtml(HTML).title).toBe('Nice Shirt');
  });

  it('extracts candidates from all metadata sources', () => {
    const { candidates } = parseHtml(HTML);
    const bySource = (s: string) => candidates.filter((c) => c.source === s).map((c) => c.url);
    expect(bySource('og')).toContain('https://cdn.example.com/p/shirt-large.jpg');
    expect(bySource('twitter')).toContain('/img/twitter.jpg');
    expect(bySource('link')).toContain('/img/linked.jpg');
    expect(bySource('json-ld')).toEqual(
      expect.arrayContaining(['https://cdn.example.com/p/ld-1.jpg', 'https://cdn.example.com/p/ld-2.jpg']),
    );
    expect(bySource('img')).toContain('/img/product.jpg');
  });

  it('captures og image dimensions and img alt', () => {
    const { candidates } = parseHtml(HTML);
    const og = candidates.find((c) => c.source === 'og')!;
    expect(og.width).toBe(800);
    expect(og.height).toBe(1000);
    const img = candidates.find((c) => c.url === '/img/product.jpg')!;
    expect(img.alt).toBe('front view');
  });

  it('is resilient to pages with no metadata', () => {
    const { candidates, title } = parseHtml('<html><head><title>x</title></head><body></body></html>');
    expect(candidates).toEqual([]);
    expect(title).toBe('x');
  });
});
