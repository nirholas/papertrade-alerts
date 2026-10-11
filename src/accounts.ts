import { isAddress } from 'viem';
import { newId, newManagementToken, randomBase64Url, sha256Hex } from './lib/crypto.js';
import { defaultRulesFor, normalizeWalletRules, parseStoredWalletRules, ValidationError } from './engine/rules.js';
import type { ChannelKind, Env, WalletRules, WatchRole } from './types.js';
import { channelAvailability, sendToChannel, validateTarget, type RenderedAlert } from './channels/index.js';
import { nextState, outcomeStatements } from './engine/delivery.js';

export const LIMITS = { watchesPerAccount: 25, channelsPerAccount: 6, accountsPerCreatorPerHour: 10 } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Account {
  id: string;
  created_at: number;
  protocol_rules: string;
}

export async function createAccount(env: Env, creator: string | null, now = Date.now()): Promise<{ account: Account; token: string }> {
  const creatorHash = creator ? (await sha256Hex(`creator:${creator}`)).slice(0, 32) : null;
  if (creatorHash) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE creator_hash = ? AND created_at > ?`).bind(creatorHash, now - 3_600_000).first<{ n: number }>();
    if ((row?.n ?? 0) >= LIMITS.accountsPerCreatorPerHour) throw new ApiError(429, 'too_many_accounts', 'Too many subscriptions were created from this network recently. Try again later.');
  }
  const token = newManagementToken();
  const id = newId('acc');
  await env.DB.prepare(`INSERT INTO accounts (id, token_hash, created_at, creator_hash, last_seen_at) VALUES (?, ?, ?, ?, ?)`).bind(id, await sha256Hex(token), now, creatorHash, now).run();
  return { account: { id, created_at: now, protocol_rules: '{}' }, token };
}

export async function authenticate(env: Env, header: string | null | undefined, now = Date.now()): Promise<Account> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith('ptal_') || token.length > 100) throw new ApiError(401, 'unauthorized', 'Missing or invalid management token.');
  const account = await env.DB.prepare(`SELECT id, created_at, protocol_rules FROM accounts WHERE token_hash = ?`).bind(await sha256Hex(token)).first<Account>();
  if (!account) throw new ApiError(401, 'unauthorized', 'That management token is not recognized. It may have been deleted.');
  await env.DB.prepare(`UPDATE accounts SET last_seen_at = ? WHERE id = ?`).bind(now, account.id).run();
  return account;
}

export function parseAddress(input: unknown): string {
  if (typeof input !== 'string' || !isAddress(input.trim(), { strict: false })) throw new ApiError(400, 'invalid_address', 'Enter a valid 0x wallet address (42 characters).');
  return input.trim().toLowerCase();
}

export interface WatchView {
  id: string;
  address: string;
  role: WatchRole;
  label: string | null;
  rules: WalletRules;
  createdAt: number;
  lastPolledAt: number | null;
  lastError: string | null;
  openPositions: number | null;
}

export async function listWatches(env: Env, accountId: string): Promise<WatchView[]> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.address, w.role, w.label, w.rules, w.created_at, s.polled_at, s.error, s.snapshot
     FROM watches w LEFT JOIN wallet_state s ON s.address = w.address
     WHERE w.account_id = ? ORDER BY w.created_at DESC`,
  )
    .bind(accountId)
    .all<{ id: string; address: string; role: WatchRole; label: string | null; rules: string; created_at: number; polled_at: number | null; error: string | null; snapshot: string | null }>();
  return results.map((r) => ({
    id: r.id,
    address: r.address,
    role: r.role,
    label: r.label,
    rules: parseStoredWalletRules(r.rules, r.role),
    createdAt: r.created_at,
    lastPolledAt: r.polled_at || null,
    lastError: r.error,
    openPositions: r.snapshot ? (JSON.parse(r.snapshot) as { positions: unknown[] }).positions.length : null,
  }));
}

