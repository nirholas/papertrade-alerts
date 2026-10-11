import { describe, expect, it } from 'vitest';
import { fillOrigin, publicOrigin, serveDiscovery, ORIGIN_TOKEN } from '../src/discovery.js';
import type { Env } from '../src/types.js';
import { readFileSync } from 'node:fs';

describe('discovery files', () => {
  it('every static discovery file carries the origin token and no hardcoded host', () => {
    for (const f of ['public/index.html', 'public/robots.txt', 'public/sitemap.xml', 'public/.well-known/security.txt']) {
      const body = readFileSync(f, 'utf8');
      expect(body, f).toContain(ORIGIN_TOKEN);
      expect(body, f).not.toMatch(/papertrade-alerts\.(pages|workers)\.dev/);
    }
  });

  it('uses PUBLIC_ORIGIN when set, else the request origin', () => {
    expect(publicOrigin({}, 'https://papertrade-alerts.someone.workers.dev/robots.txt')).toBe('https://papertrade-alerts.someone.workers.dev');
    expect(publicOrigin({ PUBLIC_ORIGIN: 'https://alerts.example.com/' }, 'https://x.workers.dev/')).toBe('https://alerts.example.com');
    expect(fillOrigin(`a ${ORIGIN_TOKEN}/x ${ORIGIN_TOKEN}/y`, 'https://h')).toBe('a https://h/x https://h/y');
  });

  it('serves the asset with the origin filled in', async () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    const env = { ASSETS: { fetch: async () => new Response(sitemap, { headers: { 'content-type': 'application/xml' } }) } } as unknown as Env;
    const res = await serveDiscovery(new Request('https://alerts.example.org/sitemap.xml'), env, '/sitemap.xml');
    const body = await res.text();
    expect(res.headers.get('content-type')).toBe('application/xml');
    expect(body).toContain('<loc>https://alerts.example.org/</loc>');
    expect(body).not.toContain(ORIGIN_TOKEN);
  });
});

describe('generated docs', () => {
  it('emit origin tokens, no hardcoded host, md twins and a search index', () => {
    for (const f of ['public/llms.txt', 'public/llms-full.txt', 'public/docs/index.html', 'public/docs/mcp.html', 'public/docs/mcp.md', 'public/sitemap.xml']) {
      const body = readFileSync(f, 'utf8');
      expect(body, f).toContain(ORIGIN_TOKEN);
      expect(body, f).not.toMatch(/ninabrekkerese/);
    }
    const index = JSON.parse(readFileSync('public/docs/search-index.json', 'utf8')) as Array<{ title: string; url: string; text: string }>;
    expect(index.length).toBeGreaterThanOrEqual(11);
    expect(index.every((p) => p.text.length > 50)).toBe(true);
  });
});

describe('framable landing page', () => {
  it('replaces frame-ancestors none with the OS allow list on the landing page only', async () => {
    const csp = "default-src 'self'; frame-ancestors 'none'; form-action 'self'";
    const env = { ASSETS: { fetch: async () => new Response('<html>__ORIGIN__</html>', { headers: { 'content-security-policy': csp } }) } } as unknown as Env;
    const res = await serveDiscovery(new Request('https://a.example/'), env, '/index.html');
    const out = res.headers.get('content-security-policy') ?? '';
    expect(out).toContain("frame-ancestors 'self' https://papertrade-os.pages.dev https://*.pages.dev");
    expect(out).not.toContain("'none'");
    expect(out.split(',')).toHaveLength(1);
    const docs = await serveDiscovery(new Request('https://a.example/docs/'), env, '/docs/');
    expect(docs.headers.get('content-security-policy')).toBe(csp);
  });
});
