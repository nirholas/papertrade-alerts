# AGENTS.md

## Commands
- `npm run typecheck`, `npm test`, `npm run build:site`
- `npm run dev:site` (port 8796), poll by hand: `curl localhost:8796/cdn-cgi/handler/scheduled`
- `npm run db:migrate:local`

## Correctness rules
- Protocol math comes from `papertrade-sdk`. Do not reimplement it.
- `diffWallet` and `diffProtocol` are pure. Keep I/O in `engine/tick.ts`.
- Thresholds are edge-triggered with hysteresis. Trade events use per-position dedupe keys. Never key on time buckets.
- A new watch is seeded silently (`state.seeded`). Closed positions wait for their `/trades` settlement row (10 minute grace).
- A 429 from Papertrade is never a wallet error.
- Tests use recorded real snapshots (`test/fixtures`). No invented data.

## Safety rules
- Never sign or send transactions, never handle private keys. This service is read-only.
- Never commit secrets. Bot token and webhook secret live in env vars only.
- Webhook targets must pass `validateTarget` (SSRF guard). Render API strings with text nodes only.
- Do not add em or en dashes.

## Layout
| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: fetch + scheduled |
| `src/api.ts`, `src/accounts.ts` | HTTP API, accounts, watches, channels |
| `src/engine/` | rules, snapshot, diff, protocol, alerts, delivery, tick |
| `src/channels/` | Discord, webhook, Telegram senders, target validation |
| `src/telegram/` | update parsing and bot commands |
| `migrations/` | D1 schema |
| `ui/app.ts`, `public/` | management UI (bundled to `public/app.js`) |
| `test/` | vitest, fixtures in `test/fixtures` |
