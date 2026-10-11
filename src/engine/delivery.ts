import { sendToChannel, type RenderedAlert, type SendResult } from '../channels/index.js';
import type { ChannelKind, Env } from '../types.js';
import { runBatch } from '../lib/d1.js';

export const MAX_ATTEMPTS = 6;
/** Per-channel send budget per rolling minute. Excess deliveries stay pending and go out on later ticks. */
export const SENDS_PER_CHANNEL_PER_MINUTE = 20;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const BATCH_LIMIT = 100;
const CONCURRENCY = 6;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export interface DueDelivery {
  id: string;
  alert_id: string;
  channel_id: string;
  attempts: number;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  payload: string;
  alert_created: number;
  kind: ChannelKind;
  target: string;
  secret: string | null;
  channel_status: 'active' | 'paused';
}

export function renderAlert(row: Pick<DueDelivery, 'alert_id' | 'type' | 'severity' | 'title' | 'body' | 'payload' | 'alert_created'>): RenderedAlert {
  const extra = JSON.parse(row.payload) as { fields?: { name: string; value: string }[]; url?: string | null; data?: Record<string, unknown> };
  return {
    id: row.alert_id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    fields: extra.fields ?? [],
    url: extra.url ?? undefined,
    createdAt: row.alert_created,
    data: extra.data ?? {},
  };
}

export interface DeliveryOutcome {
  status: 'sent' | 'pending' | 'dead';
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  httpStatus: number | null;
}

/** Pure retry policy: what happens to a delivery after one attempt. */
export function nextState(attempts: number, result: SendResult, now: number, maxAttempts = MAX_ATTEMPTS): DeliveryOutcome {
  const made = attempts + 1;
  if (result.ok) return { status: 'sent', attempts: made, nextAttemptAt: now, error: null, httpStatus: result.status ?? null };
  const base = { attempts: made, error: result.error ?? 'Delivery failed', httpStatus: result.status ?? null };
  if (result.permanent || made >= maxAttempts) return { status: 'dead', nextAttemptAt: now, ...base };
  return { status: 'pending', nextAttemptAt: now + Math.max(result.retryAfterMs ?? 0, backoffMs(made)), ...base };
}

export interface DeliveryReport {
  due: number;
  sent: number;
  retried: number;
  dead: number;
  deferredByRateLimit: number;
}

async function sentInLastMinute(env: Env, now: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(`SELECT channel_id, COUNT(*) AS n FROM deliveries WHERE status = 'sent' AND sent_at > ? GROUP BY channel_id`)
    .bind(now - 60_000)
    .all<{ channel_id: string; n: number }>();
  return new Map(results.map((r) => [r.channel_id, r.n]));
}

/** Apply one attempt's outcome to its delivery row and the channel's health columns. */
export function outcomeStatements(env: Env, d: Pick<DueDelivery, 'id' | 'channel_id'>, o: DeliveryOutcome, now: number): D1PreparedStatement[] {
  const stmts = [
    env.DB.prepare(`UPDATE deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, last_http_status = ?, sent_at = ? WHERE id = ?`)
      .bind(o.status, o.attempts, o.nextAttemptAt, o.error, o.httpStatus, o.status === 'sent' ? now : null, d.id),
  ];
  stmts.push(
    o.status === 'sent'
      ? env.DB.prepare(`UPDATE channels SET last_ok_at = ?, last_error = NULL WHERE id = ?`).bind(now, d.channel_id)
      : env.DB.prepare(`UPDATE channels SET last_error = ?, last_error_at = ? WHERE id = ?`).bind(o.error, now, d.channel_id),
  );
  return stmts;
}

/** Send every due delivery, honoring per-channel rate limits, provider Retry-After and the retry/dead-letter policy. */
export async function processDeliveries(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<DeliveryReport> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.alert_id, d.channel_id, d.attempts, a.type, a.severity, a.title, a.body, a.payload, a.created_at AS alert_created,
            c.kind, c.target, c.secret, c.status AS channel_status
     FROM deliveries d
     JOIN alerts a ON a.id = d.alert_id
     JOIN channels c ON c.id = d.channel_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ?
     ORDER BY d.next_attempt_at ASC LIMIT ?`,
  )
    .bind(now, BATCH_LIMIT)
    .all<DueDelivery>();

  const report: DeliveryReport = { due: results.length, sent: 0, retried: 0, dead: 0, deferredByRateLimit: 0 };
  if (!results.length) return report;

  const budget = await sentInLastMinute(env, now);
  const runnable: DueDelivery[] = [];
  const writes: D1PreparedStatement[] = [];
  for (const d of results) {
    if (d.channel_status === 'paused') {
      writes.push(...outcomeStatements(env, d, { status: 'dead', attempts: d.attempts, nextAttemptAt: now, error: 'Channel is paused.', httpStatus: null }, now));
      report.dead++;
      continue;
    }
    const used = budget.get(d.channel_id) ?? 0;
    if (used >= SENDS_PER_CHANNEL_PER_MINUTE) {
      writes.push(env.DB.prepare(`UPDATE deliveries SET next_attempt_at = ? WHERE id = ?`).bind(now + 60_000, d.id));
      report.deferredByRateLimit++;
      continue;
    }
    budget.set(d.channel_id, used + 1);
    runnable.push(d);
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < runnable.length) {
      const d = runnable[cursor++];
      const result = await sendToChannel(env, { id: d.channel_id, kind: d.kind, target: d.target, secret: d.secret }, renderAlert(d), d.id, fetchImpl);
      const outcome = nextState(d.attempts, result, Date.now());
      writes.push(...outcomeStatements(env, d, outcome, Date.now()));
      if (outcome.status === 'sent') report.sent++;
      else if (outcome.status === 'dead') report.dead++;
      else report.retried++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, runnable.length) }, worker));
  if (writes.length) await runBatch(env.DB, writes);
  return report;
}
