import type { ProductResolution } from '../src/core/product/ProductResolver';
import { validateUrl } from './ssrf';
import { safeFetch, FetchError } from './fetchSafe';
import { robotsAllows } from './robots';
import { pickAdapter } from './adapters';

export interface ResolveOptions {
  /** Allow localhost/private hosts (dev + local fixtures). */
  allowLocal?: boolean;
  /** Honour robots.txt (skipped for local fixtures). */
  checkRobots?: boolean;
}

/**
 * Resolve a product URL (or direct image URL) into ranked image candidates.
 *   - direct image → single candidate
 *   - HTML page    → adapter extracts + ranks metadata/image candidates
 * Returns a structured result; never throws.
 */
export async function resolveProduct(rawUrl: string, opts: ResolveOptions = {}): Promise<ProductResolution> {
  const allowLocal = opts.allowLocal ?? false;
  const checkRobots = opts.checkRobots ?? !allowLocal;

  const v = validateUrl(rawUrl, allowLocal);
  if (!v.ok) return { ok: false, candidates: [], reason: v.reason, errorKind: v.kind };

  if (checkRobots) {
    const allowed = await robotsAllows(v.url);
    if (!allowed) {
      return {
        ok: false,
        candidates: [],
        reason: 'This site disallows automated fetching (robots.txt). Try uploading the image instead.',
        errorKind: 'blocked',
      };
    }
  }

  let res;
  try {
    res = await safeFetch(v.url.toString(), { timeoutMs: 8000, maxBytes: 4 * 1024 * 1024 });
  } catch (err) {
    if (err instanceof FetchError) {
      return {
        ok: false,
        candidates: [],
        reason: err.kind === 'timeout' ? 'The page took too long to respond.' : 'Could not reach that address.',
        errorKind: err.kind,
      };
    }
    return { ok: false, candidates: [], reason: 'Unexpected error fetching the page.', errorKind: 'server-error' };
  }

  if (res.status === 404) {
    return { ok: false, candidates: [], reason: 'That page was not found (404).', errorKind: 'not-found' };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      candidates: [],
      reason: 'That page blocked access (login or anti-bot). Try uploading the image instead.',
      errorKind: 'blocked',
    };
  }
  if (res.status >= 400) {
    return { ok: false, candidates: [], reason: `The server returned an error (${res.status}).`, errorKind: 'server-error' };
  }

  const ct = res.contentType;

  if (ct.startsWith('image/')) {
    return {
      ok: true,
      resolvedUrl: res.finalUrl,
      candidates: [{ url: res.finalUrl, score: 120, source: 'direct' }],
    };
  }

  if (ct.includes('html') || ct.includes('xml') || ct === '') {
    const html = new TextDecoder().decode(res.body);
    const { title, candidates } = pickAdapter(v.url).extract(html, res.finalUrl);
    if (candidates.length === 0) {
      return {
        ok: false,
        resolvedUrl: res.finalUrl,
        candidates: [],
        reason: 'No usable product image was found on that page.',
        errorKind: 'no-images',
      };
    }
    return { ok: true, resolvedUrl: res.finalUrl, candidates, ...(title ? { title } : {}) };
  }

  return {
    ok: false,
    resolvedUrl: res.finalUrl,
    candidates: [],
    reason: `Unsupported content type (${ct || 'unknown'}).`,
    errorKind: 'unsupported-content',
  };
}
