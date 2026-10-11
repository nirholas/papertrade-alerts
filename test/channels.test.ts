import { describe, expect, it } from 'vitest';
import { sendDiscord, sendTelegram, sendWebhook, telegramText, type RenderedAlert } from '../src/channels/index.js';
import { verifyWebhookSignature } from '../src/lib/crypto.js';
import type { Env } from '../src/types.js';

const alert: RenderedAlert = {
  id: 'alt_1', type: 'position_closed', severity: 'warning', title: 'Closed <b>BTC</b> & co', body: 'Net PnL -$12.00', fields: [{ name: 'Market', value: 'BTC long' }],
  createdAt: 1791665000000, url: 'https://papertrade-explorer.pages.dev/wallet/0xabc', data: { positionId: '1' },
};

interface Seen { url: string; init: RequestInit }
const recorder = (respond: () => Response) => {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { seen, impl };
};

describe('webhook channel', () => {
  it('posts the JSON body with a verifiable signature and event/delivery headers', async () => {
    const { seen, impl } = recorder(() => new Response('ok', { status: 200 }));
    const now = 1791665000000;
    const r = await sendWebhook({ id: 'chn_t', kind: 'webhook', target: 'https://example.com/h', secret: 'whsec_x' }, alert, 'dlv_9', impl, now);
    expect(r.ok).toBe(true);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['x-papertrade-alerts-event']).toBe('position_closed');
    expect(headers['x-papertrade-alerts-delivery']).toBe('dlv_9');
    expect(await verifyWebhookSignature('whsec_x', seen[0].init.body as string, headers['x-papertrade-alerts-signature'], Math.floor(now / 1000))).toBe(true);
  });

  it('surfaces 429 Retry-After and treats 5xx as retryable, 410 as permanent', async () => {
    const limited = await sendWebhook({ id: 'chn_t', kind: 'webhook', target: 'https://example.com/h', secret: null }, alert, 'd', recorder(() => new Response('slow down', { status: 429, headers: { 'retry-after': '90' } })).impl);
    expect(limited).toMatchObject({ ok: false, status: 429, retryAfterMs: 90_000 });
    expect((await sendWebhook({ id: 'chn_t', kind: 'webhook', target: 'https://example.com/h', secret: null }, alert, 'd', recorder(() => new Response('x', { status: 503 })).impl)).permanent).toBeFalsy();
    expect((await sendWebhook({ id: 'chn_t', kind: 'webhook', target: 'https://example.com/h', secret: null }, alert, 'd', recorder(() => new Response('', { status: 410 })).impl)).permanent).toBe(true);
  });

  it('turns a network failure into a retryable error result', async () => {
    const r = await sendWebhook({ id: 'chn_t', kind: 'webhook', target: 'https://example.com/h', secret: null }, alert, 'd', (async () => { throw new Error('ECONNRESET'); }) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNRESET');
  });
});

describe('discord channel', () => {
  it('sends an embed that cannot ping anyone', async () => {
    const { seen, impl } = recorder(() => new Response(null, { status: 204 }));
    expect((await sendDiscord('https://discord.com/api/webhooks/1/x', alert, impl)).ok).toBe(true);
    const body = JSON.parse(seen[0].init.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].title).toBe(alert.title);
  });

  it('marks a deleted webhook (404) permanent', async () => {
    expect((await sendDiscord('https://discord.com/api/webhooks/1/x', alert, recorder(() => new Response('{}', { status: 404 })).impl)).permanent).toBe(true);
  });
});

describe('telegram channel', () => {
  const env = { TELEGRAM_BOT_TOKEN: '123:abc' } as Env;

  it('escapes untrusted text and sends via the Bot API', async () => {
    expect(telegramText(alert)).toContain('&lt;b&gt;BTC&lt;/b&gt; &amp; co');
    const { seen, impl } = recorder(() => Response.json({ ok: true, result: {} }));
    expect((await sendTelegram(env, '-100', alert, impl)).ok).toBe(true);
    expect(seen[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(seen[0].init.body as string)).toMatchObject({ chat_id: '-100', parse_mode: 'HTML' });
  });

  it('uses Telegram retry_after for flood control and marks a blocked bot (403) permanent', async () => {
    const flood = await sendTelegram(env, '1', alert, recorder(() => Response.json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }, { status: 429 })).impl);
    expect(flood).toMatchObject({ ok: false, retryAfterMs: 7000 });
    const blocked = await sendTelegram(env, '1', alert, recorder(() => Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 })).impl);
    expect(blocked.permanent).toBe(true);
  });

  it('is disabled without a bot token', async () => {
    const r = await sendTelegram({} as Env, '1', alert, recorder(() => new Response()).impl);
    expect(r).toMatchObject({ ok: false, permanent: true });
  });
});
