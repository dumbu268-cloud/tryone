import type { ProductResolution, ProductResolver } from './ProductResolver';

/** Talks to the same-origin /api/resolve proxy (which does the cross-origin work). */
export class HttpProductResolver implements ProductResolver {
  async resolve(url: string): Promise<ProductResolution> {
    try {
      const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
      if (!res.ok) {
        return {
          ok: false,
          candidates: [],
          reason: `The resolver service returned ${res.status}.`,
          errorKind: 'server-error',
        };
      }
      return (await res.json()) as ProductResolution;
    } catch {
      return {
        ok: false,
        candidates: [],
        reason: 'Could not reach the resolver service. Is the dev server running?',
        errorKind: 'network',
      };
    }
  }
}
