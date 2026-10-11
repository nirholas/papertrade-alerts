import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import {
  addChannel,
  addWatch,
  ApiError,
  authenticate,
  createAccount,
  LIMITS,
  listChannels,
  listWatches,
  newLinkCode,
  removeChannel,
  removeWatch,
  sendTestMessage,
  updateWatchRules,
  type Account,
} from './accounts.js';
import { channelAvailability, sendToChannel, type RenderedAlert } from './channels/index.js';
import { backoffMs, MAX_ATTEMPTS, nextState, outcomeStatements } from './engine/delivery.js';
import { DEFAULT_PROTOCOL_RULES, LIMITS as RULE_LIMITS, normalizeProtocolRules, parseStoredProtocolRules, ValidationError } from './engine/rules.js';
import { newId, timingSafeEqual } from './lib/crypto.js';
import { openApiDocument } from './openapi.js';
import { proxyPapertrade } from './proxy.js';
import { processUpdate } from './telegram/commands.js';
import type { TelegramUpdate } from './telegram/parse.js';
import type { ChannelKind, Env } from './types.js';
import { DISCOVERY_PATHS, publicOrigin, serveDiscovery } from './discovery.js';
import { agentCard, apiCatalog, serverCard } from './discovery-cards.js';
import { isStorageUnavailable, storageReady, UNAVAILABLE_MESSAGE } from './degrade.js';
import { handleMcpRequest } from './mcp.js';
import { mcpServer } from './mcp-tools.js';
import { allow } from './ratelimit.js';

type Vars = { account: Account };
export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ code: err.code, message: err.message }, err.status as 400);
  if (err instanceof ValidationError) return c.json({ code: 'invalid_rules', message: err.message }, 400);
  if (isStorageUnavailable(err)) return c.json({ code: 'service_initializing', message: UNAVAILABLE_MESSAGE }, 503, { 'retry-after': '300' });
  console.error('unhandled', err instanceof Error ? err.stack : err);
  return c.json({ code: 'internal_error', message: 'Something went wrong on our side. Try again in a minute.' }, 500);
});

app.notFound((c) => c.json({ code: 'not_found', message: `${c.req.method} ${new URL(c.req.url).pathname} does not exist. See /openapi.json.` }, 404));

/** Routes that need the schema answer 503 with an explanation until it exists, instead of a 500 stack. */
const needsStorage = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  if (!(await storageReady(c.env))) return c.json({ code: 'service_initializing', message: UNAVAILABLE_MESSAGE }, 503, { 'retry-after': '300' });
  await next();
});

app.get('/healthz', async (c) => {
  if (!(await storageReady(c.env))) return c.json({ ok: false, database: 'not_ready', message: UNAVAILABLE_MESSAGE }, 503, { 'retry-after': '300' });
  return c.json({ ok: true, database: 'ready' });
});
app.get('/openapi.json', (c) => c.json(openApiDocument(publicOrigin(c.env, c.req.url))));
for (const [path, asset] of Object.entries(DISCOVERY_PATHS)) app.get(path, (c) => serveDiscovery(c.req.raw, c.env, asset));
app.get('/docs', (c) => serveDiscovery(c.req.raw, c.env, '/docs/'));
app.get('/docs/*', (c) => serveDiscovery(c.req.raw, c.env, new URL(c.req.url).pathname));

const jsonDoc = (c: { json: (body: object, status?: 200, headers?: Record<string, string>) => Response }, body: object, type = 'application/json; charset=utf-8') =>
  c.json(body, 200, { 'content-type': type, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
for (const path of ['/.well-known/mcp/server-card.json', '/.well-known/mcp.json']) app.get(path, (c) => jsonDoc(c, serverCard(mcpServer, publicOrigin(c.env, c.req.url))));
for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) app.get(path, (c) => jsonDoc(c, agentCard(mcpServer, publicOrigin(c.env, c.req.url))));
app.get('/.well-known/api-catalog', (c) => jsonDoc(c, apiCatalog(publicOrigin(c.env, c.req.url)), 'application/linkset+json; charset=utf-8; profile="https://www.rfc-editor.org/info/rfc9727"'));

app.all('/mcp', (c) => {
  const client = c.req.header('cf-connecting-ip') ?? 'unknown';
  const auth = c.req.header('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  return handleMcpRequest(c.req.raw, mcpServer, { env: c.env, client, bearer }, async () => {
    const res = await allow(c.env, client, 'read');
    if (res.ok) return null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `Rate limit reached. Retry in ${res.retryAfterSec} seconds.` } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(res.retryAfterSec), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after' },
    });
  });
});

app.all('/api/papertrade/*', (c) => proxyPapertrade(c.req.raw, c.env, new URL(c.req.url).pathname.replace(/^\/api\/papertrade/, '') || '/'));

