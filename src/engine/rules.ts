import type { ProtocolRules, WalletRules, WatchRole } from '../types.js';

export const DEFAULT_WALLET_RULES: WalletRules = {
  liquidation: { enabled: true, belowPct: 0.05 },
  opened: true,
  closed: true,
  liquidated: true,
  balance: { enabled: false, changeUsd: 100 },
  sessionKey: { enabled: true, withinDays: 3 },
  rewards: { enabled: false, aboveUsdc: 10 },
};

/** A followed leaderboard wallet only reports trades, never account-level thresholds. */
export const DEFAULT_FOLLOW_RULES: WalletRules = {
  liquidation: { enabled: false, belowPct: 0.05 },
  opened: true,
  closed: false,
  liquidated: false,
  balance: { enabled: false, changeUsd: 100 },
  sessionKey: { enabled: false, withinDays: 3 },
  rewards: { enabled: false, aboveUsdc: 10 },
};

export const DEFAULT_PROTOCOL_RULES: ProtocolRules = {
  mintRate: { enabled: false, threshold: 40 },
  marketStatus: true,
};

export const LIMITS = {
  liquidationPct: { min: 0.001, max: 50 },
  balanceUsd: { min: 1, max: 1_000_000_000 },
  sessionKeyDays: { min: 1, max: 30 },
  rewardsUsdc: { min: 0.01, max: 1_000_000_000 },
  mintRate: { min: 0.01, max: 1000 },
} as const;

export class ValidationError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new ValidationError('Expected a boolean.');
  return v;
}

function num(v: unknown, fallback: number, label: string, { min, max }: { min: number; max: number }): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${label} must be a number.`);
  if (v < min || v > max) throw new ValidationError(`${label} must be between ${min} and ${max}.`);
  return v;
}

function section<T extends Record<string, unknown>>(v: unknown, label: string): Partial<T> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new ValidationError(`${label} must be an object.`);
  return v as Partial<T>;
}

/** Merge a partial rules object over a base, validating every field. Unknown keys are rejected. */
export function normalizeWalletRules(input: unknown, base: WalletRules): WalletRules {
  if (input === undefined) return base;
  if (!isObj(input)) throw new ValidationError('rules must be an object.');
  const known = new Set(['liquidation', 'opened', 'closed', 'liquidated', 'balance', 'sessionKey', 'rewards']);
  for (const k of Object.keys(input)) if (!known.has(k)) throw new ValidationError(`Unknown rule "${k}".`);
  const liq = section<{ enabled: boolean; belowPct: number }>(input.liquidation, 'liquidation');
  const bal = section<{ enabled: boolean; changeUsd: number }>(input.balance, 'balance');
  const key = section<{ enabled: boolean; withinDays: number }>(input.sessionKey, 'sessionKey');
  const rew = section<{ enabled: boolean; aboveUsdc: number }>(input.rewards, 'rewards');
  return {
    liquidation: {
      enabled: bool(liq.enabled, base.liquidation.enabled),
      belowPct: num(liq.belowPct, base.liquidation.belowPct, 'Liquidation distance', LIMITS.liquidationPct),
    },
    opened: bool(input.opened, base.opened),
    closed: bool(input.closed, base.closed),
    liquidated: bool(input.liquidated, base.liquidated),
    balance: {
      enabled: bool(bal.enabled, base.balance.enabled),
      changeUsd: num(bal.changeUsd, base.balance.changeUsd, 'Balance change', LIMITS.balanceUsd),
    },
    sessionKey: {
      enabled: bool(key.enabled, base.sessionKey.enabled),
      withinDays: num(key.withinDays, base.sessionKey.withinDays, 'Session key days', LIMITS.sessionKeyDays),
    },
    rewards: {
      enabled: bool(rew.enabled, base.rewards.enabled),
      aboveUsdc: num(rew.aboveUsdc, base.rewards.aboveUsdc, 'Staking rewards', LIMITS.rewardsUsdc),
    },
  };
}

export function normalizeProtocolRules(input: unknown, base: ProtocolRules): ProtocolRules {
  if (input === undefined) return base;
  if (!isObj(input)) throw new ValidationError('protocol rules must be an object.');
  for (const k of Object.keys(input)) if (k !== 'mintRate' && k !== 'marketStatus') throw new ValidationError(`Unknown rule "${k}".`);
  const mint = section<{ enabled: boolean; threshold: number }>(input.mintRate, 'mintRate');
  return {
    mintRate: {
      enabled: bool(mint.enabled, base.mintRate.enabled),
      threshold: num(mint.threshold, base.mintRate.threshold, 'Mint rate', LIMITS.mintRate),
    },
    marketStatus: bool(input.marketStatus, base.marketStatus),
  };
}

export const defaultRulesFor = (role: WatchRole): WalletRules => structuredClone(role === 'follow' ? DEFAULT_FOLLOW_RULES : DEFAULT_WALLET_RULES);

export function parseStoredWalletRules(json: string, role: WatchRole): WalletRules {
  try {
    return normalizeWalletRules(JSON.parse(json), defaultRulesFor(role));
  } catch {
    return defaultRulesFor(role);
  }
}

export function parseStoredProtocolRules(json: string): ProtocolRules {
  try {
    return normalizeProtocolRules(JSON.parse(json), structuredClone(DEFAULT_PROTOCOL_RULES));
  } catch {
    return structuredClone(DEFAULT_PROTOCOL_RULES);
  }
}

/** Telegram `/thresholds` shorthand keys. */
const SHORTHAND: Record<string, (rules: WalletRules, value: number) => void> = {
  liq: (r, v) => {
    r.liquidation = { enabled: true, belowPct: num(v, 0, 'liq', LIMITS.liquidationPct) };
  },
  balance: (r, v) => {
    r.balance = { enabled: true, changeUsd: num(v, 0, 'balance', LIMITS.balanceUsd) };
  },
  key: (r, v) => {
    r.sessionKey = { enabled: true, withinDays: num(v, 0, 'key', LIMITS.sessionKeyDays) };
  },
  rewards: (r, v) => {
    r.rewards = { enabled: true, aboveUsdc: num(v, 0, 'rewards', LIMITS.rewardsUsdc) };
  },
};

/**
 * Apply `liq=0.1 balance=250 key=5 rewards=20` (or `liq=off`) to a rules object.
 * Returns the new rules and the keys that were changed; throws ValidationError on bad input.
 */
export function applyShorthand(rules: WalletRules, tokens: string[]): { rules: WalletRules; changed: string[] } {
  const next = structuredClone(rules);
  const changed: string[] = [];
  for (const token of tokens) {
    const m = /^([a-z]+)=(.+)$/i.exec(token);
    if (!m) throw new ValidationError(`"${token}" is not key=value. Keys: liq, balance, key, rewards.`);
    const key = m[1].toLowerCase();
    const raw = m[2].toLowerCase();
    const apply = SHORTHAND[key];
    if (!apply) throw new ValidationError(`Unknown threshold "${key}". Keys: liq, balance, key, rewards.`);
    if (raw === 'off') {
      const section = { liq: 'liquidation', balance: 'balance', key: 'sessionKey', rewards: 'rewards' }[key] as 'liquidation' | 'balance' | 'sessionKey' | 'rewards';
      next[section].enabled = false;
    } else {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ValidationError(`"${m[2]}" is not a number.`);
      apply(next, value);
    }
    changed.push(key);
  }
  return { rules: next, changed };
}