export async function addWatch(env: Env, accountId: string, input: { address: unknown; role?: unknown; label?: unknown; rules?: unknown }, now = Date.now()): Promise<{ id: string; created: boolean }> {
  const address = parseAddress(input.address);
  const role: WatchRole = input.role === 'follow' ? 'follow' : 'own';
  if (input.role !== undefined && input.role !== 'own' && input.role !== 'follow') throw new ApiError(400, 'invalid_role', 'role must be "own" or "follow".');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 40) : null;
  let rules: WalletRules;
  try {
    rules = normalizeWalletRules(input.rules, defaultRulesFor(role));
  } catch (err) {
    if (err instanceof ValidationError) throw new ApiError(400, 'invalid_rules', err.message);
    throw err;
  }
  const existing = await env.DB.prepare(`SELECT id FROM watches WHERE account_id = ? AND address = ? AND role = ?`).bind(accountId, address, role).first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watches WHERE account_id = ?`).bind(accountId).first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.watchesPerAccount) throw new ApiError(409, 'watch_limit', `A subscription can watch at most ${LIMITS.watchesPerAccount} wallets. Remove one first.`);
  const id = newId('wch');
  await env.DB.prepare(`INSERT INTO watches (id, account_id, address, role, label, rules, state, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`).bind(id, accountId, address, role, label, JSON.stringify(rules), now).run();
  return { id, created: true };
}

export async function updateWatchRules(env: Env, accountId: string, watchId: string, input: { rules?: unknown; label?: unknown }): Promise<WatchView> {
  const row = await env.DB.prepare(`SELECT role, rules FROM watches WHERE id = ? AND account_id = ?`).bind(watchId, accountId).first<{ role: WatchRole; rules: string }>();
  if (!row) throw new ApiError(404, 'not_found', 'No such watch.');
  let rules: WalletRules;
  try {
    rules = normalizeWalletRules(input.rules, parseStoredWalletRules(row.rules, row.role));
  } catch (err) {
    if (err instanceof ValidationError) throw new ApiError(400, 'invalid_rules', err.message);
    throw err;
  }
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 40) || null : undefined;
  await env.DB.prepare(label === undefined ? `UPDATE watches SET rules = ? WHERE id = ?` : `UPDATE watches SET rules = ?, label = ? WHERE id = ?`)
    .bind(...(label === undefined ? [JSON.stringify(rules), watchId] : [JSON.stringify(rules), label, watchId]))
    .run();
  const watch = (await listWatches(env, accountId)).find((w) => w.id === watchId);
  if (!watch) throw new ApiError(404, 'not_found', 'No such watch.');
  return watch;
}

export async function removeWatch(env: Env, accountId: string, watchId: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM watches WHERE id = ? AND account_id = ?`).bind(watchId, accountId).run();
  return (res.meta.changes ?? 0) > 0;
}

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  label: string | null;
  /** Telegram chat id, or the webhook host with the secret path masked. Never the full Discord token. */
  display: string;
  status: 'active' | 'paused';
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export function displayTarget(kind: ChannelKind, target: string): string {
  if (kind === 'telegram') return `chat ${target}`;
  const url = new URL(target);
  if (kind === 'discord') return `${url.hostname}/api/webhooks/${url.pathname.split('/').filter(Boolean).at(-2) ?? ''}/...`;
  return `${url.protocol}//${url.host}${url.pathname.length > 1 ? '/...' : ''}`;
}

export async function listChannels(env: Env, accountId: string): Promise<ChannelView[]> {
  const { results } = await env.DB.prepare(`SELECT id, kind, target, label, status, created_at, last_ok_at, last_error, last_error_at FROM channels WHERE account_id = ? ORDER BY created_at ASC`)
    .bind(accountId)
    .all<{ id: string; kind: ChannelKind; target: string; label: string | null; status: 'active' | 'paused'; created_at: number; last_ok_at: number | null; last_error: string | null; last_error_at: number | null }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    display: displayTarget(r.kind, r.target),
    status: r.status,
    createdAt: r.created_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
  }));
}

