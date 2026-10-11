import { beforeEach, describe, expect, it } from 'vitest';
import { handleMcpRequest, validateArgs, MAX_BATCH, MAX_BODY_BYTES, type JsonSchema } from '../src/mcp.js';
import { mcpServer, type McpContext } from '../src/mcp-tools.js';
import { resetStorageCache, isStorageUnavailable, UNAVAILABLE_MESSAGE } from '../src/degrade.js';
import { BUDGETS, memoryAllow, resetRateLimits } from '../src/ratelimit.js';
import { isPrivateHost, validateTarget, TargetError } from '../src/channels/index.js';
import { agentCard, apiCatalog, serverCard } from '../src/discovery-cards.js';
import { openApiDocument } from '../src/openapi.js';
import type { Env } from '../src/types.js';

const brokenDb = { prepare: () => ({ first: async () => { throw new Error('D1_ERROR: no such table: kv: SQLITE_ERROR'); } }) };
const env = { DB: brokenDb } as unknown as Env;
const ctx: McpContext = { env, client: 'test-client', bearer: null };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handleMcpRequest(new Request('https://x.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), mcpServer, ctx);
const call = (name: string, args: Record<string, unknown> = {}) => post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.json() as Promise<any>);

beforeEach(() => { resetStorageCache(); resetRateLimits(); });

describe('mcp protocol', () => {
  it('negotiates a supported protocol version and falls back otherwise', async () => {
    const ok = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })).json() as any;
    expect(ok.result.protocolVersion).toBe('2024-11-05');
    expect(ok.result.capabilities.tools.listChanged).toBe(false);
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(((await res.json()) as any).result.protocolVersion).toBe('2025-06-18');
  });

  it('answers notifications with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('lists ten tools, each with schemas and annotations', async () => {
    const body = (await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()) as any;
    expect(body.result.tools).toHaveLength(10);
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema.type).toBe('object');
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('uses JSON-RPC error codes for protocol faults', async () => {
    expect(((await (await post('{nope')).json()) as any).error.code).toBe(-32700);
    expect(((await (await post({ jsonrpc: '2.0', id: 1, method: 'nope' })).json()) as any).error.code).toBe(-32601);
    expect(((await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json()) as any).error.code).toBe(-32602);
    expect(((await (await post({ id: 1 })).json()) as any).error.code).toBe(-32600);
  });

  it('handles batches and caps their size', async () => {
    const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])).json() as any[];
    expect(batch.map((b) => b.id)).toEqual([1, 2]);
    const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    expect((await post(big)).status).toBe(400);
  });

  it('rejects oversized bodies', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MAX_BODY_BYTES) } });
    expect(res.status).toBe(413);
  });

  it('answers as one SSE message when only event-stream is accepted', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { accept: 'text/event-stream' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toMatch(/^event: message\ndata: \{.*"id":1/);
  });

  it('handles CORS preflight, GET and DELETE per the transport rules', async () => {
    const opt = await handleMcpRequest(new Request('https://x.test/mcp', { method: 'OPTIONS' }), mcpServer, ctx);
    expect(opt.status).toBe(204);
    expect(opt.headers.get('access-control-allow-origin')).toBe('*');
    expect(opt.headers.get('access-control-allow-headers')).toMatch(/Authorization/i);
    const sse = await handleMcpRequest(new Request('https://x.test/mcp', { headers: { accept: 'text/event-stream' } }), mcpServer, ctx);
    expect(sse.status).toBe(405);
    expect(sse.headers.get('allow')).toContain('POST');
    const info = await handleMcpRequest(new Request('https://x.test/mcp'), mcpServer, ctx);
    expect(info.status).toBe(200);
    expect(((await info.json()) as any).name).toBeTruthy();
    expect((await handleMcpRequest(new Request('https://x.test/mcp', { method: 'DELETE' }), mcpServer, ctx)).status).toBe(405);
  });
});

describe('mcp tools without a database', () => {
  it('serves discovery tools while storage is down', async () => {
    const types = await call('list_alert_types');
    expect(types.result.isError).toBeFalsy();
    expect(types.result.structuredContent.alertTypes.length).toBeGreaterThan(5);
    const status = await call('get_service_status');
    expect(status.result.structuredContent.ready).toBe(false);
    expect(status.result.structuredContent.storage).toBe('not_ready');
  });

  it('tells the caller storage is not ready for account tools', async () => {
    const r = await call('create_subscription');
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe(UNAVAILABLE_MESSAGE);
  });

  it('validates destinations with the SSRF guard and never echoes secrets', async () => {
    const bad = await call('validate_destination', { kind: 'webhook', url: 'https://10.0.0.5/hook' });
    expect(bad.result.structuredContent.valid).toBe(false);
    const http = await call('validate_destination', { kind: 'webhook', url: 'http://example.com/hook' });
    expect(http.result.structuredContent.valid).toBe(false);
    const ok = await call('validate_destination', { kind: 'discord', url: 'https://discord.com/api/webhooks/123456/abcDEF-secret_token' });
    expect(ok.result.structuredContent.valid).toBe(true);
    expect(JSON.stringify(ok)).not.toContain('abcDEF-secret_token');
  });

  it('rejects malformed arguments as invalid params', async () => {
    const r = await call('preview_wallet_alerts', { address: 'not-an-address' });
    expect(r.error?.code === -32602 || r.result?.isError === true).toBe(true);
  });
});

