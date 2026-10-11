import type { Env } from './types.js';

/**
 * Same-origin read proxy for the Papertrade API (exchange.papertrade.xyz sends no CORS headers).
 * Mounted at /api/papertrade/*. Read-only: the alerting service never forwards signed intents.
 */
const UPSTREAM = 'https://exchange.papertrade.xyz';
const GET_PREFIXES = ['/state/', '/query/', '/queue-rank/', '/relayer/health'];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function proxyPapertrade(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, OPTIONS' } });
  if (request.method !== 'GET' || !GET_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) {
    return json(404, { code: 'not_proxied', message: `${request.method} ${path} is not part of the read-only Papertrade proxy.` });
  }
  const url = new URL(request.url);
  let upstream: Response;
  try {
    upstream = await fetch(`${(env.PAPERTRADE_API_URL ?? UPSTREAM).replace(/\/+$/, '')}${path}${url.search}`, {
      headers: { accept: request.headers.get('accept') ?? 'application/json', 'x-papertrade-build': 'papertrade-alerts/0.1' },
      signal: request.signal,
    });
  } catch (err) {
    return json(502, { code: 'upstream_unreachable', message: `Papertrade API did not respond: ${err instanceof Error ? err.message : String(err)}` });
  }
  const out = new Headers();
  for (const h of ['content-type', 'retry-after', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', path === '/state/user/live' ? 'no-store' : 'public, max-age=10');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
