/** The subset of the Telegram Bot API `Update` object this bot reads. */
export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number; type?: string; title?: string; username?: string };
    from?: { id?: number; is_bot?: boolean; username?: string };
  };
  edited_message?: unknown;
}

export type CommandName = 'start' | 'watch' | 'unwatch' | 'list' | 'thresholds' | 'help' | 'follow' | 'unknown';

export interface ParsedCommand {
  chatId: string;
  chatType: string;
  command: CommandName;
  /** The command text as typed, lowercased, for the "unknown command" reply. */
  raw: string;
  args: string[];
}

const KNOWN = new Set<CommandName>(['start', 'watch', 'unwatch', 'list', 'thresholds', 'help', 'follow']);

/**
 * Turn a Telegram update into a command. Returns null for anything the bot should ignore: bot senders, non-text
 * messages, plain chatter without a leading slash, and commands addressed to a different bot (`/list@otherbot`).
 */
export function parseUpdate(update: TelegramUpdate, botUsername?: string): ParsedCommand | null {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string' || msg.from?.is_bot) return null;
  const chatId = msg.chat?.id;
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId)) return null;
  const text = msg.text.trim();
  if (!text.startsWith('/')) return null;
  const [head, ...rest] = text.split(/\s+/);
  const match = /^\/([A-Za-z_]+)(?:@([A-Za-z0-9_]+))?$/.exec(head);
  if (!match) return null;
  const [, name, target] = match;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  const lower = name.toLowerCase();
  return {
    chatId: String(chatId),
    chatType: msg.chat?.type ?? 'private',
    command: KNOWN.has(lower as CommandName) ? (lower as CommandName) : 'unknown',
    raw: lower,
    args: rest.slice(0, 12),
  };
}
