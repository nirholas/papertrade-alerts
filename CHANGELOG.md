# Changelog

## 0.1.0 - 2026-10-10

- Initial release: Cloudflare Worker with a per-minute Cron Trigger, D1 storage and a static management UI.
- Per-wallet alerts: liquidation distance, position opened, closed (net PnL and PAPER minted) and liquidated, balance change, session key expiry, pending staking rewards.
- Protocol alerts: PAPER mint-rate crossing, market paused or close-only, followed leaderboard wallet opening a position.
- Channels: Telegram bot (webhook with secret token, /start /watch /follow /unwatch /list /thresholds), Discord webhook, HMAC-SHA256 signed generic webhook.
- Engine: edge-triggered diffs with hysteresis, per-position dedupe keys, hourly alert cap, per-channel send cap, retries with exponential backoff, Retry-After handling, dead-letter view with retry.
