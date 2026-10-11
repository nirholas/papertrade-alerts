import type { Env } from './types.js';

/**
 * Per-client request budget for the public MCP endpoint.
 *
 * Uses the Workers Rate Limiting binding when the deployment has one (accurate per location), and always
 * also enforces a sliding window in isolate memory so a deployment without the binding, local dev and tests
 * are still protected. Clients are keyed by the connecting IP; nothing about the client is stored.
 */
export type Bucket = 'read' | 'write' | 'preview';

export const BUDGETS: Record<Bucket, { limit: number; windowMs: number }> = {
  read: { limit: 120, windowMs: 60_000 },
  write: { limit: 12, windowMs: 60_000 },
  preview: { limit: 8, windowMs: 60_000 },
};

const windows = new Map<string, number[]>();
const MAX_KEYS = 5_000;

export function memoryAllow(key: string, bucket: Bucket, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const { limit, windowMs } = BUDGETS[bucket];
  const k = `${bucket}:${key}`;
  const hits = (windows.get(k) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    windows.set(k, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  windows.set(k, hits);
  if (windows.size > MAX_KEYS) {
    for (const [wk, ts] of windows) {
      if (!ts.some((t) => now - t < windowMs)) windows.delete(wk);
      if (windows.size <= MAX_KEYS / 2) break;
    }
  }
  return { ok: true, retryAfterSec: 0 };
}

export function resetRateLimits(): void {
  windows.clear();
}

export async function allow(env: Env, client: string, bucket: Bucket): Promise<{ ok: boolean; retryAfterSec: number }> {
  const local = memoryAllow(client, bucket);
  if (!local.ok) return local;
  const binding = bucket === 'read' ? env.MCP_RL_READ : env.MCP_RL_WRITE;
  if (!binding) return local;
  try {
    const { success } = await binding.limit({ key: `${bucket}:${client}` });
    return success ? local : { ok: false, retryAfterSec: 60 };
  } catch {
    return local;
  }
}
