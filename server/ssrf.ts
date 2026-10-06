import type { ResolveErrorKind } from '../src/core/product/ProductResolver';

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string; kind: ResolveErrorKind };

/**
 * Validate a user-supplied URL. In production (allowLocal=false) we also block
 * private/loopback hosts to avoid SSRF; in dev we allow localhost so local test
 * fixtures work.
 */
export function validateUrl(raw: string, allowLocal: boolean): UrlCheck {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'Please enter a URL.', kind: 'invalid-url' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That does not look like a valid URL.', kind: 'invalid-url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) URLs are supported.', kind: 'invalid-url' };
  }

  if (!allowLocal && isPrivateHost(url.hostname)) {
    return { ok: false, reason: 'That address is not allowed.', kind: 'blocked' };
  }

  return { ok: true, url };
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}
