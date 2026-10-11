export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PAPERTRADE_API_URL?: string;
  EXPLORER_URL?: string;
  /** Canonical public origin (e.g. a custom domain). Defaults to the origin each request arrives on. */
  PUBLIC_ORIGIN?: string;
  /** Wallets polled per cron tick (Workers Free allows 50 subrequests per invocation, Paid 10000). */
  MAX_WALLETS_PER_TICK?: string;
  /** Allow http:// and loopback webhook targets. Local development only. */
  ALLOW_INSECURE_WEBHOOKS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
}

export type ChannelKind = 'telegram' | 'discord' | 'webhook';
export type WatchRole = 'own' | 'follow';

export type AlertType =
  | 'liquidation_distance'
  | 'position_opened'
  | 'position_closed'
  | 'position_liquidated'
  | 'balance_change'
  | 'session_key_expiring'
  | 'staking_rewards'
  | 'mint_rate'
  | 'market_status'
  | 'follow_opened'
  | 'test';

export interface WalletRules {
  liquidation: { enabled: boolean; belowPct: number };
  opened: boolean;
  closed: boolean;
  liquidated: boolean;
  balance: { enabled: boolean; changeUsd: number };
  sessionKey: { enabled: boolean; withinDays: number };
  rewards: { enabled: boolean; aboveUsdc: number };
}

export interface ProtocolRules {
  mintRate: { enabled: boolean; threshold: number };
  marketStatus: boolean;
}

/** Everything the diff engine needs to know about a wallet, in JSON-safe form (bigints as decimal strings). */
export interface CompactPosition {
  id: string;
  /** instrument id */
  i: number;
  /** is long */
  l: boolean;
  /** entry price raw */
  e: string;
  /** margin wad */
  m: string;
  /** leverage */
  x: number;
  /** bust price raw */
  b: string;
  /** opened at ms */
  o: number;
}

export interface CompactSnapshot {
  at: number;
  /** balance + locked margin, wad */
  equity: string;
  available: string;
  positions: CompactPosition[];
  /** [session key address, expiry unix seconds] */
  keys: [string, number][];
  paper: { staked: string; pendingBase: string; rewardDebt: string };
}

export interface PendingClose extends CompactPosition {
  firstSeen: number;
}

/** Per-watch memory that makes the diff engine edge-triggered instead of level-triggered. */
export interface WatchState {
  seeded?: boolean;
  /** Position ids currently inside the liquidation-distance threshold (already alerted). */
  liqArmed?: string[];
  pendingClose?: PendingClose[];
  balanceBaseline?: string;
  rewardsArmed?: boolean;
  keysAlerted?: string[];
}

export interface AlertEvent {
  type: AlertType;
  dedupeKey: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  fields: { name: string; value: string }[];
  data: Record<string, unknown>;
  url?: string;
}

export interface TradeRow {
  positionId: string;
  kind: 'PositionClosed' | 'Liquidated';
  timestampMs: number;
  txHash: string;
  adjustedPnlRaw: string;
  userPaidFeeRaw: string;
  paperMintedRaw: string;
}

export interface InstrumentInfo {
  id: number;
  symbol: string;
  priceScale: number;
}
