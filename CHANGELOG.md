# Changelog

## 0.2.0 - 2026-10-11

- MCP server at `/mcp` (Streamable HTTP, stateless) with ten tools: wallet alert preview, destination validation and test, subscription and alert rule management. Rate limited, SSRF-guarded, never moves funds.
- Agent discovery: MCP server card, A2A agent card, RFC 9727 API catalog, llms.txt and llms-full.txt, OpenAPI additions, robots.txt Content-Signal, `server.json` and `glama.json`.
- Documentation site at `/docs/` generated from `docs/*.md`, with search, `.md` twins and a Connect your AI page for every major client.
- Landing page rebuilt: live wallet preview, feature grid, connect strip, quickstart.
- Honest degradation: `503 service_initializing` with Retry-After and a quiet cron while the D1 schema is missing or the D1 daily limit is hit; `/api/status` reports `ready`.
- Stricter SSRF guard (CGNAT, benchmark, multicast, reserved ranges, internal suffixes).
- Embeddable in Papertrade OS: `?embed=1`, `frame-ancestors` for papertrade-os.pages.dev, "Open in Papertrade OS" link.

## 0.1.0 - 2026-10-10

- Initial release: Cloudflare Worker with a per-minute Cron Trigger, D1 storage and a static management UI.
- Per-wallet alerts: liquidation distance, position opened, closed (net PnL and PAPER minted) and liquidated, balance change, session key expiry, pending staking rewards.
- Protocol alerts: PAPER mint-rate crossing, market paused or close-only, followed leaderboard wallet opening a position.
- Channels: Telegram bot (webhook with secret token, /start /watch /follow /unwatch /list /thresholds), Discord webhook, HMAC-SHA256 signed generic webhook.
- Engine: edge-triggered diffs with hysteresis, per-position dedupe keys, hourly alert cap, per-channel send cap, retries with exponential backoff, Retry-After handling, dead-letter view with retry.