export async function addChannel(env: Env, accountId: string, input: { kind: unknown; target: unknown; label?: unknown }, now = Date.now()): Promise<{ id: string; secret: string | null }> {
  if (input.kind !== 'discord' && input.kind !== 'webhook' && input.kind !== 'telegram') throw new ApiError(400, 'invalid_kind', 'kind must be telegram, discord or webhook.');
  if (typeof input.target !== 'string') throw new ApiError(400, 'invalid_target', 'target is required.');
  let target: string;
  try {
    target = validateTarget(input.kind, input.target, env);
  } catch (err) {
    throw new ApiError(400, 'invalid_target', err instanceof Error ? err.message : 'Invalid target.');
  }
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channels WHERE account_id = ?`).bind(accountId).first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.channelsPerAccount) throw new ApiError(409, 'channel_limit', `A subscription can have at most ${LIMITS.channelsPerAccount} channels.`);
  const dupe = await env.DB.prepare(`SELECT id FROM channels WHERE account_id = ? AND kind = ? AND target = ?`).bind(accountId, input.kind, target).first();
  if (dupe) throw new ApiError(409, 'duplicate_channel', 'That destination is already connected.');
  const id = newId('chn');
  const secret = input.kind === 'webhook' ? `whsec_${randomBase64Url(24)}` : null;
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 40) : null;
  await env.DB.prepare(`INSERT INTO channels (id, account_id, kind, target, secret, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).bind(id, accountId, input.kind, target, secret, label, now).run();
  return { id, secret };
}

export async function removeChannel(env: Env, accountId: string, channelId: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM channels WHERE id = ? AND account_id = ?`).bind(channelId, accountId).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function newLinkCode(env: Env, accountId: string, now = Date.now()): Promise<{ code: string; expiresAt: number }> {
  const code = randomBase64Url(9).replace(/[-_]/g, 'x');
  const expiresAt = now + 15 * 60_000;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM link_codes WHERE account_id = ?`).bind(accountId),
    env.DB.prepare(`INSERT INTO link_codes (code, account_id, expires_at) VALUES (?, ?, ?)`).bind(code, accountId, expiresAt),
  ]);
  return { code, expiresAt };
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  deliveryId: string;
  alertId: string;
}

/** Send one real test message to one of the account's channels and record it like any other delivery. */
export async function sendTestMessage(env: Env, accountId: string, channelId: string): Promise<TestResult> {
  const channel = await env.DB.prepare(`SELECT id, kind, target, secret FROM channels WHERE id = ? AND account_id = ?`)
    .bind(channelId, accountId)
    .first<{ id: string; kind: ChannelKind; target: string; secret: string | null }>();
  if (!channel) throw new ApiError(404, 'not_found', 'No such channel.');
  const availability = channelAvailability(env).find((a) => a.kind === channel.kind);
  if (availability && !availability.enabled) throw new ApiError(503, 'channel_disabled', availability.reason ?? 'This channel is not configured.');
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE account_id = ? AND type = 'test' AND created_at > ?`).bind(accountId, Date.now() - 60_000).first<{ n: number }>();
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
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO alerts (id, account_id, watch_id, type, severity, dedupe_key, title, body, payload, suppressed, created_at) VALUES (?, ?, NULL, 'test', 'info', ?, ?, ?, ?, 0, ?)`)
      .bind(alertId, accountId, `test:${alertId}`, rendered.title, rendered.body, JSON.stringify({ fields: rendered.fields, url: null, data: rendered.data }), now),
    env.DB.prepare(`INSERT INTO deliveries (id, alert_id, channel_id, account_id, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`).bind(deliveryId, alertId, channel.id, accountId, now, now),
  ]);
  const result = await sendToChannel(env, channel, rendered, deliveryId);
  // A test is one-shot: a failure goes straight to the dead-letter view where it can be retried after fixing the channel.
  const outcome = nextState(0, result, Date.now(), 1);
  await env.DB.batch(outcomeStatements(env, { id: deliveryId, channel_id: channel.id }, outcome, Date.now()));
  return { ok: result.ok, status: result.status ?? null, error: result.error ?? null, deliveryId, alertId };
}
