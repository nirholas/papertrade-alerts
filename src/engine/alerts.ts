import type { AlertEvent, Env } from '../types.js';
import { newId } from '../lib/crypto.js';

/** At most this many non-test alerts per account per hour are delivered. The rest are recorded as suppressed. */
export const ALERTS_PER_HOUR = 60;

export interface AlertTarget {
  accountId: string;
  watchId: string | null;
}

const HOUR = 3_600_000;

/** Alerts created for an account in the last hour that were not suppressed, used for the hourly cap. */
export async function recentAlertCount(env: Env, accountId: string, now: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE account_id = ? AND suppressed = 0 AND type != 'test' AND created_at > ?`)
    .bind(accountId, now - HOUR)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Statements that record one alert and fan it out to the account's active channels.
 * The unique (account_id, dedupe_key) index makes the insert idempotent; the delivery rows are derived from the
 * freshly inserted alert id, so a duplicate alert produces no deliveries.
 */
export function alertStatements(env: Env, target: AlertTarget, event: AlertEvent, now: number, suppressed: boolean): D1PreparedStatement[] {
  const id = newId('alt');
  const payload = JSON.stringify({ fields: event.fields, url: event.url ?? null, data: event.data });
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO alerts (id, account_id, watch_id, type, severity, dedupe_key, title, body, payload, suppressed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, target.accountId, target.watchId, event.type, event.severity, event.dedupeKey, event.title, event.body, payload, suppressed ? 1 : 0, now),
  ];
  if (!suppressed) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO deliveries (id, alert_id, channel_id, account_id, status, attempts, next_attempt_at, created_at)
         SELECT 'dlv_' || lower(hex(randomblob(8))), a.id, c.id, a.account_id, 'pending', 0, ?, ?
         FROM alerts a JOIN channels c ON c.account_id = a.account_id AND c.status = 'active'
         WHERE a.id = ?`,
      ).bind(now, now, id),
    );
  }
  return stmts;
}
