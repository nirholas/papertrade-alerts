---
title: API reference
description: Every HTTP endpoint, with authentication and examples. The machine-readable form is /openapi.json.
order: 4
---
# API reference

Base URL: `https://papertrade-alerts.ninabrekkerese.workers.dev`. The OpenAPI 3.1 document is at [/openapi.json](/openapi.json). Errors are JSON: `{ "code": "...", "message": "..." }`.

Authenticated endpoints need `Authorization: Bearer ptal_...`.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | no | `200` when D1 is ready, `503` with `database: not_ready` until the schema is applied |
| `GET /api/status` | no | `ready`, channel availability, limits, last cron poll |
| `POST /api/accounts` | no | Create a subscription. Returns the token once. `201` |
| `GET /api/me` | yes | Account, watches, channels, protocol rules |
| `DELETE /api/me` | yes | Delete everything under the account |
| `POST /api/watches` | yes | `{ address, role?, label?, rules? }`. Idempotent per address and role |
| `PATCH /api/watches/{id}` | yes | `{ rules?, label? }`. Rules may be partial |
| `DELETE /api/watches/{id}` | yes | Stop watching |
| `POST /api/channels` | yes | `{ kind: "discord" \| "webhook", target, label? }`. Webhook secret returned once |
| `PATCH /api/channels/{id}` | yes | `{ status: "active" \| "paused" }` |
| `DELETE /api/channels/{id}` | yes | Remove |
| `POST /api/channels/{id}/test` | yes | Send a real test message. 5 per minute |
| `POST /api/telegram/link` | yes | Mint a 15 minute code for `/start <code>` in the bot |
| `PUT /api/protocol-rules` | yes | Mint-rate threshold and market status alerts |
| `GET /api/alerts` | yes | Alert history with per-channel delivery status. `?limit=&before=` |
| `GET /api/deliveries/dead` | yes | Dead-letter deliveries |
| `POST /api/deliveries/{id}/retry` | yes | Re-queue one |
| `GET /api/papertrade/*` | no | Read-only same-origin proxy for the Papertrade API |
| `POST /mcp` | optional | [MCP server](mcp) |

## Wallet rules

```json
{
  "liquidation": { "enabled": true, "belowPct": 0.05 },
  "opened": true,
  "closed": true,
  "liquidated": true,
  "balance": { "enabled": false, "changeUsd": 100 },
  "sessionKey": { "enabled": true, "withinDays": 3 },
  "rewards": { "enabled": false, "aboveUsdc": 10 }
}
```

Unknown keys are rejected. Ranges: `belowPct` 0.001 to 50, `changeUsd` 1 to 1e9, `withinDays` 1 to 30, `aboveUsdc` 0.01 to 1e9.

## Webhook signature

Each webhook delivery carries `x-papertrade-alerts-signature: t=<unix>,v1=<hex>` where `v1` is the HMAC-SHA256 of `<t>.<raw body>` with your signing secret. Reject deliveries whose timestamp is older than a few minutes.

## Storage not ready

Until the D1 schema exists, every endpoint that needs it answers `503` with `code: service_initializing` and `Retry-After: 300`. `/api/status` still answers `200` with `ready: false` so clients can show an honest message.
