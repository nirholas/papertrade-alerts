import { distanceToLiquidation, pendingStakingRewardRaw } from 'papertrade-sdk';
import type {
  AlertEvent,
  CompactPosition,
  CompactSnapshot,
  InstrumentInfo,
  PendingClose,
  TradeRow,
  WalletRules,
  WatchRole,
  WatchState,
} from '../types.js';
import { fmtNum, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd, fmtWadUsd, shortAddr, wadNum } from './format.js';

/** How long a vanished position waits for the indexer to publish its settlement row before it is reported without PnL. */
export const SETTLEMENT_GRACE_MS = 10 * 60_000;

export interface DiffContext {
  now: number;
  instruments: Record<number, InstrumentInfo>;
  /** Mark price per instrument in raw units (price * priceScale). */
  marks: Record<number, bigint>;
  accRewardPerShareRaw: bigint;
  explorerUrl: string;
  /** Mint rate quoted in PAPER per $1 of loss, used only to word liquidation hints. */
  mintRate?: number;
}

export interface DiffInput {
  address: string;
  role: WatchRole;
  rules: WalletRules;
  prev: CompactSnapshot | null;
  curr: CompactSnapshot;
  state: WatchState;
  /** Settlement rows for positions that vanished. Null when none were fetched. */
  trades: TradeRow[] | null;
  ctx: DiffContext;
}

export interface DiffResult {
  events: AlertEvent[];
  state: WatchState;
}

const sym = (ctx: DiffContext, id: number) => ctx.instruments[id]?.symbol ?? `Market ${id}`;
const side = (isLong: boolean) => (isLong ? 'long' : 'short');
const walletUrl = (ctx: DiffContext, address: string) => `${ctx.explorerUrl.replace(/\/+$/, '')}/wallet/${address}`;

function describePosition(p: CompactPosition, ctx: DiffContext): string {
  const scale = ctx.instruments[p.i]?.priceScale ?? 1;
  return `${sym(ctx, p.i)} ${side(p.l)} ${p.x}x, ${fmtWadUsd(p.m)} margin, entry ${fmtPrice(p.e, scale)}`;
}

/** Ids of positions present in `before` and absent in `after`. */
export function vanished(before: CompactPosition[], after: CompactPosition[]): CompactPosition[] {
  const live = new Set(after.map((p) => p.id));
  return before.filter((p) => !live.has(p.id));
}

export function appeared(before: CompactPosition[], after: CompactPosition[]): CompactPosition[] {
  const known = new Set(before.map((p) => p.id));
  return after.filter((p) => !known.has(p.id));
}

/**
 * Pure, edge-triggered diff of one watched wallet between two polls.
 *
 * Every threshold alert fires when a value crosses its threshold and re-arms only after it recovers,
 * so a wallet that sits below a threshold for an hour produces one alert, not sixty.
 * Trade events carry a dedupe key per position id, so a retried tick can never double-send.
 */
