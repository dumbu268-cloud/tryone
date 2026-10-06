import type { CandidateSource } from '../src/core/product/ProductResolver';

// Deterministic HTML metadata extraction (no DOM, no deps). Pulls image
// candidates from OpenGraph, Twitter cards, JSON-LD, <link rel=image_src>, and
// <img> tags. Regex-based: good enough for metadata, resilient to malformed HTML.

export interface RawCandidate {
  url: string;
  source: CandidateSource;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ParsedPage {
  title?: string;
  candidates: RawCandidate[];
}

export function parseHtml(html: string): ParsedPage {
  const candidates: RawCandidate[] = [];
  const metas = extractMetaTags(html);

  const metaByKey = (keys: string[]): string[] =>
    metas.filter((m) => keys.includes(m.key)).map((m) => m.content);

  for (const u of metaByKey(['og:image', 'og:image:url', 'og:image:secure_url'])) {
    candidates.push({ url: u, source: 'og' });
  }
  // Attach og:image:width/height to the last og candidate when present.
  const ogW = Number(metaByKey(['og:image:width'])[0]);
  const ogH = Number(metaByKey(['og:image:height'])[0]);
  const lastOg = [...candidates].reverse().find((c) => c.source === 'og');
  if (lastOg && Number.isFinite(ogW) && Number.isFinite(ogH)) {
    lastOg.width = ogW;
    lastOg.height = ogH;
  }

  for (const u of metaByKey(['twitter:image', 'twitter:image:src'])) {
    candidates.push({ url: u, source: 'twitter' });
  }

  for (const u of extractLinkImageSrc(html)) candidates.push({ url: u, source: 'link' });
  for (const u of extractJsonLdImages(html)) candidates.push({ url: u, source: 'json-ld' });
  for (const img of extractImgTags(html)) candidates.push({ ...img, source: 'img' });

  return { title: extractTitle(html, metas), candidates };
}

interface MetaTag {
  key: string;
  content: string;
}

function extractMetaTags(html: string): MetaTag[] {
  const out: MetaTag[] = [];
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase();
    const content = attr(tag, 'content');
    if (key && content) out.push({ key, content: decodeEntities(content) });
  }
  return out;
}

function extractLinkImageSrc(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const rel = attr(m[0], 'rel')?.toLowerCase();
    const href = attr(m[0], 'href');
    if (href && (rel === 'image_src' || rel === 'apple-touch-icon')) out.push(decodeEntities(href));
  }
  return out;
}

function extractImgTags(html: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 60) {
    const tag = m[0];
    const src = attr(tag, 'src') ?? attr(tag, 'data-src');
    if (!src) continue;
    const w = Number(attr(tag, 'width'));
    const h = Number(attr(tag, 'height'));
    out.push({
      url: decodeEntities(src),
      source: 'img',
      ...(Number.isFinite(w) && w > 0 ? { width: w } : {}),
      ...(Number.isFinite(h) && h > 0 ? { height: h } : {}),
      ...(attr(tag, 'alt') ? { alt: decodeEntities(attr(tag, 'alt')!) } : {}),
    });
  }
  return out;
}

function extractJsonLdImages(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      collectJsonLdImages(JSON.parse(m[1]!.trim()), out);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

function collectJsonLdImages(node: unknown, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdImages(n, out);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as unknown as Record<string, unknown>;
    const img = obj.image;
    if (typeof img === 'string') out.push(img);
    else if (Array.isArray(img)) for (const i of img) if (typeof i === 'string') out.push(i);
    else if (img && typeof img === 'object') {
      const u = (img as { url?: unknown }).url;
      if (typeof u === 'string') out.push(u);
    }
    for (const v of Object.values(obj)) if (v && typeof v === 'object') collectJsonLdImages(v, out);
  }
}

function extractTitle(html: string, metas: MetaTag[]): string | undefined {
  const og = metas.find((m) => m.key === 'og:title')?.content;
  if (og) return og;
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]!.trim()) : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