app.get('/api/status', async (c) => {
  const ready = await storageReady(c.env);
  const last = ready ? await c.env.DB.prepare(`SELECT value, updated_at FROM kv WHERE key = 'lasttick'`).first<{ value: string; updated_at: number }>() : null;
  const channels = channelAvailability(c.env);
  return c.json({
    version: '0.2.0',
    ready,
    notice: ready ? null : UNAVAILABLE_MESSAGE,
    channels,
    telegramBot: c.env.TELEGRAM_BOT_USERNAME ?? null,
    insecureWebhooks: c.env.ALLOW_INSECURE_WEBHOOKS === 'true',
    limits: { ...LIMITS, alertsPerHour: 60, ...RULE_LIMITS },
    lastTick: last ? { at: last.updated_at, ...(JSON.parse(last.value) as Record<string, unknown>) } : null,
  });
});

app.post('/api/telegram/webhook', needsStorage, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!c.env.TELEGRAM_BOT_TOKEN || !secret) return c.json({ code: 'telegram_disabled', message: 'Telegram is not configured on this deployment.' }, 503);
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(given, secret)) return c.json({ code: 'forbidden', message: 'Bad secret token.' }, 403);
  const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update || typeof update !== 'object') return c.json({ code: 'bad_request', message: 'Expected a Telegram update.' }, 400);
  const result = await processUpdate(c.env, update);
  return c.json({ ok: true, ...result });
});

app.post('/api/accounts', needsStorage, async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const { account, token } = await createAccount(c.env, ip);
  return c.json({ accountId: account.id, token, notice: 'This token is shown once. Anyone holding it can manage this subscription.' }, 201);
});

const authed = new Hono<{ Bindings: Env; Variables: Vars }>();
authed.use('*', needsStorage);
authed.use('*', bodyLimit({ maxSize: 32 * 1024 }));
authed.use('*', async (c, next) => {
  c.set('account', await authenticate(c.env, c.req.header('authorization')));
  await next();
});

authed.get('/me', async (c) => {
  const account = c.get('account');
  const [watches, channels] = await Promise.all([listWatches(c.env, account.id), listChannels(c.env, account.id)]);
  return c.json({
    accountId: account.id,
    createdAt: account.created_at,
    watches,
    channels,
    protocolRules: parseStoredProtocolRules(account.protocol_rules),
    defaults: { protocolRules: DEFAULT_PROTOCOL_RULES },
  });
});

authed.delete('/me', async (c) => {
  await c.env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(c.get('account').id).run();
  return c.json({ ok: true });
});

authed.put('/protocol-rules', async (c) => {
  const body = await c.req.json().catch(() => null);
  const account = c.get('account');
  const rules = normalizeProtocolRules(body, parseStoredProtocolRules(account.protocol_rules));
  await c.env.DB.prepare(`UPDATE accounts SET protocol_rules = ? WHERE id = ?`).bind(JSON.stringify(rules), account.id).run();
  return c.json({ protocolRules: rules });
});

authed.post('/watches', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, 'bad_request', 'Expected a JSON body.');
  const { id, created } = await addWatch(c.env, c.get('account').id, body as { address: unknown });
  const watch = (await listWatches(c.env, c.get('account').id)).find((w) => w.id === id);
  return c.json({ watch, created }, created ? 201 : 200);
});

authed.patch('/watches/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, 'bad_request', 'Expected a JSON body.');
  return c.json({ watch: await updateWatchRules(c.env, c.get('account').id, c.req.param('id'), body) });
});

authed.delete('/watches/:id', async (c) => {
  if (!(await removeWatch(c.env, c.get('account').id, c.req.param('id')))) throw new ApiError(404, 'not_found', 'No such watch.');
  return c.json({ ok: true });
});

authed.post('/channels', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown; target?: unknown; label?: unknown } | null;
  if (!body) throw new ApiError(400, 'bad_request', 'Expected a JSON body.');
  if (body.kind === 'telegram') throw new ApiError(400, 'use_link', 'Telegram chats are linked with POST /api/telegram/link and the bot /start command.');
  const { id, secret } = await addChannel(c.env, c.get('account').id, body as { kind: unknown; target: unknown });
  const channel = (await listChannels(c.env, c.get('account').id)).find((ch) => ch.id === id);
  return c.json({ channel, secret, secretNotice: secret ? 'Shown once. Use it to verify the x-papertrade-alerts-signature header.' : null }, 201);
});

authed.patch('/channels/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
  if (body?.status !== 'active' && body?.status !== 'paused') throw new ApiError(400, 'bad_request', 'status must be "active" or "paused".');
  const res = await c.env.DB.prepare(`UPDATE channels SET status = ? WHERE id = ? AND account_id = ?`).bind(body.status, c.req.param('id'), c.get('account').id).run();
  if (!res.meta.changes) throw new ApiError(404, 'not_found', 'No such channel.');
  return c.json({ ok: true });
});

authed.delete('/channels/:id', async (c) => {
  if (!(await removeChannel(c.env, c.get('account').id, c.req.param('id')))) throw new ApiError(404, 'not_found', 'No such channel.');
  return c.json({ ok: true });
});

