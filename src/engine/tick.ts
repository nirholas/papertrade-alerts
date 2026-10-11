import { fetchWalletState, PapertradeClient, type TradingState } from 'papertrade-sdk';
import type { Address } from 'viem';
import { runBatch } from '../lib/d1.js';
import type { AlertEvent, CompactSnapshot, Env, InstrumentInfo, ProtocolRules, TradeRow, WalletRules, WatchRole, WatchState } from '../types.js';
import { ALERTS_PER_HOUR, alertStatements, recentAlertCount } from './alerts.js';
import { processDeliveries, type DeliveryReport } from './delivery.js';
import { diffWallet, type DiffContext, vanished } from './diff.js';
import { diffProtocol, protocolSnapshot, type ProtocolSnapshot } from './protocol.js';
import { parseStoredProtocolRules, parseStoredWalletRules } from './rules.js';
import { compactSnapshot } from './snapshot.js';

const LEASE_MS = 120_000;
const TICK_DEADLINE_MS = 50_000;
const WALLET_CONCURRENCY = 3;
const WALLET_TIMEOUT_MS = 15_000;
const RETENTION_MS = 30 * 24 * 3_600_000;

export interface TickReport {
  ok: boolean;
  skipped?: string;
  startedAt: number;
  durationMs: number;
  wallets: { due: number; polled: number; failed: number; rateLimited: boolean };
  alerts: number;
  protocolAlerts: number;
  deliveries: DeliveryReport | null;
  errors: string[];
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Papertrade API rate limited (retry after ${Math.ceil(retryAfterMs / 1000)}s)`);
  }
}

/** Shared across the concurrent wallet polls of one tick: once the API says 429, nobody keeps hammering it. */
class RateGate {
  until = 0;
  hit(retryAfterMs: number, now: number) {
    this.until = Math.max(this.until, now + retryAfterMs);
  }
  async wait(deadline: number): Promise<boolean> {
    const delay = this.until - Date.now();
    if (delay <= 0) return true;
    if (Date.now() + delay > deadline) return false;
    await new Promise((r) => setTimeout(r, delay));
    return true;
  }
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 5_000;
}

function gatedFetch(gate: RateGate, onLimit?: () => void): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 429) {
      gate.hit(parseRetryAfter(res.headers.get('retry-after')), Date.now());
      onLimit?.();
    }
    return res;
  };
}

async function acquireLease(env: Env, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES ('lease', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at WHERE kv.updated_at < ?`,
  )
    .bind(now, now - LEASE_MS)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

const releaseLease = (env: Env) => env.DB.prepare(`UPDATE kv SET updated_at = 0 WHERE key = 'lease'`).run();

interface WatchRow {
  id: string;
  account_id: string;
  address: string;
  role: WatchRole;
  rules: string;
  state: string;
}

function instrumentMap(trading: TradingState): Record<number, InstrumentInfo> {
  return Object.fromEntries(trading.instruments.map((i) => [i.id, { id: i.id, symbol: i.symbol, priceScale: Number(i.priceScale) }]));
}

async function fetchMarks(client: PapertradeClient, trading: TradingState, now: number): Promise<Record<number, bigint>> {
  const marks: Record<number, bigint> = {};
  await Promise.all(
    trading.instruments
      .filter((i) => i.active && !i.retired)
      .map(async (i) => {
        const { points } = await client.priceHistory({ instrumentId: i.id, lookbackMs: 90_000, nowMs: now });
        const last = points[points.length - 1];
        if (last) marks[i.id] = BigInt(Math.round(last.price * Number(i.priceScale)));
      }),
  );
  return marks;
}

