import type { ImageCandidate } from '../src/core/product/ProductResolver';
import { parseHtml } from './metadata';
import { rankCandidates } from './rank';

// Adapter pattern for product-page understanding. The generic adapter
// (OpenGraph / Twitter / JSON-LD / <link> / <img>) covers the large majority of
// product pages reliably. Site-specific adapters can be registered here ONLY
// when a site genuinely needs special handling — we intentionally ship none, to
// avoid brittle per-retailer scraping.

export interface Adapter {
  name: string;
  match(url: URL): boolean;
  extract(html: string, baseUrl: string): { title?: string; candidates: ImageCandidate[] };
}

export const genericAdapter: Adapter = {
  name: 'generic-metadata',
  match: () => true,
  extract(html, baseUrl) {
    const parsed = parseHtml(html);
    return {
      ...(parsed.title ? { title: parsed.title } : {}),
      candidates: rankCandidates(parsed.candidates, baseUrl),
    };
  },
};

// Register site-specific adapters here if ever justified (none for now).
const siteAdapters: Adapter[] = [];

export function pickAdapter(url: URL): Adapter {
  return siteAdapters.find((a) => a.match(url)) ?? genericAdapter;
}
