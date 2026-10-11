---
title: Self-hosting
description: Deploy your own Papertrade Alerts to Cloudflare Workers with D1.
order: 8
---
# Self-hosting on Cloudflare

You need a Cloudflare account and Node 20 or newer. The free plan works for a handful of wallets.

```bash
git clone https://github.com/nirholas/papertrade-alerts && cd papertrade-alerts
npm install
npx wrangler d1 create papertrade-alerts      # copy the printed database_id into wrangler.toml
npm run deploy:site                           # builds the UI and docs, migrates D1, deploys the Worker
```

`deploy:site` applies the migrations before it deploys. If you deploy by hand, run `npm run db:migrate:remote` first.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PAPERTRADE_API_URL` | Papertrade API base. Default `https://exchange.papertrade.xyz` |
| `EXPLORER_URL` | Link target in alerts |
| `MAX_WALLETS_PER_TICK` | Wallets polled per minute. The free plan allows 50 subrequests per invocation, so keep it near 40 |
| `PUBLIC_ORIGIN` | Canonical origin when you use a custom domain |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | Secrets that enable the Telegram channel (`wrangler secret put`) |

Then `TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:webhook -- https://<your-worker>`.

## D1 free tier

D1's free plan limits daily row writes. The cron writes a few rows per minute even when idle, plus alert and delivery rows. If the account hits the daily cap, the Worker answers `503` with an explanation and the cron pauses quietly until midnight UTC. For anything beyond a personal deployment, use the Workers Paid plan.

## Local development

```bash
npm run dev:site      # applies migrations locally and serves on :8796 with scheduled testing on
```

## Quality gates

`npm run typecheck`, `npm test`, `npm run build:site`.
