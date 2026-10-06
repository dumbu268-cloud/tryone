// Product resolution contracts (client side). The actual cross-origin fetching
// + HTML parsing happens in the same-origin proxy (Vite middleware / server),
// because browser CORS blocks reading arbitrary pages and taints canvases from
// cross-origin images. This interface is the swap seam: HttpProductResolver
// talks to the proxy today; a different backend could implement it later.

export type CandidateSource = 'og' | 'twitter' | 'json-ld' | 'link' | 'img' | 'direct';

export interface ImageCandidate {
  /** Absolute image URL (to be fetched via the image proxy). */
  url: string;
  /** Higher = more likely to be the main product image. */
  score: number;
  source: CandidateSource;
  width?: number;
  height?: number;
  alt?: string;
}

export interface ProductResolution {
  ok: boolean;
  /** Page/product title when available. */
  title?: string;
  /** The resolved page URL (after redirects), for display. */
  resolvedUrl?: string;
  /** Ranked image candidates (best first). Empty when ok is false. */
  candidates: ImageCandidate[];
  /** Human-readable failure reason when ok is false. */
  reason?: string;
  /** Machine-readable error kind for UI branching. */
  errorKind?: ResolveErrorKind;
}

export type ResolveErrorKind =
  | 'invalid-url'
  | 'blocked'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'no-images'
  | 'unsupported-content'
  | 'server-error';

export interface ProductResolver {
  resolve(url: string): Promise<ProductResolution>;
}

/** Build the same-origin proxy URL for fetching a (cross-origin) image into a canvas. */
export function proxiedImageUrl(imageUrl: string): string {
  return `/api/image?url=${encodeURIComponent(imageUrl)}`;
}
