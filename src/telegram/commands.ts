import { telegramApi } from '../channels/index.js';
import { addWatch, ApiError, createAccount, listChannels, listWatches, parseAddress, removeWatch, updateWatchRules, LIMITS } from '../accounts.js';
import { applyShorthand, ValidationError } from '../engine/rules.js';
import { shortAddr } from '../engine/format.js';
import { newId } from '../lib/crypto.js';
import type { Env, WalletRules } from '../types.js';
import { parseUpdate, type ParsedCommand, type TelegramUpdate } from './parse.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HELP = [
  '<b>Papertrade Alerts</b> (unofficial)',
  '',
  '/watch &lt;address&gt; - alert on your wallet',
  '/follow &lt;address&gt; - get told when a wallet opens a position',
  '/unwatch &lt;address&gt; - stop watching',
  '/list - wallets and channels',
  '/thresholds [address] [liq=0.05 balance=100 key=3 rewards=10] - view or change thresholds (use key=off to disable)',
  '',
  'Liquidation distance is a percent of price. Balance is USD, key is days until a session key expires, rewards is pending USDC.',
].join('\n');

async function accountForChat(env: Env, chatId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT account_id FROM channels WHERE kind = 'telegram' AND target = ? LIMIT 1`).bind(chatId).first<{ account_id: string }>();
  return row?.account_id ?? null;
}

function describeRules(r: WalletRules): string {
  const on = (b: boolean, text: string) => (b ? text : 'off');
  return [
    `liquidation within ${on(r.liquidation.enabled, `${r.liquidation.belowPct}%`)}`,
    `balance change ${on(r.balance.enabled, `$${r.balance.changeUsd}`)}`,
    `session key ${on(r.sessionKey.enabled, `${r.sessionKey.withinDays}d`)}`,
    `rewards ${on(r.rewards.enabled, `$${r.rewards.aboveUsdc}`)}`,
    `trades ${[r.opened && 'opened', r.closed && 'closed', r.liquidated && 'liquidated'].filter(Boolean).join('/') || 'off'}`,
  ].join(', ');
}

/** Handle one parsed command and return the HTML reply. Pure with respect to Telegram: the caller sends the text. */
export async function handleCommand(env: Env, cmd: ParsedCommand, now = Date.now()): Promise<string> {
  try {
    if (cmd.command === 'help') return HELP;
    if (cmd.command === 'start') return await start(env, cmd, now);
    const accountId = await accountForChat(env, cmd.chatId);
    if (!accountId) return 'This chat is not set up yet. Send /start to create a subscription, or open the web app, add a Telegram channel and send the /start code it shows.';
    switch (cmd.command) {
      case 'watch':
      case 'follow': {
        if (!cmd.args[0]) return `Usage: /${cmd.command} &lt;0x address&gt;`;
        const address = parseAddress(cmd.args[0]);
        const role = cmd.command === 'follow' ? 'follow' : 'own';
        const { created } = await addWatch(env, accountId, { address, role }, now);
        return created
          ? `${role === 'follow' ? 'Following' : 'Watching'} <code>${address}</code>. First poll within a minute. /thresholds to tune.`
          : `Already ${role === 'follow' ? 'following' : 'watching'} <code>${address}</code>.`;
      }
      case 'unwatch': {
        if (!cmd.args[0]) return 'Usage: /unwatch &lt;0x address&gt;';
        const address = parseAddress(cmd.args[0]);
        const watches = (await listWatches(env, accountId)).filter((w) => w.address === address);
        if (!watches.length) return `Not watching <code>${address}</code>.`;
        for (const w of watches) await removeWatch(env, accountId, w.id);
        return `Stopped watching <code>${address}</code>.`;
      }
      case 'list': {
        const [watches, channels] = await Promise.all([listWatches(env, accountId), listChannels(env, accountId)]);
        const lines = ['<b>Wallets</b>'];
        if (!watches.length) lines.push('None yet. /watch &lt;address&gt; to add one.');
        for (const w of watches) lines.push(`${w.role === 'follow' ? 'follow' : 'watch'} <code>${w.address}</code>${w.label ? ` (${esc(w.label)})` : ''}`);
        lines.push('', '<b>Channels</b>', ...channels.map((c) => `${c.kind}: ${esc(c.label ?? c.display)}${c.status === 'paused' ? ' (paused)' : ''}`));
        return lines.join('\n');
      }
      case 'thresholds':
        return await thresholds(env, accountId, cmd);
      default:
        return `Unknown command /${esc(cmd.raw)}.\n\n${HELP}`;
    }
  } catch (err) {
    if (err instanceof ApiError || err instanceof ValidationError) return esc(err.message);
    throw err;
  }
}

async function start(env: Env, cmd: ParsedCommand, now: number): Promise<string> {
  const code = cmd.args[0];
  const existing = await accountForChat(env, cmd.chatId);
  if (code) {
    const link = await env.DB.prepare(`SELECT account_id, expires_at FROM link_codes WHERE code = ?`).bind(code).first<{ account_id: string; expires_at: number }>();
    if (!link || link.expires_at < now) return 'That link code is invalid or expired. Generate a new one in the web app.';
    if (existing && existing !== link.account_id) return 'This chat is already linked to a different subscription. Remove its Telegram channel in the web app first.';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channels (id, account_id, kind, target, label, status, created_at) VALUES (?, ?, 'telegram', ?, ?, 'active', ?)
         ON CONFLICT(account_id, kind, target) DO NOTHING`,
      ).bind(newId('chn'), link.account_id, cmd.chatId, cmd.chatType === 'private' ? 'Telegram DM' : 'Telegram group', now),
      env.DB.prepare(`DELETE FROM link_codes WHERE code = ?`).bind(code),
    ]);
    return 'Linked. Alerts for your subscription will arrive here. /list shows what you are watching, /help shows commands.';
  }
  if (existing) return 'This chat is already linked. /list shows your wallets, /help shows commands.';
  const { account, token } = await createAccount(env, `telegram:${cmd.chatId}`, now);
  await env.DB.prepare(`INSERT INTO channels (id, account_id, kind, target, label, status, created_at) VALUES (?, ?, 'telegram', ?, ?, 'active', ?)`)
    .bind(newId('chn'), account.id, cmd.chatId, cmd.chatType === 'private' ? 'Telegram DM' : 'Telegram group', now)
    .run();
  return [
    'Subscription created. Add a wallet with /watch &lt;address&gt;.',
    '',
    'Management token (shown once, paste it into the web app to manage this subscription from a browser):',
    `<code>${token}</code>`,
    '',
    `Limits: ${LIMITS.watchesPerAccount} wallets, ${LIMITS.channelsPerAccount} channels. /help lists commands.`,
    '',
    '<i>Unofficial. Not affiliated with Papertrade. High leverage can lose your whole margin.</i>',
  ].join('\n');
}

