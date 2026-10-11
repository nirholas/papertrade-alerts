import type { WalletState } from 'papertrade-sdk';
import type { CompactSnapshot } from '../types.js';

/** Reduce the SDK's decoded wallet state to the JSON-safe fields the diff engine and D1 care about. */
export function compactSnapshot(state: WalletState, at: number): CompactSnapshot {
  return {
    at,
    equity: (state.balance + state.locked).toString(),
    available: state.funds.availableBalance.toString(),
    positions: state.positions.map((p) => ({
      id: p.positionId.toString(),
      i: p.instrumentId,
      l: p.isLong,
      e: p.entryPriceRaw.toString(),
      m: p.marginRaw.toString(),
      x: p.leverage,
      b: p.bustPriceRaw.toString(),
      o: p.openedAtMs,
    })),
    keys: Object.entries(state.sessionKeys).map(([key, expiry]) => [key, Number(expiry)] as [string, number]),
    paper: {
      staked: state.paper.staked.toString(),
      pendingBase: state.paper.pendingBase.toString(),
      rewardDebt: state.paper.rewardDebt.toString(),
    },
  };
}
