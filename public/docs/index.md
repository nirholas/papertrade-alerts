# Papertrade Alerts

Papertrade Alerts watches [Papertrade](https://papertrade.xyz) wallets and the protocol, and tells you when something needs attention: a position nearing its bust price, a position opening, closing or being liquidated, a session key about to lapse, staking rewards piling up, a market pausing. Messages go to Telegram, Discord or your own HMAC-signed webhook.

> Unofficial, not affiliated with Papertrade. High leverage can lose your whole margin. Alerts are best effort and can be late or missed: never rely on them to protect funds.

## What runs where

One Cloudflare Worker does everything:

| Piece | What it does |
| --- | --- |
| Cron Trigger (every minute) | Polls due wallets from the public Papertrade API, diffs each against its last snapshot, records alerts, flushes the delivery queue. |
| D1 database | Accounts, watches, channels, alert history, delivery queue and per-wallet state. |
| HTTP API (`/api/*`) | Create a subscription, manage wallets and channels, read alert history. See the [API reference](__ORIGIN__/docs/api.md). |
| Management UI (`/`) | The same API as a web app. The token lives in your browser only. |
| MCP server (`/mcp`) | The same capabilities for AI agents, plus a read-only wallet preview. See [MCP](__ORIGIN__/docs/mcp.md). |

## Read-only by design

The service reads public Papertrade state. It never holds a private key, never signs, never sends funds and never places orders. Its tools cannot move money.

## Where to go next

- [Quickstart](__ORIGIN__/docs/quickstart.md): a working alert in five minutes.
- [Connect your AI](__ORIGIN__/docs/connect.md): add the MCP server to Claude, Codex, ChatGPT, Gemini, Cursor and more.
- [Concepts](__ORIGIN__/docs/concepts.md): how thresholds, seeding and delivery behave.
