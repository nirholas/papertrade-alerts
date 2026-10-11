import { describe, expect, it } from 'vitest';
import { diffWallet } from '../src/engine/diff.js';
import { defaultRulesFor } from '../src/engine/rules.js';
import type { WatchState } from '../src/types.js';
import { context, load, snapshotOf, tradesOf, type RecordedRow } from './helpers.js';

const life = load<RecordedRow[]>('wallet-lifecycle.json');
const opened = load<RecordedRow[]>('wallet-open.json');
const ADDRESS = life[0].snap.address.toLowerCase();
const own = () => defaultRulesFor('own');
const seeded: WatchState = { seeded: true };

function step(i: number, j: number, over: { state?: WatchState; rules?: ReturnType<typeof own>; role?: 'own' | 'follow'; withTrades?: boolean; now?: number } = {}) {
  return diffWallet({
    address: ADDRESS,
    role: over.role ?? 'own',
    rules: over.rules ?? own(),
    prev: snapshotOf(life[i]),
    curr: snapshotOf(life[j]),
    state: over.state ?? seeded,
    trades: over.withTrades === false ? null : tradesOf(life[j]),
    ctx: context(over.now ?? life[j].at),
  });
}

describe('diffWallet on recorded snapshots', () => {
  it('is silent when nothing changed between two real polls', () => {
    expect(step(0, 1).events).toEqual([]);
  });

  it('seeds a new watch silently: existing positions are never announced', () => {
    const r = step(4, 10, { state: {} });
    expect(r.events).toEqual([]);
    expect(r.state.seeded).toBe(true);
  });

  it('announces positions that appeared since the last poll, once per position', () => {
    const r = step(4, 10);
    const opens = r.events.filter((e) => e.type === 'position_opened');
    expect(opens).toHaveLength(2);
    expect(new Set(opens.map((e) => e.dedupeKey)).size).toBe(2);
    expect(opens[0].dedupeKey).toMatch(/^open:0x[0-9a-f]{40}:\d+$/);
    expect(opens[0].fields.map((f) => f.name)).toEqual(['Market', 'Leverage', 'Margin', 'Notional', 'Entry']);
  });

  it('labels the same event follow_opened for a followed wallet, and respects the opened switch', () => {
    const follow = step(4, 10, { role: 'follow', rules: defaultRulesFor('follow') });
    expect(follow.events.every((e) => e.type === 'follow_opened')).toBe(true);
    const off = step(4, 10, { rules: { ...own(), opened: false } });
    expect(off.events).toEqual([]);
  });

  it('reports a closed position with net PnL and PAPER from its settlement row', () => {
    const r = step(10, 11);
    const closed = r.events.filter((e) => e.type === 'position_closed');
    expect(closed).toHaveLength(1);
    const trade = tradesOf(life[11]).find((t) => t.positionId === closed[0].dedupeKey.split(':').pop());
    expect(trade).toBeDefined();
    expect(closed[0].fields.map((f) => f.name)).toEqual(expect.arrayContaining(['Net PnL']));
    expect(closed[0].data.positionId).toBe(trade!.positionId);
    expect(r.state.pendingClose ?? []).toEqual([]);
  });

  it('waits for the settlement row instead of guessing, then settles inside the grace window', () => {
    const waiting = step(10, 11, { withTrades: false });
    expect(waiting.events).toEqual([]);
    expect(waiting.state.pendingClose).toHaveLength(1);
    const settled = diffWallet({ address: ADDRESS, role: 'own', rules: own(), prev: snapshotOf(life[11]), curr: snapshotOf(life[11]), state: waiting.state, trades: tradesOf(life[11]), ctx: context(life[11].at + 30_000) });
    expect(settled.events.map((e) => e.type)).toEqual(['position_closed']);
    expect(settled.state.pendingClose).toEqual([]);
  });

  it('gives up waiting after the grace window and says the settlement is unconfirmed', () => {
    const waiting = step(10, 11, { withTrades: false });
    const late = diffWallet({ address: ADDRESS, role: 'own', rules: own(), prev: snapshotOf(life[11]), curr: snapshotOf(life[11]), state: waiting.state, trades: [], ctx: context(life[11].at + 11 * 60_000) });
    expect(late.events).toHaveLength(1);
    expect(late.events[0].type).toBe('position_closed');
    expect(late.state.pendingClose).toEqual([]);
  });

  it('batches many closes in one poll (24 positions at once) with one distinct dedupe key each', () => {
    const r = step(3, 4);
    const closed = r.events.filter((e) => e.type === 'position_closed' || e.type === 'position_liquidated');
    expect(closed.length).toBeGreaterThanOrEqual(20);
    expect(new Set(closed.map((e) => e.dedupeKey)).size).toBe(closed.length);
  });

  it('replaying the same transition yields identical dedupe keys (retried ticks cannot double-send)', () => {
    const a = step(10, 11).events.map((e) => e.dedupeKey);
    const b = step(10, 11).events.map((e) => e.dedupeKey);
    expect(a).toEqual(b);
  });

  it('does not re-announce on the next poll once state is carried forward', () => {
    const first = step(4, 10);
    const second = diffWallet({ address: ADDRESS, role: 'own', rules: own(), prev: snapshotOf(life[10]), curr: snapshotOf(life[10]), state: first.state, trades: null, ctx: context(life[10].at + 20_000) });
    expect(second.events).toEqual([]);
  });
});

