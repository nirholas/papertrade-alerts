import type { Env } from './types.js';

/**
 * The Worker must stay honest when D1 is not usable: schema not migrated yet, or the account's D1 quota is
 * exhausted. Both surface as a clear 503 for HTTP callers and a quiet skip for the cron, never a stack trace.
 */
const UNAVAILABLE = /no such table|no such column|D1_ERROR.*(?:no such|SQLITE_ERROR)|exceeded.{0,40}(?:free tier|row write|limit)|daily .{0,20}limit|code: 7500|D1 DB (?:is|storage)|Network connection lost|D1_RESET_DO/i;

export function isStorageUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}` : String(err);
  return UNAVAILABLE.test(message);
}

export const UNAVAILABLE_MESSAGE = 'Alert storage is not ready on this deployment yet (the D1 schema has not been applied, or the D1 daily limit is reached). Nothing is lost: retry in a few minutes. Operators: run `npm run db:migrate:remote`.';

let readyUntil = 0;
let notReadyUntil = 0;

/** True when the schema exists. Cached for a minute when ready and ten seconds when not, so recovery is quick. */
export async function storageReady(env: Env, now = Date.now()): Promise<boolean> {
  if (now < readyUntil) return true;
  if (now < notReadyUntil) return false;
  try {
    await env.DB.prepare(`SELECT 1 AS x FROM kv LIMIT 1`).first();
    readyUntil = now + 60_000;
    return true;
  } catch (err) {
    if (!isStorageUnavailable(err)) throw err;
    notReadyUntil = now + 10_000;
    return false;
  }
}

export function resetStorageCache(): void {
  readyUntil = 0;
  notReadyUntil = 0;
}

let lastWarn = 0;
/** One log line per half hour while storage is down, instead of one per cron tick. */
export function warnStorageDown(now = Date.now()): void {
  if (now - lastWarn < 30 * 60_000) return;
  lastWarn = now;
  console.warn('cron paused: D1 storage unavailable (schema not applied or daily limit reached). Further notices suppressed for 30 minutes.');
}
