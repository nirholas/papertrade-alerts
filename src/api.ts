import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
  console.error('unhandled', err instanceof Error ? err.stack : err);
  return c.json({ code: 'internal_error', message: 'Something went wrong on our side. Try again in a minute.' }, 500);
});

app.notFound((c) => c.json({ code: 'not_found', message: `${c.req.method} ${new URL(c.req.url).pathname} does not exist. See /openapi.json.` }, 404));

app.get('/healthz', async (c) => {
  await c.env.DB.prepare('SELECT 1').first();
  return c.json({ ok: true });
});
app.get('/openapi.json', (c) => c.json(openApiDocument(publicOrigin(c.env, c.req.url))));
for (const [path, asset] of Object.entries(DISCOVERY_PATHS)) app.get(path, (c) => serveDiscovery(c.req.raw, c.env, asset));

app.all('/api/papertrade/*', (c) => proxyPapertrade(c.req.raw, c.env, new URL(c.req.url).pathname.replace(/^\/api\/papertrade/, '') || '/'));

app.get('/api/status', async (c) => {
  const last = await c.env.DB.prepare(`SELECT value, updated_at FROM kv WHERE key = 'lasttick'`).first<{ value: string; updated_at: number }>();
  const channels = channelAvailability(c.env);
  return c.json({
    version: '0.1.0',
    channels,
    telegramBot: c.env.TELEGRAM_BOT_USERNAME ?? null,
    insecureWebhooks: c.env.ALLOW_INSECURE_WEBHOOKS === 'true',
    limits: { ...LIMITS, alertsPerHour: 60, ...RULE_LIMITS },
    lastTick: last ? { at: last.updated_at, ...(JSON.parse(last.value) as Record<string, unknown>) } : null,
  });
});

app.post('/api/telegram/webhook', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!c.env.TELEGRAM_BOT_TOKEN || !secret) return c.json({ code: 'telegram_disabled', message: 'Telegram is not configured on this deployment.' }, 503);
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(given, secret)) return c.json({ code: 'forbidden', message: 'Bad secret token.' }, 403);
  const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update || typeof update !== 'object') return c.json({ code: 'bad_request', message: 'Expected a Telegram update.' }, 400);
  const result = await processUpdate(c.env, update);
  return c.json({ ok: true, ...result });
});

app.post('/api/accounts', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const { account, token } = await createAccount(c.env, ip);
  return c.json({ accountId: account.id, token, notice: 'This token is shown once. Anyone holding it can manage this subscription.' }, 201);
});

const authed = new Hono<{ Bindings: Env; Variables: Vars }>();
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
  const account = c.get('account');
  const channel = await c.env.DB.prepare(`SELECT id, kind, target, secret FROM channels WHERE id = ? AND account_id = ?`)
    .bind(c.req.param('id'), account.id)
    .first<{ id: string; kind: ChannelKind; target: string; secret: string | null }>();
  if (!channel) throw new ApiError(404, 'not_found', 'No such channel.');
  const availability = channelAvailability(c.env).find((a) => a.kind === channel.kind);
  if (availability && !availability.enabled) throw new ApiError(503, 'channel_disabled', availability.reason ?? 'This channel is not configured.');
  const recent = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE account_id = ? AND type = 'test' AND created_at > ?`).bind(account.id, Date.now() - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 5) throw new ApiError(429, 'too_many_tests', 'Five test messages per minute is the limit. Wait a moment.');

  const now = Date.now();
  const alertId = newId('alt');
  const deliveryId = newId('dlv');
  const rendered: RenderedAlert = {
    id: alertId,
    type: 'test',
    severity: 'info',
    title: 'Papertrade Alerts test message',
    body: 'If you can read this, this channel is wired correctly. Real alerts will look like this.',
    fields: [{ name: 'Channel', value: channel.kind }],
    createdAt: now,
    data: { test: true, channelId: channel.id },
  };
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO alerts (id, account_id, watch_id, type, severity, dedupe_key, title, body, payload, suppressed, created_at) VALUES (?, ?, NULL, 'test', 'info', ?, ?, ?, ?, 0, ?)`)
      .bind(alertId, account.id, `test:${alertId}`, rendered.title, rendered.body, JSON.stringify({ fields: rendered.fields, url: null, data: rendered.data }), now),
    c.env.DB.prepare(`INSERT INTO deliveries (id, alert_id, channel_id, account_id, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`).bind(deliveryId, alertId, channel.id, account.id, now, now),
  ]);
  const result = await sendToChannel(c.env, channel, rendered, deliveryId);
  // A test is one-shot: a failure goes straight to the dead-letter view where it can be retried after fixing the channel.
  const outcome = nextState(0, result, Date.now(), 1);
  await c.env.DB.batch(outcomeStatements(c.env, { id: deliveryId, channel_id: channel.id }, outcome, Date.now()));
  return c.json({ ok: result.ok, status: result.status ?? null, error: result.error ?? null, deliveryId, alertId }, result.ok ? 200 : 502);
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
