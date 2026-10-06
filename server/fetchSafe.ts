// Bounded fetch: timeout, response size cap, identifying User-Agent. This is a
// polite single-shot preview fetch (like a link unfurl) — NOT a crawler, and it
// does NOT attempt to bypass auth, CAPTCHAs, or anti-bot defenses.

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

export class FetchError extends Error {
  kind: 'timeout' | 'network';
  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
}

const UA = 'TryOneBot/0.1 (+virtual-try-on garment preview)';

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: opts.accept ?? 'text/html,application/xhtml+xml,image/*,*/*',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError') {
      throw new FetchError('timeout', 'The request timed out.');
    }
    throw new FetchError('network', 'Could not reach that address.');
  }

  try {
    const body = await readCapped(res, maxBytes);
    return {
      status: res.status,
      finalUrl: res.url || url,
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchError('network', 'The resource is too large.');
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
