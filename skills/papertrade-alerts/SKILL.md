---
name: papertrade-alerts
description: Preview liquidation risk for any Papertrade wallet on HyperEVM and set up Discord or signed-webhook alert rules through the papertrade-alerts MCP server. Use when the user wants to watch a Papertrade wallet or be told before a position is liquidated.
---

# Papertrade alerts over MCP

papertrade-alerts is an unofficial, self-hostable Cloudflare Worker that polls Papertrade wallets and sends alerts. It hosts a stateless MCP server (Streamable HTTP) at `https://papertrade-alerts.ninabrekkerese.workers.dev/mcp`, which this plugin's `.mcp.json` registers. No tool signs, sends funds or places orders. Alerts are best effort and can be late or missed. High leverage can lose a whole margin: say so when a user relies on them.

To run your own instance instead, clone the repo, `npm install`, `cp .dev.vars.example .dev.vars`, `npm run dev:site` (serves on :8796), and point the MCP URL at `<origin>/mcp`. Deployment steps are in `docs/self-hosting.md`.

## Tools

| Tool | Arguments | Notes |
|---|---|---|
| `get_service_status` | none | Health of the service. |
| `list_alert_types` | none | What can be alerted on. |
| `preview_wallet_alerts` | `address`, optional `rules` | Live read of any wallet, no account needed. Start here. |
| `validate_destination` | `kind` (`discord` or `webhook`), `url` | Checks a destination (https only, public hosts only). |
| `create_subscription` | none | Returns a one-time management token `ptal_...`. It cannot be recovered, so show it once and tell the user to store it. |
| `add_destination` | `kind`, `url`, optional `label`, `token` | Add a Discord webhook or a webhook signed with HMAC-SHA256. |
| `test_destination` | `destinationId`, optional `token` | Send a test message. |
| `create_alert_rule` | `address`, optional `role` (`own` or `follow`), `label`, `rules`, `token` | Watch a wallet. |
| `list_alert_rules` | optional `token` | Rules and destinations with their ids. |
| `delete_alert_rule` | `ruleId`, optional `token` | Remove a rule. |

`rules` is a partial object merged over defaults, and unknown keys are rejected: `liquidation: {enabled, belowPct}`, `opened`, `closed`, `liquidated` (booleans), `balance: {enabled, changeUsd}`, `sessionKey: {enabled, withinDays}` `rewards: {enabled, aboveUsdc}`. Call `list_alert_types` for the exact keys and limits before building one.

The management token goes in the `token` argument or an `Authorization: Bearer ptal_...` header. Anyone with the token manages that subscription. Never paste it into logs or commits. Destination URLs must be ones the user controls.

## Worked example

1. `preview_wallet_alerts` with `{"address": "0x...", "rules": {"liquidation": {"enabled": true, "belowPct": 10}}}` to see current risk.
2. `create_subscription`, then keep the token.
3. `add_destination` with `{"kind": "discord", "url": "<their webhook>", "label": "trading", "token": "ptal_..."}`, then `test_destination`.
4. `create_alert_rule` with `{"address": "0x...", "role": "own", "token": "ptal_..."}`.
