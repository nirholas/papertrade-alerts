import { paperMintRate, wadToNumber } from 'papertrade-sdk';
import type { AlertEvent, InstrumentInfo, ProtocolRules } from '../types.js';
import { fmtNum } from './format.js';

export type MarketStatus = 'open' | 'paused' | 'close_only' | 'inactive';

/** What the protocol looked like at one poll. Stored in `kv` and diffed on the next one. */
export interface ProtocolSnapshot {
  at: number;
  tradingPaused: boolean;
  markets: Record<string, MarketStatus>;
  mintRate: number;
}

export interface TradingStateLike {
  tradingPaused: boolean;
  instruments: { id: number; symbol: string; active: boolean; paused: boolean; closeOnly: boolean; terminal: boolean; retired: boolean }[];
}

export interface SummaryLike {
  paper: { trackedLp: string; tailProgress: string };
}

export function marketStatus(i: TradingStateLike['instruments'][number]): MarketStatus {
  if (!i.active || i.retired || i.terminal) return 'inactive';
  if (i.paused) return 'paused';
  if (i.closeOnly) return 'close_only';
  return 'open';
}

export function protocolSnapshot(trading: TradingStateLike, summary: SummaryLike, at: number): ProtocolSnapshot {
  return {
    at,
    tradingPaused: trading.tradingPaused,
    markets: Object.fromEntries(trading.instruments.map((i) => [String(i.id), marketStatus(i)])),
    mintRate: paperMintRate({ trackedLpUsd: wadToNumber(BigInt(summary.paper.trackedLp)), tailProgressUsd: wadToNumber(BigInt(summary.paper.tailProgress)) }),
  };
}

export interface ProtocolEvents {
  /** Applies to every account with the marketStatus rule on. */
  market: AlertEvent[];
  /** Mint-rate crossings, evaluated per account threshold. */
  mintRate: (rules: ProtocolRules) => AlertEvent | null;
}

const STATUS_WORDS: Record<MarketStatus, string> = {
  open: 'open for trading',
  paused: 'paused',
  close_only: 'close-only (no new positions)',
  inactive: 'inactive',
};

/** Diff two protocol snapshots. Returns market events now and a function that decides mint-rate crossings per account. */
export function diffProtocol(prev: ProtocolSnapshot | null, curr: ProtocolSnapshot, instruments: Record<number, InstrumentInfo>): ProtocolEvents {
  const market: AlertEvent[] = [];
  if (prev) {
    if (prev.tradingPaused !== curr.tradingPaused) {
      market.push({
        type: 'market_status',
        dedupeKey: `mkt:all:${curr.tradingPaused ? 'paused' : 'resumed'}:${curr.at}`,
        severity: curr.tradingPaused ? 'critical' : 'info',
        title: curr.tradingPaused ? 'Papertrade trading is paused' : 'Papertrade trading resumed',
        body: curr.tradingPaused ? 'Trading is paused protocol-wide. New positions cannot be opened.' : 'Protocol-wide trading pause was lifted.',
        fields: [{ name: 'Trading', value: curr.tradingPaused ? 'paused' : 'live' }],
        data: { scope: 'protocol', tradingPaused: curr.tradingPaused },
      });
    }
    for (const [id, status] of Object.entries(curr.markets)) {
      const before = prev.markets[id];
      if (before === undefined || before === status) continue;
      const symbol = instruments[Number(id)]?.symbol ?? `Market ${id}`;
      market.push({
        type: 'market_status',
        dedupeKey: `mkt:${id}:${status}:${curr.at}`,
        severity: status === 'open' ? 'info' : 'warning',
        title: status === 'open' ? `${symbol} market reopened` : `${symbol} market is ${status === 'close_only' ? 'close-only' : status}`,
        body: `${symbol} is now ${STATUS_WORDS[status]} (was ${STATUS_WORDS[before]}).`,
        fields: [{ name: 'Market', value: symbol }, { name: 'Status', value: STATUS_WORDS[status] }],
        data: { scope: 'market', instrumentId: Number(id), symbol, status, previous: before },
      });
    }
  }
  return {
    market,
    mintRate: (rules) => {
      if (!prev || !rules.mintRate.enabled) return null;
      const t = rules.mintRate.threshold;
      const crossedDown = prev.mintRate >= t && curr.mintRate < t;
      const crossedUp = prev.mintRate < t && curr.mintRate >= t;
      if (!crossedDown && !crossedUp) return null;
      return {
        type: 'mint_rate',
        dedupeKey: `mint:${t}:${crossedDown ? 'down' : 'up'}:${curr.at}`,
        severity: 'info',
        title: `PAPER mint rate crossed ${fmtNum(t)}`,
        body: `The PAPER mint rate moved ${crossedDown ? 'below' : 'above'} ${fmtNum(t)} PAPER per $1 of loss (now ${fmtNum(curr.mintRate)}, was ${fmtNum(prev.mintRate)}).`,
        fields: [
          { name: 'Rate now', value: `${fmtNum(curr.mintRate)} PAPER per $1` },
          { name: 'Threshold', value: fmtNum(t) },
        ],
        data: { scope: 'protocol', mintRate: curr.mintRate, previous: prev.mintRate, threshold: t, direction: crossedDown ? 'down' : 'up' },
      };
    },
  };
}