export function diffWallet(input: DiffInput): DiffResult {
  const { address, role, rules, prev, curr, ctx } = input;
  const events: AlertEvent[] = [];
  const state: WatchState = structuredClone(input.state);
  const label = shortAddr(address);
  const url = walletUrl(ctx, address);
  const seeded = state.seeded === true;

  // Opened. A new watch is seeded silently so its first poll does not announce every existing position.
  if (prev && seeded) {
    for (const p of appeared(prev.positions, curr.positions)) {
      const wanted = rules.opened;
      if (!wanted) continue;
      const follow = role === 'follow';
      events.push({
        type: follow ? 'follow_opened' : 'position_opened',
        dedupeKey: `open:${address}:${p.id}`,
        severity: 'info',
        title: follow ? `Followed wallet ${label} opened a position` : `Position opened on ${label}`,
        body: describePosition(p, ctx),
        fields: [
          { name: 'Market', value: `${sym(ctx, p.i)} ${side(p.l)}` },
          { name: 'Leverage', value: `${p.x}x` },
          { name: 'Margin', value: fmtWadUsd(p.m) },
          { name: 'Notional', value: fmtUsd(wadNum(p.m) * p.x) },
          { name: 'Entry', value: fmtPrice(p.e, ctx.instruments[p.i]?.priceScale ?? 1) },
        ],
        data: { address, positionId: p.id, instrumentId: p.i, isLong: p.l, leverage: p.x, marginRaw: p.m, entryPriceRaw: p.e, bustPriceRaw: p.b, openedAtMs: p.o },
        url,
      });
    }
  }

  // Closed and liquidated. A vanished position waits in pendingClose until its settlement row is indexed.
  const pending = new Map<string, PendingClose>((state.pendingClose ?? []).map((p) => [p.id, p]));
  if (prev && seeded) {
    for (const p of vanished(prev.positions, curr.positions)) {
      if (!pending.has(p.id)) pending.set(p.id, { ...p, firstSeen: ctx.now });
    }
  }
  const byPosition = new Map((input.trades ?? []).map((t) => [t.positionId, t]));
  for (const [id, p] of [...pending]) {
    const trade = byPosition.get(id);
    const expired = ctx.now - p.firstSeen > SETTLEMENT_GRACE_MS;
    if (!trade && !expired) continue;
    pending.delete(id);
    const liquidated = trade ? trade.kind === 'Liquidated' : false;
    if (liquidated ? !rules.liquidated : !rules.closed) continue;
    const market = `${sym(ctx, p.i)} ${side(p.l)} ${p.x}x`;
    if (!trade) {
      events.push({
        type: 'position_closed',
        dedupeKey: `close:${address}:${id}`,
        severity: 'info',
        title: `Position closed on ${label}`,
        body: `${market} is no longer open. Settlement details were not indexed within ${SETTLEMENT_GRACE_MS / 60_000} minutes.`,
        fields: [{ name: 'Market', value: market }, { name: 'Margin', value: fmtWadUsd(p.m) }],
        data: { address, positionId: id, instrumentId: p.i, isLong: p.l, leverage: p.x, marginRaw: p.m, settled: false },
        url,
      });
      continue;
    }
    const net = BigInt(trade.adjustedPnlRaw) - BigInt(trade.userPaidFeeRaw);
    const paper = BigInt(trade.paperMintedRaw);
    const netUsd = wadNum(net);
    const paperAmt = wadNum(paper);
    const fields = [
      { name: 'Market', value: market },
      { name: 'Net PnL', value: fmtSignedUsd(netUsd) },
      { name: 'Margin', value: fmtWadUsd(p.m) },
      { name: 'PAPER minted', value: paperAmt > 0 ? `${fmtNum(paperAmt)} PAPER` : 'none' },
    ];
    if (liquidated) {
      events.push({
        type: 'position_liquidated',
        dedupeKey: `close:${address}:${id}`,
        severity: 'critical',
        title: `Position LIQUIDATED on ${label}`,
        body: `${market} was liquidated. Net PnL ${fmtSignedUsd(netUsd)}, ${paperAmt > 0 ? `${fmtNum(paperAmt)} PAPER minted` : 'no PAPER minted'}.`,
        fields,
        data: { address, positionId: id, kind: trade.kind, netPnlRaw: net.toString(), paperMintedRaw: paper.toString(), marginRaw: p.m, txHash: trade.txHash, settledAtMs: trade.timestampMs },
        url,
      });
    } else {
      events.push({
        type: 'position_closed',
        dedupeKey: `close:${address}:${id}`,
        severity: netUsd >= 0 ? 'info' : 'warning',
        title: `Position closed on ${label}`,
        body: `${market} closed. Net PnL ${fmtSignedUsd(netUsd)}, ${paperAmt > 0 ? `${fmtNum(paperAmt)} PAPER minted` : 'no PAPER minted'}.`,
        fields,
        data: { address, positionId: id, kind: trade.kind, netPnlRaw: net.toString(), paperMintedRaw: paper.toString(), marginRaw: p.m, txHash: trade.txHash, settledAtMs: trade.timestampMs },
        url,
      });
    }
  }
  state.pendingClose = [...pending.values()];

  // Liquidation distance: edge-triggered per position with hysteresis (re-arm at 1.5x the threshold).
  if (rules.liquidation.enabled) {
    const armed = new Set(state.liqArmed ?? []);
    const open = new Set(curr.positions.map((p) => p.id));
    for (const id of [...armed]) if (!open.has(id)) armed.delete(id);
    const thresholdFraction = rules.liquidation.belowPct / 100;
    for (const p of curr.positions) {
      const mark = ctx.marks[p.i];
      if (mark === undefined) continue;
      const dist = distanceToLiquidation({ isLong: p.l, markPriceRaw: mark, bustPriceRaw: BigInt(p.b) });
      if (dist < thresholdFraction) {
        if (armed.has(p.id)) continue;
        armed.add(p.id);
        const scale = ctx.instruments[p.i]?.priceScale ?? 1;
        events.push({
          type: 'liquidation_distance',
          dedupeKey: `liq:${address}:${p.id}:${curr.at}`,
          severity: 'critical',
          title: `Liquidation risk on ${label}`,
          body: `${sym(ctx, p.i)} ${side(p.l)} ${p.x}x is ${fmtPct(Math.max(dist, 0))} from its bust price (threshold ${rules.liquidation.belowPct}%).`,
          fields: [
            { name: 'Market', value: `${sym(ctx, p.i)} ${side(p.l)} ${p.x}x` },
            { name: 'Distance', value: fmtPct(dist) },
            { name: 'Mark', value: fmtPrice(mark, scale) },
            { name: 'Bust price', value: fmtPrice(p.b, scale) },
            { name: 'Margin at risk', value: fmtWadUsd(p.m) },
          ],
          data: { address, positionId: p.id, distanceFraction: dist, thresholdPct: rules.liquidation.belowPct, markPriceRaw: mark.toString(), bustPriceRaw: p.b },
          url,
        });
      } else if (dist > thresholdFraction * 1.5) {
        armed.delete(p.id);
      }
    }
    state.liqArmed = [...armed];
  } else {
    state.liqArmed = [];
  }

  // Balance change: compare against the last reported baseline, not the previous poll, so slow drifts still trigger.
  if (rules.balance.enabled) {
    const baseline = state.balanceBaseline === undefined ? undefined : BigInt(state.balanceBaseline);
    const now = BigInt(curr.equity);
    if (baseline === undefined) {
      state.balanceBaseline = curr.equity;
    } else {
      const delta = now - baseline;
      const deltaUsd = wadNum(delta);
      if (Math.abs(deltaUsd) >= rules.balance.changeUsd) {
        events.push({
          type: 'balance_change',
          dedupeKey: `bal:${address}:${curr.at}`,
          severity: deltaUsd < 0 ? 'warning' : 'info',
          title: `Balance ${deltaUsd < 0 ? 'down' : 'up'} on ${label}`,
          body: `Account balance moved ${fmtSignedUsd(deltaUsd)} to ${fmtWadUsd(now)} (threshold ${fmtUsd(rules.balance.changeUsd)}).`,
          fields: [
            { name: 'Change', value: fmtSignedUsd(deltaUsd) },
            { name: 'Balance', value: fmtWadUsd(now) },
            { name: 'Previous', value: fmtWadUsd(baseline) },
          ],
          data: { address, deltaRaw: delta.toString(), balanceRaw: now.toString(), previousRaw: baseline.toString(), thresholdUsd: rules.balance.changeUsd },
          url,
        });
        state.balanceBaseline = curr.equity;
      }
    }
  } else {
    delete state.balanceBaseline;
  }

  // Session key expiring.
  if (rules.sessionKey.enabled) {
    const nowSec = Math.floor(ctx.now / 1000);
    const horizon = nowSec + rules.sessionKey.withinDays * 86_400;
    const alerted = new Set(state.keysAlerted ?? []);
    const live = new Set<string>();
    for (const [key, expiry] of curr.keys) {
      const tag = `${key}:${expiry}`;
      live.add(tag);
      if (expiry <= nowSec || expiry > horizon || alerted.has(tag)) continue;
      alerted.add(tag);
      const daysLeft = (expiry - nowSec) / 86_400;
      events.push({
        type: 'session_key_expiring',
        dedupeKey: `key:${address}:${tag}`,
        severity: daysLeft < 1 ? 'critical' : 'warning',
        title: `Session key expiring on ${label}`,
        body: `Session key ${shortAddr(key)} expires in ${daysLeft < 1 ? `${Math.max(1, Math.round(daysLeft * 24))} hours` : `${daysLeft.toFixed(1)} days`}. Register a new one before it lapses so trading keeps working.`,
        fields: [
          { name: 'Key', value: shortAddr(key) },
          { name: 'Expires', value: new Date(expiry * 1000).toISOString() },
        ],
        data: { address, sessionKey: key, expiry },
        url,
      });
    }
    state.keysAlerted = [...alerted].filter((t) => live.has(t));
  } else {
    state.keysAlerted = [];
  }

  // Pending staking rewards above a threshold, armed again once they are claimed (drop below).
  if (rules.rewards.enabled) {
    const pendingRaw = pendingStakingRewardRaw({
      stakedRaw: BigInt(curr.paper.staked),
      accRewardPerShareRaw: ctx.accRewardPerShareRaw,
      rewardDebtRaw: BigInt(curr.paper.rewardDebt),
      pendingBaseRaw: BigInt(curr.paper.pendingBase),
    });
    const usdc = wadNum(pendingRaw);
    if (usdc >= rules.rewards.aboveUsdc) {
      if (!state.rewardsArmed) {
        state.rewardsArmed = true;
        events.push({
          type: 'staking_rewards',
          dedupeKey: `rew:${address}:${curr.at}`,
          severity: 'info',
          title: `Staking rewards ready on ${label}`,
          body: `${fmtUsd(usdc)} USDC of staking rewards are pending (threshold ${fmtUsd(rules.rewards.aboveUsdc)}). Claim them in the Papertrade app.`,
          fields: [
            { name: 'Pending', value: `${fmtUsd(usdc)} USDC` },
            { name: 'Staked PAPER', value: fmtNum(wadNum(curr.paper.staked)) },
          ],
          data: { address, pendingRaw: pendingRaw.toString(), thresholdUsdc: rules.rewards.aboveUsdc },
          url,
        });
      }
    } else if (usdc < rules.rewards.aboveUsdc * 0.8) {
      state.rewardsArmed = false;
    }
  } else {
    state.rewardsArmed = false;
  }

  state.seeded = true;
  return { events, state };
}
