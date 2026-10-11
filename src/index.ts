import { app } from './api.js';
import { isStorageUnavailable, storageReady, warnStorageDown } from './degrade.js';
import { runTick } from './engine/tick.js';
import type { Env } from './types.js';

async function tickAndRecord(env: Env, scheduledTime: number): Promise<void> {
  try {
    if (!(await storageReady(env))) return warnStorageDown();
    await tickBody(env, scheduledTime);
  } catch (err) {
    if (isStorageUnavailable(err)) return warnStorageDown();
    throw err;
  }
}

async function tickBody(env: Env, scheduledTime: number): Promise<void> {
  const report = await runTick(env, { now: scheduledTime });
  console.log('tick', JSON.stringify(report));
  if (report.skipped) return;
  const summary = {
    ok: report.ok,
    durationMs: report.durationMs,
    wallets: report.wallets,
    alerts: report.alerts + report.protocolAlerts,
    errors: report.errors.slice(0, 3),
  };
  await env.DB.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('lasttick', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(summary), Date.now())
    .run();
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(tickAndRecord(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
