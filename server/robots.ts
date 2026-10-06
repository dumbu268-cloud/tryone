import { safeFetch } from './fetchSafe';

// Best-effort robots.txt check for the wildcard (*) user-agent. Fail-open: if
// robots.txt is missing or unparseable, we proceed (this is a single
// user-initiated preview fetch, not crawling). We DO honour an explicit
// disallow of the requested path.

export async function robotsAllows(url: URL): Promise<boolean> {
  try {
    const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
    const res = await safeFetch(robotsUrl, {
      timeoutMs: 4000,
      maxBytes: 512 * 1024,
      accept: 'text/plain',
    });
    if (res.status !== 200 || !res.contentType.includes('text')) return true;
    const txt = new TextDecoder().decode(res.body);
    return isPathAllowed(txt, url.pathname || '/');
  } catch {
    return true; // fail open
  }
}

/** Longest-match Allow/Disallow for the `*` group. */
export function isPathAllowed(robotsTxt: string, path: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let inStar = false;
  let sawGroup = false;
  const rules: Array<{ allow: boolean; path: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = field?.toLowerCase().trim();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      // A new group starts; '*' groups are what we honour.
      if (value === '*') {
        inStar = true;
        sawGroup = true;
      } else if (sawGroup && inStar) {
        inStar = false; // left the star group
      } else {
        inStar = false;
      }
    } else if (inStar && (key === 'disallow' || key === 'allow')) {
      rules.push({ allow: key === 'allow', path: value });
    }
  }

  let decision = true;
  let bestLen = -1;
  for (const r of rules) {
    if (r.path === '') continue; // empty Disallow = allow all
    if (path.startsWith(r.path) && r.path.length > bestLen) {
      bestLen = r.path.length;
      decision = r.allow;
    }
  }
  return decision;
}