describe('validateArgs', () => {
  const schema: JsonSchema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', maxLength: 3 }, n: { type: 'number', minimum: 1 } } };
  it('reports missing, extra, mistyped and out-of-range values', () => {
    expect(validateArgs(schema, {})).not.toEqual([]);
    expect(validateArgs(schema, { a: 'x', z: 1 })).not.toEqual([]);
    expect(validateArgs(schema, { a: 5 })).not.toEqual([]);
    expect(validateArgs(schema, { a: 'toolong' })).not.toEqual([]);
    expect(validateArgs(schema, { a: 'x', n: 0 })).not.toEqual([]);
    expect(validateArgs(schema, { a: 'x', n: 2 })).toEqual([]);
  });
});

describe('ssrf guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0', 'localhost', 'db.internal', 'printer.local', 'intranet', '[::1]', '[fd00::1]'])('blocks %s', (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it.each(['example.com', 'hooks.slack.com', '93.184.216.34'])('allows %s', (h) => {
    expect(isPrivateHost(h)).toBe(false);
  });
  it('refuses credentials, http and decimal-encoded loopback', () => {
    const e = {} as Env;
    expect(() => validateTarget('webhook', 'https://u:p@example.com/x', e)).toThrow(TargetError);
    expect(() => validateTarget('webhook', 'http://example.com/x', e)).toThrow(TargetError);
    expect(() => validateTarget('webhook', 'https://2130706433/x', e)).toThrow(TargetError);
    expect(validateTarget('webhook', 'https://example.com/x', e)).toBe('https://example.com/x');
  });
});

describe('degradation and limits', () => {
  it('recognises the D1 quota and missing schema errors', () => {
    expect(isStorageUnavailable(new Error('D1_ERROR: no such table: accounts: SQLITE_ERROR'))).toBe(true);
    expect(isStorageUnavailable(new Error('D1 DB reached its daily limit: exceeded free tier row writes, code: 7500'))).toBe(true);
    expect(isStorageUnavailable(new Error('boom'))).toBe(false);
  });
  it('enforces per-bucket windows per client and recovers', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < BUDGETS.write.limit; i++) expect(memoryAllow('a', 'write', t0).ok).toBe(true);
    const blocked = memoryAllow('a', 'write', t0 + 1);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(memoryAllow('b', 'write', t0).ok).toBe(true);
    expect(memoryAllow('a', 'write', t0 + BUDGETS.write.windowMs + 1).ok).toBe(true);
  });
});

describe('discovery documents', () => {
  it('derive from the live tool registry and use the given origin', () => {
    const origin = 'https://alerts.example.org';
    const card = serverCard(mcpServer, origin) as any;
    expect(JSON.stringify(card)).toContain(`${origin}/mcp`);
    expect(card.tools.map((t: any) => t.name).sort()).toEqual(mcpServer.tools.map((t) => t.name).sort());
    const a2a = agentCard(mcpServer, origin) as any;
    expect(a2a.skills).toHaveLength(mcpServer.tools.length);
    const catalog = JSON.stringify(apiCatalog(origin));
    for (const path of ['/openapi.json', '/mcp', '/docs/', '/llms.txt']) expect(catalog).toContain(`${origin}${path}`);
  });
  it('documents /mcp in the OpenAPI document', () => {
    const doc = openApiDocument('https://alerts.example.org') as any;
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths['/mcp']).toBeTruthy();
  });
});

describe('mcp ignores the operator-only insecure webhook switch', () => {
  const row = { id: 'acc_1', created_at: 1, protocol_rules: '{}', n: 0, x: 1 };
  const stmt = { bind: () => stmt, first: async () => row, run: async () => ({}), all: async () => ({ results: [] }) };
  const db = { prepare: () => stmt };
  const insecure = { DB: db, ALLOW_INSECURE_WEBHOOKS: 'true' } as unknown as Env;
  it.each(['https://10.0.0.1/x', 'http://example.com/x', 'https://localhost/x'])('add_destination refuses %s even when the deployment allows insecure webhooks', async (url) => {
    const res = await handleMcpRequest(new Request('https://x.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_destination', arguments: { kind: 'webhook', url } } }) }), mcpServer, { env: insecure, client: 'c', bearer: 'ptal_' + 'a'.repeat(30) });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/https|public host/);
  });
});
