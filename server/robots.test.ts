import { describe, it, expect } from 'vitest';
import { isPathAllowed } from './robots';

describe('isPathAllowed', () => {
  it('allows everything when there are no rules', () => {
    expect(isPathAllowed('', '/products/1')).toBe(true);
    expect(isPathAllowed('User-agent: *\n', '/products/1')).toBe(true);
  });

  it('honours a path-specific Disallow for the * group', () => {
    const txt = 'User-agent: *\nDisallow: /private';
    expect(isPathAllowed(txt, '/private/page')).toBe(false);
    expect(isPathAllowed(txt, '/products/1')).toBe(true);
  });

  it('treats Disallow: / as block-all', () => {
    expect(isPathAllowed('User-agent: *\nDisallow: /', '/anything')).toBe(false);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const txt = 'User-agent: *\nDisallow: /p\nAllow: /p/public';
    expect(isPathAllowed(txt, '/p/public/item')).toBe(true);
    expect(isPathAllowed(txt, '/p/secret')).toBe(false);
  });

  it('ignores rules for other user-agents', () => {
    const txt = 'User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin';
    expect(isPathAllowed(txt, '/products/1')).toBe(true);
    expect(isPathAllowed(txt, '/admin/x')).toBe(false);
  });
});
