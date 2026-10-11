import { describe, expect, it } from 'vitest';
import { TargetError, validateTarget } from '../src/channels/index.js';
import { backoffMs, MAX_ATTEMPTS, nextState } from '../src/engine/delivery.js';
import { applyShorthand, defaultRulesFor, normalizeProtocolRules, normalizeWalletRules, ValidationError } from '../src/engine/rules.js';
import type { Env } from '../src/types.js';

const env = (over: Partial<Env> = {}) => ({ ...over }) as Env;

describe('rules', () => {
  it('applies Telegram shorthand and turns types off with "off"', () => {
    const { rules, changed } = applyShorthand(defaultRulesFor('own'), ['liq=0.2', 'balance=250', 'key=7', 'rewards=30']);
    expect(changed).toEqual(['liq', 'balance', 'key', 'rewards']);
    expect(rules.liquidation).toEqual({ enabled: true, belowPct: 0.2 });
    expect(rules.balance).toEqual({ enabled: true, changeUsd: 250 });
    expect(rules.sessionKey.withinDays).toBe(7);
    expect(rules.rewards.aboveUsdc).toBe(30);
    expect(applyShorthand(rules, ['liq=off']).rules.liquidation.enabled).toBe(false);
  });

  it('rejects malformed shorthand, out-of-range values and unknown keys', () => {
    expect(() => applyShorthand(defaultRulesFor('own'), ['liq'])).toThrow(ValidationError);
    expect(() => applyShorthand(defaultRulesFor('own'), ['liq=9999'])).toThrow(ValidationError);
    expect(() => applyShorthand(defaultRulesFor('own'), ['nope=1'])).toThrow(ValidationError);
    expect(() => normalizeWalletRules({ liquidation: { belowPct: 'x' } }, defaultRulesFor('own'))).toThrow(ValidationError);
    expect(() => normalizeWalletRules({ surprise: true }, defaultRulesFor('own'))).toThrow(/Unknown rule/);
  });

  it('merges partial rules over a base and validates protocol rules', () => {
    expect(normalizeWalletRules({ opened: false }, defaultRulesFor('own')).opened).toBe(false);
    expect(normalizeProtocolRules({ mintRate: { enabled: true, threshold: 12 } }, { mintRate: { enabled: false, threshold: 40 }, marketStatus: true }).mintRate).toEqual({ enabled: true, threshold: 12 });
    expect(() => normalizeProtocolRules({ mintRate: { threshold: -1 } }, { mintRate: { enabled: false, threshold: 40 }, marketStatus: true })).toThrow(ValidationError);
  });

  it('a followed wallet defaults to trade events only', () => {
    const r = defaultRulesFor('follow');
    expect([r.opened, r.liquidation.enabled, r.sessionKey.enabled, r.balance.enabled]).toEqual([true, false, false, false]);
  });
});

describe('delivery retry policy', () => {
  it('doubles the backoff from 30s and caps it', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(30)).toBe(30 * 60_000);
  });

  it('marks success as sent', () => {
    expect(nextState(0, { ok: true, status: 204 }, 1000)).toMatchObject({ status: 'sent', attempts: 1, httpStatus: 204 });
  });

  it('retries transient failures with backoff and honors a longer Retry-After', () => {
    const r = nextState(1, { ok: false, status: 500, error: 'HTTP 500' }, 1000);
    expect(r).toMatchObject({ status: 'pending', attempts: 2, nextAttemptAt: 1000 + 60_000 });
    const limited = nextState(0, { ok: false, status: 429, error: 'rate limited', retryAfterMs: 5 * 60_000 }, 1000);
    expect(limited.nextAttemptAt).toBe(1000 + 5 * 60_000);
  });

  it('sends permanent errors and exhausted retries to the dead-letter queue', () => {
    expect(nextState(0, { ok: false, status: 404, error: 'gone', permanent: true }, 1000).status).toBe('dead');
    expect(nextState(MAX_ATTEMPTS - 1, { ok: false, status: 500, error: 'HTTP 500' }, 1000).status).toBe('dead');
  });
});

describe('channel target validation', () => {
  it('accepts a Discord webhook and rejects other hosts', () => {
    expect(validateTarget('discord', 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi', env())).toContain('discord.com');
    expect(() => validateTarget('discord', 'https://evil.example/api/webhooks/1/x', env())).toThrow(TargetError);
    expect(() => validateTarget('discord', 'http://discord.com/api/webhooks/1/x', env())).toThrow(TargetError);
  });

  it('requires public https for webhooks unless insecure mode is on', () => {
    expect(validateTarget('webhook', 'https://example.com/hook', env())).toBe('https://example.com/hook');
    for (const bad of ['http://example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://169.254.169.254/x', 'https://user:pw@example.com/x', 'not a url']) {
      expect(() => validateTarget('webhook', bad, env()), bad).toThrow(TargetError);
    }
    expect(validateTarget('webhook', 'http://127.0.0.1:8797/hook', env({ ALLOW_INSECURE_WEBHOOKS: 'true' }))).toBe('http://127.0.0.1:8797/hook');
  });

  it('only accepts numeric Telegram chat ids', () => {
    expect(validateTarget('telegram', '-100123', env())).toBe('-100123');
    expect(() => validateTarget('telegram', '@name', env())).toThrow(TargetError);
  });
});
