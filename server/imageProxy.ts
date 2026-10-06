import { validateUrl } from './ssrf';
import { safeFetch, FetchError } from './fetchSafe';

export type ImageProxyResult =
  | { ok: true; contentType: string; body: Uint8Array }
  | { ok: false; status: number; reason: string };

export interface ImageProxyOptions {
  allowLocal?: boolean;
  maxBytes?: number;
}

/**
 * Fetch an image server-side and return its bytes so the browser can load it
 * same-origin (no CORS taint → canvas getImageData works for the preparer).
 */
export async function proxyImage(rawUrl: string, opts: ImageProxyOptions = {}): Promise<ImageProxyResult> {
  const v = validateUrl(rawUrl, opts.allowLocal ?? false);
  if (!v.ok) return { ok: false, status: 400, reason: v.reason };

  let res;
  try {
    res = await safeFetch(v.url.toString(), {
      timeoutMs: 10000,
      maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
      accept: 'image/*',
    });
  } catch (err) {
    const reason = err instanceof FetchError && err.kind === 'timeout' ? 'Image timed out.' : 'Could not fetch image.';
    return { ok: false, status: 502, reason };
  }

  if (res.status >= 400) return { ok: false, status: res.status, reason: `Image fetch failed (${res.status}).` };

  let ct = res.contentType.split(';')[0]!.trim();
  // Some hosts mislabel; accept common image types + svg.
  if (!ct.startsWith('image/')) {
    if (ct === 'application/octet-stream' || ct === '') ct = sniff(res.body);
    if (!ct.startsWith('image/')) {
      return { ok: false, status: 415, reason: 'That URL did not return an image.' };
    }
  }
  return { ok: true, contentType: ct, body: res.body };
}

/** Minimal magic-byte sniff for the common formats. */
function sniff(b: Uint8Array): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 11 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = new TextDecoder().decode(b.slice(0, 64)).trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return 'application/octet-stream';
}