async function fetchSettlements(client: PapertradeClient, address: string, wanted: Set<string>): Promise<TradeRow[]> {
  const rows: TradeRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await client.accountTrades(address as Address, { cursor });
    for (const t of res.items) {
      rows.push({ positionId: t.positionId, kind: t.kind, timestampMs: t.timestampMs, txHash: t.txHash, adjustedPnlRaw: t.adjustedPnlRaw, userPaidFeeRaw: t.userPaidFeeRaw, paperMintedRaw: t.paperMintedRaw });
      wanted.delete(t.positionId);
    }
    if (!wanted.size || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return rows;
}

export interface TickOptions {
  now?: number;
  fetchImpl?: typeof fetch;
}

/** One cron invocation: poll due wallets, diff, record alerts, then flush the delivery queue. */
export async function runTick(env: Env, options: TickOptions = {}): Promise<TickReport> {
  const startedAt = options.now ?? Date.now();
  const report: TickReport = {
    ok: true,
    startedAt,
    durationMs: 0,
    wallets: { due: 0, polled: 0, failed: 0, rateLimited: false },
    alerts: 0,
    protocolAlerts: 0,
    deliveries: null,
    errors: [],
  };
  const finish = () => {
    report.durationMs = Date.now() - startedAt;
    return report;
  };

  if (!(await acquireLease(env, startedAt))) {
    report.skipped = 'Another tick is still running.';
    return finish();
  }
  try {
    const deadline = Date.now() + TICK_DEADLINE_MS;
    const gate = new RateGate();
    const baseUrl = (env.PAPERTRADE_API_URL ?? 'https://exchange.papertrade.xyz').replace(/\/+$/, '');
    const client = new PapertradeClient({ baseUrl, fetch: gatedFetch(gate, () => (report.wallets.rateLimited = true)), clientBuild: 'papertrade-alerts/0.1', retries: 2 });

    // Retry the delivery queue first so a slow Papertrade API never delays notifications that are already due.
    report.deliveries = await processDeliveries(env, Date.now(), options.fetchImpl);

    const hasWork = await env.DB.prepare(`SELECT 1 AS x FROM watches LIMIT 1`).first();
    const accountsWithChannels = await env.DB.prepare(
      `SELECT id, protocol_rules FROM accounts a WHERE EXISTS (SELECT 1 FROM channels c WHERE c.account_id = a.id AND c.status = 'active')`,
    ).all<{ id: string; protocol_rules: string }>();
    if (!hasWork && !accountsWithChannels.results.length) return finish();

    const [trading, summary] = await Promise.all([client.tradingState(), client.protocolSummary()]);
    const instruments = instrumentMap(trading);

    // Protocol alerts.
    try {
      const curr = protocolSnapshot(trading, summary, startedAt);
      const stored = await env.DB.prepare(`SELECT value FROM kv WHERE key = 'protocol'`).first<{ value: string }>();
      const prev = stored ? (JSON.parse(stored.value) as ProtocolSnapshot) : null;
      const events = diffProtocol(prev, curr, instruments);
      const stmts: D1PreparedStatement[] = [];
      for (const account of accountsWithChannels.results) {
        const rules: ProtocolRules = parseStoredProtocolRules(account.protocol_rules);
        const list: AlertEvent[] = [];
        if (rules.marketStatus) list.push(...events.market);
        const mint = events.mintRate(rules);
        if (mint) list.push(mint);
        for (const ev of list) {
          stmts.push(...alertStatements(env, { accountId: account.id, watchId: null }, ev, startedAt, false));
          report.protocolAlerts++;
        }
      }
      stmts.push(
        env.DB.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('protocol', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(JSON.stringify(curr), startedAt),
      );
      await runBatch(env.DB, stmts);
    } catch (err) {
      report.errors.push(`protocol: ${err instanceof Error ? err.message : String(err)}`);
    }

    let marks: Record<number, bigint> = {};
    try {
      marks = await fetchMarks(client, trading, startedAt);
    } catch (err) {
      report.errors.push(`marks: ${err instanceof Error ? err.message : String(err)} (liquidation-distance checks skipped this tick)`);
    }

    const ctx: DiffContext = { now: startedAt, instruments, marks, accRewardPerShareRaw: trading.accRewardPerShareRaw, explorerUrl: env.EXPLORER_URL ?? 'https://papertrade-explorer.pages.dev' };
    const limit = Math.max(1, Math.min(500, Number(env.MAX_WALLETS_PER_TICK) || 40));
    const due = await env.DB.prepare(
      `SELECT w.address FROM watches w LEFT JOIN wallet_state s ON s.address = w.address
       WHERE s.address IS NULL OR s.polled_at + MIN(s.error_count, 10) * 60000 <= ?
       GROUP BY w.address ORDER BY COALESCE(s.polled_at, 0) ASC LIMIT ?`,
    )
      .bind(startedAt, limit)
      .all<{ address: string }>();
    report.wallets.due = due.results.length;

    const capCache = new Map<string, number>();
    const queue = due.results.map((r) => r.address);
    const worker = async () => {
      for (;;) {
        if (Date.now() > deadline || !(await gate.wait(deadline))) return;
        const address = queue.shift();
        if (!address) return;
        try {
          report.alerts += await pollWallet(env, client, gate, address, ctx, capCache);
          report.wallets.polled++;
        } catch (err) {
          if (err instanceof RateLimited) {
            // Not the wallet's fault: leave its stored state untouched so it stays due, and let the gate pause every worker.
            report.wallets.rateLimited = true;
            queue.push(address);
            continue;
          }
          report.wallets.failed++;
          const message = err instanceof Error ? err.message : String(err);
          report.errors.push(`${address}: ${message}`);
          await env.DB.prepare(
            `INSERT INTO wallet_state (address, polled_at, error, error_count) VALUES (?, ?, ?, 1)
             ON CONFLICT(address) DO UPDATE SET polled_at = excluded.polled_at, error = excluded.error, error_count = wallet_state.error_count + 1`,
          )
            .bind(address, startedAt, message.slice(0, 300))
            .run();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WALLET_CONCURRENCY, queue.length) }, worker));

    // Deliver what this tick produced.
    const second = await processDeliveries(env, Date.now(), options.fetchImpl);
    report.deliveries = {
      due: report.deliveries.due + second.due,
      sent: report.deliveries.sent + second.sent,
      retried: report.deliveries.retried + second.retried,
      dead: report.deliveries.dead + second.dead,
      deferredByRateLimit: report.deliveries.deferredByRateLimit + second.deferredByRateLimit,
    };

    if (startedAt % 3_600_000 < 60_000) await prune(env, startedAt);
  } catch (err) {
    report.ok = false;
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    await releaseLease(env).catch(() => undefined);
  }
  return finish();
}

async function prune(env: Env, now: number): Promise<void> {
  const cutoff = now - RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM alerts WHERE created_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM link_codes WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM wallet_state WHERE address NOT IN (SELECT address FROM watches)`),
  ]);
}

async function pollWallet(env: Env, client: PapertradeClient, gate: RateGate, address: string, ctx: DiffContext, capCache: Map<string, number>): Promise<number> {
  const ctrl = new AbortController();
  const limited = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new Error('aborted')), { once: true });
  });
  const streamFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      gate.hit(retryAfterMs, Date.now());
      ctrl.abort(new RateLimited(retryAfterMs));
    }
    return res;
  };
  const baseUrl = client.http.baseUrl;
  const state = await Promise.race([fetchWalletState(address as Address, { baseUrl, fetch: streamFetch, signal: ctrl.signal, timeoutMs: WALLET_TIMEOUT_MS }), limited]);
  ctrl.abort(new Error('done'));
  limited.catch(() => undefined);

  const curr: CompactSnapshot = compactSnapshot(state, ctx.now);
  const stored = await env.DB.prepare(`SELECT snapshot FROM wallet_state WHERE address = ?`).bind(address).first<{ snapshot: string | null }>();
  const prev = stored?.snapshot ? (JSON.parse(stored.snapshot) as CompactSnapshot) : null;
  const { results: watches } = await env.DB.prepare(`SELECT id, account_id, address, role, rules, state FROM watches WHERE address = ?`).bind(address).all<WatchRow>();

  const parsed = watches.map((w) => ({ w, rules: parseStoredWalletRules(w.rules, w.role) as WalletRules, state: JSON.parse(w.state) as WatchState }));
  const needed = new Set<string>();
  if (prev) for (const p of vanished(prev.positions, curr.positions)) needed.add(p.id);
  for (const p of parsed) for (const pc of p.state.pendingClose ?? []) needed.add(pc.id);
  const trades = needed.size ? await fetchSettlements(client, address, new Set(needed)).catch(() => null) : null;

  const stmts: D1PreparedStatement[] = [];
  let count = 0;
  for (const { w, rules, state: watchState } of parsed) {
    const result = diffWallet({ address, role: w.role, rules, prev, curr, state: watchState, trades, ctx });
    let used = capCache.get(w.account_id);
    if (used === undefined) {
      used = await recentAlertCount(env, w.account_id, ctx.now);
      capCache.set(w.account_id, used);
    }
    for (const ev of result.events) {
      const suppressed = used >= ALERTS_PER_HOUR;
      stmts.push(...alertStatements(env, { accountId: w.account_id, watchId: w.id }, ev, ctx.now, suppressed));
      if (!suppressed) used++;
      count++;
    }
    capCache.set(w.account_id, used);
    stmts.push(env.DB.prepare(`UPDATE watches SET state = ? WHERE id = ?`).bind(JSON.stringify(result.state), w.id));
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO wallet_state (address, snapshot, polled_at, ok_at, error, error_count) VALUES (?, ?, ?, ?, NULL, 0)
       ON CONFLICT(address) DO UPDATE SET snapshot = excluded.snapshot, polled_at = excluded.polled_at, ok_at = excluded.ok_at, error = NULL, error_count = 0`,
    ).bind(address, JSON.stringify(curr), ctx.now, ctx.now),
  );
  await runBatch(env.DB, stmts);
  return count;
}