authed.post('/channels/:id/test', async (c) => {
  const result = await sendTestMessage(c.env, c.get('account').id, c.req.param('id'));
  return c.json(result, result.ok ? 200 : 502);
});

authed.post('/telegram/link', async (c) => {
  const availability = channelAvailability(c.env).find((a) => a.kind === 'telegram');
  if (!availability?.enabled) throw new ApiError(503, 'channel_disabled', availability?.reason ?? 'Telegram is not configured.');
  const { code, expiresAt } = await newLinkCode(c.env, c.get('account').id);
  const bot = c.env.TELEGRAM_BOT_USERNAME;
  return c.json({ code, expiresAt, command: `/start ${code}`, deepLink: bot ? `https://t.me/${bot}?start=${code}` : null });
});

interface AlertRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  payload: string;
  suppressed: number;
  created_at: number;
  watch_id: string | null;
  address: string | null;
}
interface DeliveryRow {
  id: string;
  alert_id: string;
  channel_id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  last_http_status: number | null;
  sent_at: number | null;
  kind: string;
  label: string | null;
}

authed.get('/alerts', async (c) => {
  const account = c.get('account');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30));
  const before = Number(c.req.query('before')) || Date.now() + 1;
  const { results: alerts } = await c.env.DB.prepare(
    `SELECT a.id, a.type, a.severity, a.title, a.body, a.payload, a.suppressed, a.created_at, a.watch_id, w.address
     FROM alerts a LEFT JOIN watches w ON w.id = a.watch_id
     WHERE a.account_id = ? AND a.created_at < ? ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(account.id, before, limit)
    .all<AlertRow>();
  const deliveries = alerts.length
    ? (
        await c.env.DB.prepare(
          `SELECT d.id, d.alert_id, d.channel_id, d.status, d.attempts, d.next_attempt_at, d.last_error, d.last_http_status, d.sent_at, ch.kind, ch.label
           FROM deliveries d JOIN channels ch ON ch.id = d.channel_id
           WHERE d.alert_id IN (${alerts.map(() => '?').join(',')}) ORDER BY d.created_at ASC`,
        )
          .bind(...alerts.map((a) => a.id))
          .all<DeliveryRow>()
      ).results
    : [];
  const byAlert = new Map<string, DeliveryRow[]>();
  for (const d of deliveries) byAlert.set(d.alert_id, [...(byAlert.get(d.alert_id) ?? []), d]);
  return c.json({
    alerts: alerts.map((a) => {
      const extra = JSON.parse(a.payload) as { fields?: unknown[]; url?: string | null };
      return {
        id: a.id,
        type: a.type,
        severity: a.severity,
        title: a.title,
        body: a.body,
        fields: extra.fields ?? [],
        url: extra.url ?? null,
        suppressed: a.suppressed === 1,
        createdAt: a.created_at,
        address: a.address,
        deliveries: (byAlert.get(a.id) ?? []).map((d) => ({
          id: d.id,
          channelId: d.channel_id,
          channelKind: d.kind,
          channelLabel: d.label,
          status: d.status,
          attempts: d.attempts,
          nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
          lastError: d.last_error,
          httpStatus: d.last_http_status,
          sentAt: d.sent_at,
        })),
      };
    }),
    nextBefore: alerts.length === limit ? alerts[alerts.length - 1].created_at : null,
    retryPolicy: { maxAttempts: MAX_ATTEMPTS, firstBackoffSeconds: backoffMs(1) / 1000 },
  });
});

authed.get('/deliveries/dead', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.alert_id, d.attempts, d.last_error, d.last_http_status, d.created_at, a.title, a.type, ch.kind, ch.label, ch.id AS channel_id
     FROM deliveries d JOIN alerts a ON a.id = d.alert_id JOIN channels ch ON ch.id = d.channel_id
     WHERE d.account_id = ? AND d.status = 'dead' ORDER BY d.created_at DESC LIMIT 100`,
  )
    .bind(c.get('account').id)
    .all<{ id: string; alert_id: string; attempts: number; last_error: string | null; last_http_status: number | null; created_at: number; title: string; type: string; kind: string; label: string | null; channel_id: string }>();
  return c.json({
    deliveries: results.map((r) => ({ id: r.id, alertId: r.alert_id, title: r.title, type: r.type, channelId: r.channel_id, channelKind: r.kind, channelLabel: r.label, attempts: r.attempts, lastError: r.last_error, httpStatus: r.last_http_status, createdAt: r.created_at })),
  });
});

authed.post('/deliveries/:id/retry', async (c) => {
  const res = await c.env.DB.prepare(`UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND account_id = ? AND status = 'dead'`)
    .bind(Date.now(), c.req.param('id'), c.get('account').id)
    .run();
  if (!res.meta.changes) throw new ApiError(404, 'not_found', 'No dead delivery with that id.');
  return c.json({ ok: true, note: 'Re-queued. It is sent on the next cron tick (within a minute).' });
});

app.route('/api', authed);