async function thresholds(env: Env, accountId: string, cmd: ParsedCommand): Promise<string> {
  const watches = (await listWatches(env, accountId)).filter((w) => w.role === 'own');
  if (!watches.length) return 'No watched wallets. /watch &lt;address&gt; first.';
  const first = cmd.args[0];
  const hasAddress = first !== undefined && /^0x/i.test(first);
  const target = hasAddress ? parseAddress(first) : null;
  const rest = hasAddress ? cmd.args.slice(1) : cmd.args;
  const selected = target ? watches.filter((w) => w.address === target) : watches;
  if (!selected.length) return `Not watching <code>${target}</code>.`;
  if (!rest.length) return selected.map((w) => `<code>${shortAddr(w.address)}</code>: ${describeRules(w.rules)}`).join('\n');
  const lines: string[] = [];
  for (const w of selected) {
    const { rules } = applyShorthand(w.rules, rest);
    const updated = await updateWatchRules(env, accountId, w.id, { rules });
    lines.push(`<code>${shortAddr(w.address)}</code>: ${describeRules(updated.rules)}`);
  }
  return `Updated.\n${lines.join('\n')}`;
}

/** Process one webhook update end to end: parse, run the command, reply. Never throws to Telegram (a 5xx would make it retry the update). */
export async function processUpdate(env: Env, update: TelegramUpdate, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ handled: boolean; command?: string }> {
  const cmd = parseUpdate(update, env.TELEGRAM_BOT_USERNAME);
  if (!cmd) return { handled: false };
  let reply: string;
  try {
    reply = await handleCommand(env, cmd, now);
  } catch (err) {
    console.error('telegram command failed', cmd.command, err instanceof Error ? err.message : err);
    reply = 'Something went wrong on our side. Try again in a minute.';
  }
  await telegramApi(env, 'sendMessage', { chat_id: cmd.chatId, text: reply, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, fetchImpl).catch((err) => console.error('telegram reply failed', err instanceof Error ? err.message : err));
  return { handled: true, command: cmd.command };
}
