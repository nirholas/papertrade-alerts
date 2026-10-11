#!/usr/bin/env node
// Register (or with --delete, remove) the Telegram webhook for a deployed Worker.
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/set-telegram-webhook.mjs https://papertrade-alerts.<you>.workers.dev
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const remove = process.argv.includes('--delete');
const base = process.argv.slice(2).find((a) => a.startsWith('https://'));

if (!token) fail('Set TELEGRAM_BOT_TOKEN (from @BotFather).');
if (!remove && !secret) fail('Set TELEGRAM_WEBHOOK_SECRET (any 1-256 chars of A-Z a-z 0-9 _ -, for example the output of: openssl rand -hex 24).');
if (!remove && !base) fail('Pass the public https URL of your Worker as the first argument.');
if (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) fail('TELEGRAM_WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ -.');

const call = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
};

const result = remove
  ? await call('deleteWebhook', { drop_pending_updates: true })
  : await call('setWebhook', { url: `${base.replace(/\/+$/, '')}/api/telegram/webhook`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
if (!remove) {
  const info = await call('getWebhookInfo', {});
  console.log(JSON.stringify({ url: info.result?.url, pending: info.result?.pending_update_count, lastError: info.result?.last_error_message ?? null }, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
