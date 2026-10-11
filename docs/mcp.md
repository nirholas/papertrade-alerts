---
title: MCP server
description: The /mcp endpoint, its ten tools with schemas, authentication, limits and examples.
order: 5
---
# MCP server

Endpoint: `https://papertrade-alerts.ninabrekkerese.workers.dev/mcp`

Transport: MCP Streamable HTTP, stateless. `POST` JSON-RPC 2.0 (single message or batch). Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted. The reply is `application/json`, or one SSE `message` event when a client accepts only `text/event-stream`. `GET` with `Accept: text/event-stream` and `DELETE` answer `405`. There are no sessions, cookies or OAuth: `Origin` is never used for authorization.

> No tool signs, sends funds or places orders. Tools that touch the account only manage alert rules and notification destinations, and only for the caller's own subscription.

## Authentication

Discovery and preview tools need nothing. Subscription tools need the management token from `create_subscription`, either as the `Authorization: Bearer ptal_...` header (preferred, configure it once in your client) or as the `token` argument.

## Tools

| Tool | Reads or writes | What it does |
| --- | --- | --- |
| `get_service_status` | read | Storage state, configured channels, limits, last cron poll |
| `list_alert_types` | read | Every alert, its rule field, defaults and ranges |
| `preview_wallet_alerts` | read (live API) | Which alerts a wallet would trigger right now: distance to liquidation per position, session key expiry, pending rewards |
| `validate_destination` | read | SSRF-guard check of a Discord or webhook URL. No network request |
| `create_subscription` | write | New subscription, token returned once |
| `add_destination` | write | Connect a Discord webhook or https webhook you own. Signing secret returned once |
| `test_destination` | write | Deliver one real test message. 5 per minute |
| `create_alert_rule` | write | Watch a wallet with rules. Idempotent |
| `list_alert_rules` | read | Rules and destinations with health |
| `delete_alert_rule` | write, destructive | Stop watching one wallet |

Every tool declares `inputSchema`, `outputSchema` and `annotations`. Results carry a text block and `structuredContent`. Tool failures use `isError: true` with a message that says how to recover; malformed calls use JSON-RPC errors (`-32700`, `-32600`, `-32601`, `-32602`).

### preview_wallet_alerts

```json
{ "address": "0x...", "rules": { "liquidation": { "belowPct": 5 } } }
```

Returns `positions[]` (market, side, leverage, marginUsd, entryPrice, markPrice, bustPrice, `distanceToLiquidationPct`, `wouldAlert`), `sessionKeys[]`, `pendingRewardsUsdc`, `equityUsd` and the rules applied. Nothing is stored.

### add_destination

```json
{ "kind": "webhook", "url": "https://example.com/hooks/papertrade", "label": "ops" }
```

Refused: `http:`, URLs with credentials, `localhost`, private, loopback, link-local, CGNAT and reserved addresses, and internal-only names.

## Raw examples

```bash
URL=https://papertrade-alerts.ninabrekkerese.workers.dev/mcp
H='content-type: application/json'

curl -s $URL -H "$H" -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -s $URL -H "$H" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s $URL -H "$H" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_service_status","arguments":{}}}'
```

## Limits

Per client IP: 120 requests per minute overall, 12 writes per minute, 8 wallet previews per minute. Request bodies are capped at 64 KB and batches at 16 messages. Over the limit you get `429` with `Retry-After`. Account limits apply on top: 25 wallets, 6 channels, 60 alerts per hour. While storage is not ready, account tools return a clear error and discovery tools keep working. See [Security and limits](security).
