import type { ChannelKind, Env } from '../types.js';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '../lib/crypto.js';

export interface RenderedAlert {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  fields: { name: string; value: string }[];
  url?: string;
  createdAt: number;
  data: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status of the provider response, when there was one. */
  status?: number;
  /** Provider asked us to wait this long (429). */
  retryAfterMs?: number;
  /** Permanent failure: do not retry (revoked webhook, kicked bot). */
  permanent?: boolean;
  error?: string;
}

export interface ChannelTarget {
  id: string;
  kind: ChannelKind;
  target: string;
  secret: string | null;
}

export interface ChannelAvailability {
  kind: ChannelKind;
  enabled: boolean;
  reason: string | null;
}

const SEND_TIMEOUT_MS = 10_000;

export function channelAvailability(env: Env): ChannelAvailability[] {
  const tgMissing = [!env.TELEGRAM_BOT_TOKEN && 'TELEGRAM_BOT_TOKEN', !env.TELEGRAM_WEBHOOK_SECRET && 'TELEGRAM_WEBHOOK_SECRET'].filter(Boolean);
  return [
    { kind: 'telegram', enabled: tgMissing.length === 0, reason: tgMissing.length ? `Not configured. The operator must set ${tgMissing.join(' and ')}.` : null },
    { kind: 'discord', enabled: true, reason: null },
    { kind: 'webhook', enabled: true, reason: null },
  ];
}

export function insecureWebhooksAllowed(env: Env): boolean {
  return env.ALLOW_INSECURE_WEBHOOKS === 'true';
}

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);

export class TargetError extends Error {}

/** Validate and normalise a channel target. Throws TargetError with a message the UI can show. */
export function validateTarget(kind: ChannelKind, raw: string, env: Env): string {
  const value = raw.trim();
  if (kind === 'telegram') {
    if (!/^-?\d{1,20}$/.test(value)) throw new TargetError('Telegram chats are linked from the bot with /start <code>, not typed in.');
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetError('Enter a full URL, for example https://example.com/hooks/papertrade.');
  }
  if (url.username || url.password) throw new TargetError('Credentials in the URL are not allowed. Use the signature header instead.');
  if (kind === 'discord') {
    if (url.protocol !== 'https:' || !DISCORD_HOSTS.has(url.hostname) || !/^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) {
      throw new TargetError('That is not a Discord webhook URL. It looks like https://discord.com/api/webhooks/<id>/<token>.');
    }
    return `https://${url.hostname}${url.pathname}`;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(insecureWebhooksAllowed(env) && url.protocol === 'http:')) {
    throw new TargetError('Webhook URLs must use https.');
  }
  if (!insecureWebhooksAllowed(env) && (loopback || isPrivateHost(url.hostname))) {
    throw new TargetError('Webhook URLs must point to a public host.');
  }
  return url.toString();
}

/** Literal private and link-local addresses. Workers cannot reach private networks anyway; this gives an early, clear error. */
function isPrivateHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host.endsWith('.local') || host.endsWith('.internal') || host === '[::1]' || host.startsWith('[');
}

async function post(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
}

function retryAfter(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

const SEVERITY_COLOR = { info: 0x3b82f6, warning: 0xf59e0b, critical: 0xef4444 } as const;

export async function sendDiscord(target: string, alert: RenderedAlert, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const body = {
    username: 'Papertrade Alerts',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: alert.title.slice(0, 256),
        description: alert.body.slice(0, 2000),
        color: SEVERITY_COLOR[alert.severity],
        url: alert.url,
        fields: alert.fields.slice(0, 10).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024) || '-', inline: true })),
        timestamp: new Date(alert.createdAt).toISOString(),
        footer: { text: 'Unofficial. Not affiliated with Papertrade.' },
      },
    ],
  };
  try {
    const res = await post(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl);
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, status: res.status, retryAfterMs: res.status === 429 ? retryAfter(res) : undefined, permanent: res.status === 404 || res.status === 401, error: `Discord HTTP ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    return { ok: false, error: `Discord request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function webhookPayload(alert: RenderedAlert) {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    title: alert.title,
    body: alert.body,
    fields: alert.fields,
    url: alert.url ?? null,
    createdAt: new Date(alert.createdAt).toISOString(),
    data: alert.data,
  };
}

export async function sendWebhook(channel: ChannelTarget, alert: RenderedAlert, deliveryId: string, fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<SendResult> {
  const body = JSON.stringify(webhookPayload(alert));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'papertrade-alerts/0.1',
    'x-papertrade-alerts-event': alert.type,
    'x-papertrade-alerts-delivery': deliveryId,
  };
  if (channel.secret) headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhook(channel.secret, body, Math.floor(nowMs / 1000));
  try {
    const res = await post(channel.target, { method: 'POST', headers, body }, fetchImpl);
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: false,
      status: res.status,
      retryAfterMs: res.status === 429 ? retryAfter(res) : undefined,
      permanent: res.status === 410,
      error: `Webhook HTTP ${res.status}${text ? `: ${text}` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: `Webhook request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramText(alert: RenderedAlert): string {
  const lines = [`<b>${escapeHtml(alert.title)}</b>`, escapeHtml(alert.body)];
  if (alert.fields.length) lines.push('', ...alert.fields.map((f) => `${escapeHtml(f.name)}: <b>${escapeHtml(f.value)}</b>`));
  if (alert.url) lines.push('', `<a href="${escapeHtml(alert.url)}">Open in explorer</a>`);
  lines.push('', '<i>Unofficial. High leverage can lose your whole margin.</i>');
  return lines.join('\n').slice(0, 4000);
}

export interface TelegramApiResult {
  ok: boolean;
  status: number;
  retryAfterMs?: number;
  description?: string;
  result?: unknown;
}

export async function telegramApi(env: Env, method: string, payload: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<TelegramApiResult> {
  const res = await post(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    fetchImpl,
  );
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown; parameters?: { retry_after?: number } };
  return {
    ok: res.ok && json.ok === true,
    status: res.status,
    description: json.description,
    result: json.result,
    retryAfterMs: json.parameters?.retry_after !== undefined ? json.parameters.retry_after * 1000 : retryAfter(res),
  };
}

export async function sendTelegram(env: Env, chatId: string, alert: RenderedAlert, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, permanent: true, error: 'Telegram is not configured on this deployment (TELEGRAM_BOT_TOKEN).' };
  try {
    const r = await telegramApi(env, 'sendMessage', { chat_id: chatId, text: telegramText(alert), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, fetchImpl);
    if (r.ok) return { ok: true, status: r.status };
    return {
      ok: false,
      status: r.status,
      retryAfterMs: r.status === 429 ? r.retryAfterMs : undefined,
      permanent: r.status === 403 || r.status === 400 || r.status === 401,
      error: `Telegram HTTP ${r.status}${r.description ? `: ${r.description}` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: `Telegram request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function sendToChannel(env: Env, channel: ChannelTarget, alert: RenderedAlert, deliveryId: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  switch (channel.kind) {
    case 'telegram':
      return sendTelegram(env, channel.target, alert, fetchImpl);
    case 'discord':
      return sendDiscord(channel.target, alert, fetchImpl);
    case 'webhook':
      return sendWebhook(channel, alert, deliveryId, fetchImpl);
  }
}
