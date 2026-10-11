import type { Env } from './types.js';

/** Token in the static discovery files that is replaced with the deployment's public origin. */
export const ORIGIN_TOKEN = '__ORIGIN__';

/** Paths served from assets with the origin filled in, so canonical URLs are right on any domain. */
export const DISCOVERY_PATHS: Record<string, string> = {
  '/': '/index.html',
  '/index.html': '/index.html',
  '/robots.txt': '/robots.txt',
  '/sitemap.xml': '/sitemap.xml',
  '/llms.txt': '/llms.txt',
  '/llms-full.txt': '/llms-full.txt',
  '/.well-known/security.txt': '/.well-known/security.txt',
};

/** `PUBLIC_ORIGIN` when set (a custom domain), else the origin the request arrived on. */
export function publicOrigin(env: Pick<Env, 'PUBLIC_ORIGIN'>, requestUrl: string): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  return new URL(requestUrl).origin;
}

export function fillOrigin(body: string, origin: string): string {
  return body.split(ORIGIN_TOKEN).join(origin);
}

/** Origins allowed to frame the product page: itself and the Papertrade OS desktop (any Pages host). */
export const FRAME_ANCESTORS = "frame-ancestors 'self' https://papertrade-os.pages.dev https://*.pages.dev";

/** Static `_headers` cannot subtract an inherited CSP reliably, so the framable page's CSP is set here. */
export function framableCsp(csp: string | null): string {
  const base = (csp ?? "default-src 'self'").split(',')[0];
  return base.replace(/frame-ancestors[^;]*/i, FRAME_ANCESTORS);
}

export async function serveDiscovery(request: Request, env: Env, assetPath: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(assetPath, request.url));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('cache-control', 'public, max-age=300');
  if (assetPath === '/index.html') headers.set('content-security-policy', framableCsp(headers.get('content-security-policy')));
  return new Response(fillOrigin(await asset.text(), publicOrigin(env, request.url)), { status: 200, headers });
}