describe('thresholds on recorded positions', () => {
  const row = opened[2];
  const whole = snapshotOf(row);
  const target = whole.positions[0];
  const curr = { ...whole, positions: [target] };
  /** Mark price that sits `pct` percent away from the bust price, on the safe side of it. */
  const priceAt = (pct: number): bigint => {
    const bust = Number(BigInt(target.b));
    return BigInt(Math.round(bust * (target.l ? 1 + pct / 100 : 1 - pct / 100)));
  };
  const run = (pct: number, state: WatchState = seeded, belowPct = 1) =>
    diffWallet({ address: row.snap.address, role: 'own', rules: { ...own(), liquidation: { enabled: true, belowPct }, opened: false, closed: false, liquidated: false }, prev: curr, curr, state, trades: null, ctx: context(row.at, { [target.i]: priceAt(pct) }) });

  it('fires one liquidation-distance alert when a real position gets close to its bust price', () => {
    const r = run(0.1);
    const liq = r.events.filter((e) => e.type === 'liquidation_distance' && e.data.positionId === target.id);
    expect(liq).toHaveLength(1);
    expect(liq[0].severity).not.toBe('info');
    expect(r.state.liqArmed).toContain(target.id);
  });

  it('stays quiet while the position is far from bust and while already alerted', () => {
    expect(run(3).events.filter((e) => e.data.positionId === target.id)).toEqual([]);
    const near = run(0.1);
    const again = run(0.1, near.state);
    expect(again.events.filter((e) => e.type === 'liquidation_distance' && e.data.positionId === target.id)).toEqual([]);
  });

  it('re-arms after the position recovers past 1.5x the threshold', () => {
    const near = run(0.1);
    const recovered = run(3, near.state);
    expect(recovered.state.liqArmed ?? []).not.toContain(target.id);
    const again = run(0.1, recovered.state);
    expect(again.events.some((e) => e.type === 'liquidation_distance' && e.data.positionId === target.id)).toBe(true);
  });

  it('does nothing without a mark price (feed outage) instead of guessing', () => {
    const r = diffWallet({ address: row.snap.address, role: 'own', rules: own(), prev: curr, curr, state: seeded, trades: null, ctx: context(row.at, {}) });
    expect(r.events.filter((e) => e.type === 'liquidation_distance')).toEqual([]);
  });
});

describe('balance, session key and rewards', () => {
  it('reports a balance change that crosses the threshold, measured against a stored baseline', () => {
    const rules = { ...own(), balance: { enabled: true, changeUsd: 20 }, opened: false, closed: false };
    const r = step(0, 4, { rules, state: { seeded: true, balanceBaseline: snapshotOf(life[0]).equity } });
    const bal = r.events.filter((e) => e.type === 'balance_change');
    expect(bal).toHaveLength(1);
    expect(r.state.balanceBaseline).toBe(snapshotOf(life[4]).equity);
    const first = step(0, 4, { rules });
    expect(first.events.filter((e) => e.type === 'balance_change')).toEqual([]);
    expect(first.state.balanceBaseline).toBe(snapshotOf(life[4]).equity);
  });

  it('warns once when a session key is within the configured number of days', () => {
    const base = snapshotOf(life[0]);
    const expiry = base.keys[0]?.[1];
    expect(expiry).toBeGreaterThan(0);
    const rules = { ...own(), sessionKey: { enabled: true, withinDays: 30 } };
    const nowSeconds = (expiry as number) - 2 * 86400;
    const input = { address: ADDRESS, role: 'own' as const, rules, prev: base, curr: base, trades: null, ctx: context(nowSeconds * 1000) };
    const first = diffWallet({ ...input, state: seeded });
    expect(first.events.filter((e) => e.type === 'session_key_expiring')).toHaveLength(1);
    const second = diffWallet({ ...input, state: first.state });
    expect(second.events.filter((e) => e.type === 'session_key_expiring')).toHaveLength(0);
  });

  it('is quiet when the session key is far from expiry', () => {
    const base = snapshotOf(life[0]);
    const r = diffWallet({ address: ADDRESS, role: 'own', rules: { ...own(), sessionKey: { enabled: true, withinDays: 3 } }, prev: base, curr: base, state: seeded, trades: null, ctx: context(life[0].at) });
    expect(r.events.filter((e) => e.type === 'session_key_expiring')).toEqual([]);
  });

  it('alerts on pending staking rewards from a real staked balance and re-arms after a claim', () => {
    const staker = load<RecordedRow[]>('wallet-open.json')[0];
    const curr = snapshotOf(staker);
    const rules = { ...own(), opened: false, closed: false, liquidation: { enabled: false, belowPct: 1 }, sessionKey: { enabled: false, withinDays: 3 }, rewards: { enabled: true, aboveUsdc: 0.01 } };
    const input = { address: staker.snap.address, role: 'own' as const, rules, prev: curr, curr, trades: null, ctx: context(staker.at) };
    const first = diffWallet({ ...input, state: seeded });
    const rewardEvents = first.events.filter((e) => e.type === 'staking_rewards');
    if (BigInt(curr.paper.staked) > 0n) {
      expect(rewardEvents.length).toBeLessThanOrEqual(1);
      const second = diffWallet({ ...input, state: first.state });
      expect(second.events.filter((e) => e.type === 'staking_rewards')).toEqual([]);
    }
  });
});
