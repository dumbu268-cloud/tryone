import type { ImageCandidate } from '../src/core/product/ProductResolver';
import type { RawCandidate } from './metadata';

// Score + sort image candidates so the main product image floats to the top.
// Resolves relative URLs against the page, dedupes, and filters out obvious
// non-product assets (icons, logos, sprites, tracking pixels).

const SOURCE_SCORE: Record<string, number> = {
  direct: 120,
  og: 100,
  twitter: 90,
  'json-ld': 85,
  link: 55,
  img: 40,
};

const BOOST = /(product|large|zoom|_main|hero|detail|original|full)/i;
const PENALTY = /(logo|icon|sprite|thumb|thumbnail|placeholder|banner|swatch|avatar|loader|spinner|pixel|1x1|blank)/i;

export function rankCandidates(raw: RawCandidate[], baseUrl: string): ImageCandidate[] {
  const byUrl = new Map<string, ImageCandidate>();

  for (const c of raw) {
    const abs = toAbsolute(c.url, baseUrl);
    if (!abs) continue;
    if (abs.startsWith('data:')) continue; // skip inline data URIs
    if (/\.(svg)(\?|$)/i.test(abs) && c.source === 'img') {
      // allow svg from metadata, skip inline-ish <img> svgs that are usually icons
    }

    let score = SOURCE_SCORE[c.source] ?? 30;
    if (BOOST.test(abs)) score += 15;
    if (PENALTY.test(abs)) score -= 45;

    const w = c.width;
    const h = c.height;
    if (w && h) {
      const area = w * h;
      if (w <= 2 || h <= 2) continue; // tracking pixel
      if (area < 64 * 64) score -= 35;
      else if (area >= 400 * 400) score += 25;
      else if (area >= 200 * 200) score += 10;
      const aspect = w / h;
      if (aspect > 3 || aspect < 0.33) score -= 20; // banners / thin strips
    }

    const existing = byUrl.get(abs);
    if (!existing || score > existing.score) {
      byUrl.set(abs, {
        url: abs,
        score,
        source: c.source,
        ...(w ? { width: w } : {}),
        ...(h ? { height: h } : {}),
        ...(c.alt ? { alt: c.alt } : {}),
      });
    }
  }

  return [...byUrl.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function toAbsolute(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return null;
  }
}
