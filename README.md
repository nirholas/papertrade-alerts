# papertrade-alerts

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0a8f5b?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://github.com/nirholas/papertrade-alerts)
[![HyperEVM](https://img.shields.io/badge/HyperEVM-chain_999-0a8f5b?style=flat-square)](https://papertrade.xyz)
[![GitHub stars](https://img.shields.io/github/stars/nirholas/papertrade-alerts?style=flat-square&color=0a8f5b)](https://github.com/nirholas/papertrade-alerts/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/nirholas/papertrade-alerts?style=flat-square&color=0a8f5b)](https://github.com/nirholas/papertrade-alerts/commits/main)
[![Unofficial](https://img.shields.io/badge/community-unofficial-lightgrey?style=flat-square)](#the-papertrade-toolkit)

[Issues](https://github.com/nirholas/papertrade-alerts/issues) · [Discussions](https://github.com/nirholas/papertrade-alerts/discussions) · [Papertrade](https://papertrade.xyz) · [Toolkit](#the-papertrade-toolkit)

Unofficial, self-hostable alerts for [Papertrade](https://papertrade.xyz) wallets. Know before the liquidation: get a Telegram, Discord or signed-webhook message when a position nears its bust price, opens, closes, is liquidated, when a session key is about to expire, or when staking rewards pile up.

> Unofficial, not affiliated with Papertrade. High leverage can lose your whole margin. Alerts are best effort and can be late or missed.

Runs entirely on Cloudflare: one Worker (API + per-minute cron), D1 for state, and a static management UI served by the same Worker. Free-tier friendly for a handful of wallets (see Limits).

Screenshot: a dark dashboard with wallet cards (own and followed), channel cards with a "Send test" button and status chips, protocol alert switches, a recent-alerts feed with per-channel delivery badges, and a failed-deliveries view.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev:site          # builds the UI, applies local D1 migrations, serves on :8796
# trigger a poll by hand (the cron fires every minute on its own in production):
curl localhost:8796/cdn-cgi/handler/scheduled
```

Open http://localhost:8796, press "Create my subscription", save the token, add a wallet and a channel, then "Send test".

## Features

- Wallet alerts: liquidation distance below X% of the bust price, position opened, closed (net PnL and PAPER minted from the settlement row), liquidated, balance change of at least $X, session key expiring within N days, pending staking rewards above $X.
- Protocol alerts: PAPER mint rate crossing a threshold, a market paused or close-only, a followed leaderboard wallet opening a position.
- Channels: Telegram (bot commands /start /watch /follow /unwatch /list /thresholds), Discord webhook, generic webhook signed with HMAC-SHA256. A channel with a missing secret is disabled with a visible reason.
- Engine: batched polling with bounded concurrency, shared 429 `Retry-After` gate, diff against stored state, edge-triggered thresholds with hysteresis, per-position dedupe keys, 60 alerts/hour per account and 20 sends/minute per channel, up to 6 delivery attempts with exponential backoff (30s doubling to 30 min), dead-letter view with one-click retry.
- All protocol math (bust price, mint rate, pending rewards) comes from [papertrade-sdk](https://github.com/nirholas/papertrade-sdk).

## Ownership: management tokens

There are no passwords and no wallet connection. `POST /api/accounts` returns a one-time token `ptal_...`, sent as `Authorization: Bearer ptal_...`. Only its SHA-256 is stored, so it cannot be recovered: save it in a password manager. Anyone with the token can manage that subscription, nobody can see another account. Telegram: messaging `/start` to the bot creates a chat-owned account and replies with a token once; `/start <code>` links a chat to a web account using a 15 minute code from the UI.

## Why D1 and not KV

Alerts need uniqueness (dedupe keys), fan-out to several channels, ordered history for the UI and transactional state updates (alert + deliveries in one batch). KV is eventually consistent and has no queries or constraints. D1 gives all of that, and the working set is tiny.

## Architecture

```
cron (* * * * *) -> runTick
  lease (120s) -> deliver due retries -> read trading state + prices
  -> protocol diff -> poll due wallets (SSE snapshot, concurrency 3, 50s budget)
  -> diffWallet (pure) -> alerts + deliveries (one D1 batch) -> deliver
UI/API (Hono): accounts, watches, channels, alerts, dead letters, Telegram webhook, read-only Papertrade proxy
```

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | for Telegram | Bot token from @BotFather (`wrangler secret put`) |
| `TELEGRAM_WEBHOOK_SECRET` | for Telegram | Random string, verified on every webhook call |
| `TELEGRAM_BOT_USERNAME` | optional | Enables the t.me deep link |
| `ALLOW_INSECURE_WEBHOOKS` | dev only | Allows http/loopback webhook targets |
| `PAPERTRADE_API_URL`, `EXPLORER_URL`, `MAX_WALLETS_PER_TICK` | optional | In `wrangler.toml` `[vars]` |
| `PUBLIC_ORIGIN` | optional | Canonical origin (for example `https://alerts.example.com`) written into the canonical link, Open Graph, JSON-LD, `robots.txt`, `sitemap.xml`, `security.txt` and `/openapi.json`. Unset, the origin the request arrived on is used, so `workers.dev` and a custom domain both work with no config. |

## Deploy

```bash
npx wrangler d1 create papertrade-alerts      # paste the database_id into wrangler.toml
npx wrangler secret put TELEGRAM_BOT_TOKEN    # optional
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npm run deploy:site                           # builds UI, runs remote migrations, wrangler deploy
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:webhook -- https://<your-worker>.workers.dev
```

## Limits

- The Papertrade live endpoint is rate limited per IP. The engine honors `Retry-After`, never counts a 429 as the wallet's fault and retries on the next tick.
- Cloudflare Workers Free allows 50 subrequests per invocation, enough for roughly a dozen wallets per minute. Use Workers Paid (1000 subrequests) for more and raise `MAX_WALLETS_PER_TICK`.
- Per account: 25 wallets, 6 channels.

## Develop

`npm run typecheck`, `npm test` (diff engine runs on recorded real wallet snapshots in `test/fixtures`), `npm run build:site`.

## The Papertrade toolkit

Nine open-source building blocks for [Papertrade](https://papertrade.xyz), the fully on-chain 1000x perps exchange on Hyperliquid HyperEVM. Use them together or on their own.

| Project | What it does |
|---|---|
| [papertrade-ai](https://github.com/nirholas/papertrade-ai) | MCP server and CLI: trade Papertrade from Claude, ChatGPT, Cursor and any MCP client |
| [papertrade-sdk](https://github.com/nirholas/papertrade-sdk) | Typed API client, live account stream, EIP-712 signing and verified settlement math. |
| [papertrade-terminal](https://github.com/nirholas/papertrade-terminal) | Non-custodial web trading terminal with charts, order ticket, funding and swaps. |
| [papertrade-analytics](https://github.com/nirholas/papertrade-analytics) | DefiLlama-style dashboard and JSON API: TVL, volume, OI, PAPER economics. |
| [papertrade-explorer](https://github.com/nirholas/papertrade-explorer) | Linkable wallet pages, decoded transactions and a live leaderboard. |
| [papertrade-liquidations](https://github.com/nirholas/papertrade-liquidations) | Liquidation map and closest-to-bust feed, recomputed with the verified formula. |
| [papertrade-yield](https://github.com/nirholas/papertrade-yield) | PAPER staking dashboard with realized USDC yield and wallet-signed actions. |
| **papertrade-alerts** (this repo) | Know before the liquidation: Telegram, Discord and webhook alerts. |
| [papertrade-copytrade](https://github.com/nirholas/papertrade-copytrade) | Guard-railed copy-trading CLI. Dry run by default. |
| [papertrade-x402](https://github.com/nirholas/papertrade-x402) | Pay-per-call intelligence API for AI agents, paid in USDC on Solana or Base. |

## Contributing and support

- Found a bug or want a feature? [Open an issue](https://github.com/nirholas/papertrade-alerts/issues/new/choose).
- Questions and show-and-tell: [Discussions](https://github.com/nirholas/papertrade-alerts/discussions).
- Pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).
- If this saved you time, a star helps other Papertrade traders and builders find it.

Built by [three.ws](https://three.ws).

Apache-2.0 licensed. Unofficial, not affiliated with Papertrade. High leverage can lose your whole margin.
