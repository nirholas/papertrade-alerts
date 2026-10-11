import { distanceToLiquidation, fetchWalletState, PapertradeClient, pendingStakingRewardRaw } from 'papertrade-sdk';
import type { Address } from 'viem';
import { fetchMarks, instrumentMap } from './engine/tick.js';
import { wadNum } from './engine/format.js';
import { compactSnapshot } from './engine/snapshot.js';
import type { Env, WalletRules } from './types.js';

export interface WalletPreview {
  address: string;
  asOf: string;
  equityUsd: number;
  availableUsd: number;
  positions: Array<{
    positionId: string;
    market: string;
    side: 'long' | 'short';
    leverage: number;
    marginUsd: number;
    entryPrice: number;
    markPrice: number | null;
    bustPrice: number;
    distanceToLiquidationPct: number | null;
    wouldAlert: boolean;
  }>;
  sessionKeys: Array<{ key: string; expiresAt: string; daysLeft: number; wouldAlert: boolean }>;
  pendingRewardsUsdc: number;
  rewardsWouldAlert: boolean;
  rulesApplied: WalletRules;
  notes: string[];
}

/**
 * Read a wallet from the real Papertrade API and report which of the given rules would be firing right now.
 * Pure read: it writes nothing and notifies nobody. Costs one wallet read plus one price read per active market.
 */
export async function previewWallet(env: Env, address: string, rules: WalletRules, now = Date.now()): Promise<WalletPreview> {
  const baseUrl = (env.PAPERTRADE_API_URL ?? 'https://exchange.papertrade.xyz').replace(/\/+$/, '');
  const client = new PapertradeClient({ baseUrl, clientBuild: 'papertrade-alerts/0.1', retries: 1 });
  const [trading, state] = await Promise.all([client.tradingState(), fetchWalletState(address as Address, { baseUrl, timeoutMs: 15_000 })]);
  const notes: string[] = [];
  let marks: Record<number, bigint> = {};
  try {
    marks = await fetchMarks(client, trading, now);
  } catch (err) {
    notes.push(`Mark prices were unavailable (${err instanceof Error ? err.message : 'unknown error'}), so liquidation distance is null.`);
  }
  const instruments = instrumentMap(trading);
  const snap = compactSnapshot(state, now);
  const threshold = rules.liquidation.belowPct / 100;
  const nowSec = Math.floor(now / 1000);

  const positions = snap.positions.map((p) => {
    const info = instruments[p.i];
    const scale = info?.priceScale ?? 1;
    const mark = marks[p.i];
    const dist = mark === undefined ? null : distanceToLiquidation({ isLong: p.l, markPriceRaw: mark, bustPriceRaw: BigInt(p.b) });
    return {
      positionId: p.id,
      market: info?.symbol ?? `Market ${p.i}`,
      side: (p.l ? 'long' : 'short') as 'long' | 'short',
      leverage: p.x,
      marginUsd: wadNum(p.m),
      entryPrice: Number(p.e) / scale,
      markPrice: mark === undefined ? null : Number(mark) / scale,
      bustPrice: Number(p.b) / scale,
      distanceToLiquidationPct: dist === null ? null : Number((Math.max(dist, 0) * 100).toFixed(4)),
      wouldAlert: rules.liquidation.enabled && dist !== null && dist < threshold,
    };
  });

  const sessionKeys = snap.keys.map(([key, expiry]) => ({
    key,
    expiresAt: new Date(expiry * 1000).toISOString(),
    daysLeft: Number(((expiry - nowSec) / 86_400).toFixed(2)),
    wouldAlert: rules.sessionKey.enabled && expiry > nowSec && expiry <= nowSec + rules.sessionKey.withinDays * 86_400,
  }));

  const pendingRewardsUsdc = wadNum(
    pendingStakingRewardRaw({
      stakedRaw: BigInt(snap.paper.staked),
      accRewardPerShareRaw: trading.accRewardPerShareRaw,
      rewardDebtRaw: BigInt(snap.paper.rewardDebt),
      pendingBaseRaw: BigInt(snap.paper.pendingBase),
    }),
  );
  if (!positions.length) notes.push('This wallet has no open positions right now.');
  return {
    address,
    asOf: new Date(now).toISOString(),
    equityUsd: wadNum(snap.equity),
    availableUsd: wadNum(snap.available),
    positions,
    sessionKeys,
    pendingRewardsUsdc,
    rewardsWouldAlert: rules.rewards.enabled && pendingRewardsUsdc >= rules.rewards.aboveUsdc,
    rulesApplied: rules,
    notes,
  };
}
