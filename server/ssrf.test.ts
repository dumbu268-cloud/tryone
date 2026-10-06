import { describe, it, expect } from 'vitest';
import { validateUrl, isPrivateHost } from './ssrf';

describe('validateUrl', () => {
  it('accepts public https URLs', () => {
    const r = validateUrl('https://example.com/p/1', false);
    expect(r.ok).toBe(true);
  });

  it('rejects non-URLs and non-http protocols', () => {
    expect(validateUrl('not a url', false)).toMatchObject({ ok: false, kind: 'invalid-url' });
    expect(validateUrl('ftp://example.com', false)).toMatchObject({ ok: false, kind: 'invalid-url' });
    expect(validateUrl('', false)).toMatchObject({ ok: false, kind: 'invalid-url' });
  });

  it('blocks private hosts in production but allows them in dev', () => {
    expect(validateUrl('http://localhost:5173/x', false)).toMatchObject({ ok: false, kind: 'blocked' });
    expect(validateUrl('http://localhost:5173/x', true).ok).toBe(true);
    expect(validateUrl('http://192.168.1.5/x', false)).toMatchObject({ ok: false, kind: 'blocked' });
  });
});

describe('isPrivateHost', () => {
  it('flags loopback and private ranges', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.0.1', '172.16.0.1', '169.254.1.1', 'db.internal']) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  it('allows public hosts', () => {
    for (const h of ['example.com', 'cdn.shop.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});
