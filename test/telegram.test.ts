import { describe, expect, it } from 'vitest';
import { parseUpdate, type TelegramUpdate } from '../src/telegram/parse.js';

const msg = (text: string, extra: Partial<NonNullable<TelegramUpdate['message']>> = {}): TelegramUpdate => ({ update_id: 1, message: { message_id: 1, text, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false }, ...extra } });

describe('Telegram update parsing', () => {
  it('parses commands and arguments', () => {
    expect(parseUpdate(msg('/watch 0xabc  my wallet'))).toMatchObject({ chatId: '4242', command: 'watch', args: ['0xabc', 'my', 'wallet'] });
    expect(parseUpdate(msg('/start LINK123'))).toMatchObject({ command: 'start', args: ['LINK123'] });
    expect(parseUpdate(msg('/thresholds liq=0.1 key=5'))?.args).toEqual(['liq=0.1', 'key=5']);
  });

  it('is case-insensitive and recognises every documented command', () => {
    for (const c of ['start', 'watch', 'follow', 'unwatch', 'list', 'thresholds', 'help']) expect(parseUpdate(msg(`/${c.toUpperCase()}`))?.command).toBe(c);
  });

  it('accepts commands addressed to this bot and ignores ones addressed to another bot', () => {
    expect(parseUpdate(msg('/list@papertrade_alerts_bot'), 'Papertrade_Alerts_Bot')?.command).toBe('list');
    expect(parseUpdate(msg('/list@somebody_else_bot'), 'papertrade_alerts_bot')).toBeNull();
  });

  it('keeps unknown commands so the bot can answer with help', () => {
    expect(parseUpdate(msg('/frobnicate'))).toMatchObject({ command: 'unknown', raw: 'frobnicate' });
  });

  it('ignores chatter, bots, non-text updates and malformed chats', () => {
    expect(parseUpdate(msg('hello there'))).toBeNull();
    expect(parseUpdate(msg('/list', { from: { id: 1, is_bot: true } }))).toBeNull();
    expect(parseUpdate({ update_id: 2, edited_message: {} })).toBeNull();
    expect(parseUpdate({ update_id: 3, message: { text: '/list' } })).toBeNull();
    expect(parseUpdate(msg('/ list'))).toBeNull();
  });

  it('supports group chats with negative ids and caps the argument list', () => {
    const r = parseUpdate(msg('/watch ' + 'a '.repeat(40), { chat: { id: -100123, type: 'supergroup' } }));
    expect(r?.chatId).toBe('-100123');
    expect(r?.chatType).toBe('supergroup');
    expect(r?.args.length).toBe(12);
  });
});
