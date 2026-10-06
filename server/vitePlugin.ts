import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveProduct } from './resolve';
import { proxyImage } from './imageProxy';

// Mounts the product resolver + image proxy as same-origin dev endpoints so the
// browser can read cross-origin images into a canvas (no CORS taint). This is
// the "minimum necessary backend": it rides inside the Vite dev server — no
// extra process. For a public deployment, re-mount these handlers on a real
// server with allowLocal=false + checkRobots=true.

export interface ApiPluginOptions {
  allowLocal?: boolean;
}

export function tryoneApiPlugin(options: ApiPluginOptions = {}): Plugin {
  const allowLocal = options.allowLocal ?? true;
  return {
    name: 'tryone-api',
    configureServer(server) {
      server.middlewares.use('/api/resolve', (req, res) => {
        void handleResolve(req, res, allowLocal);
      });
      server.middlewares.use('/api/image', (req, res) => {
        void handleImage(req, res, allowLocal);
      });
    },
  };
}

async function handleResolve(req: IncomingMessage, res: ServerResponse, allowLocal: boolean): Promise<void> {
  try {
    const url = getQuery(req, 'url');
    const out = await resolveProduct(url, { allowLocal, checkRobots: !allowLocal });
    sendJson(res, 200, out);
  } catch {
    sendJson(res, 500, {
      ok: false,
      candidates: [],
      reason: 'Unexpected server error.',
      errorKind: 'server-error',
    });
  }
}

async function handleImage(req: IncomingMessage, res: ServerResponse, allowLocal: boolean): Promise<void> {
  const url = getQuery(req, 'url');
  const out = await proxyImage(url, { allowLocal });
  if (out.ok) {
    res.statusCode = 200;
    res.setHeader('content-type', out.contentType);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, max-age=300');
    res.end(Buffer.from(out.body));
  } else {
    sendJson(res, out.status, { error: out.reason });
  }
}

function getQuery(req: IncomingMessage, name: string): string {
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    return u.searchParams.get(name) ?? '';
  } catch {
    return '';
  }
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}
