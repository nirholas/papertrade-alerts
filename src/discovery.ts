import type { Env } from './types.js';

/** Token in the static discovery files that is replaced with the deployment's public origin. */
export const ORIGIN_TOKEN = '__ORIGIN__';

/** Paths served from assets with the origin filled in, so canonical URLs are right on any domain. */
export const DISCOVERY_PATHS: Record<string, string> = {
  '/': '/index.html',
  '/index.html': '/index.html',
  '/robots.txt': '/robots.txt',
  '/sitemap.xml': '/sitemap.xml',
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

export async function serveDiscovery(request: Request, env: Env, assetPath: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(assetPath, request.url));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('cache-control', 'public, max-age=300');
  return new Response(fillOrigin(await asset.text(), publicOrigin(env, request.url)), { status: 200, headers });
}
