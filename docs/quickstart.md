---
title: Quickstart
description: Create a subscription, connect a destination and watch a wallet in five minutes.
order: 2
---
# Quickstart

You need a wallet address to watch and somewhere to receive messages (a Discord webhook URL or an https endpoint you control).

## With the web app

1. Open the app, press **Create my subscription** and copy the management token. It is shown once.
2. Under **Channels**, paste a Discord webhook URL or webhook endpoint and press **Send test**.
3. Under **Wallets**, add the address and adjust thresholds.

## With curl

```bash
BASE=https://papertrade-alerts.ninabrekkerese.workers.dev

# 1. Create a subscription. The token is returned once.
TOKEN=$(curl -s -X POST $BASE/api/accounts | jq -r .token)

# 2. Add a destination you own.
curl -s -X POST $BASE/api/channels \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"discord","target":"https://discord.com/api/webhooks/<id>/<token>"}'

# 3. Watch a wallet. Liquidation distance below 3 percent, plus opens and closes.
curl -s -X POST $BASE/api/watches \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"address":"0x0000000000000000000000000000000000000000","rules":{"liquidation":{"enabled":true,"belowPct":3}}}'
```

Replace the zero address with the wallet you want to watch.

## With an AI agent

Add the MCP server (see [Connect your AI](connect)) and ask: "Preview what alerts 0x... would trigger, then set up a Discord alert for it." The agent calls `preview_wallet_alerts`, `create_subscription`, `add_destination`, `test_destination` and `create_alert_rule`.

## What happens next

The first poll of a new watch is seeded silently, so existing positions are not announced. From the second poll on, changes become alerts. See [Concepts](concepts).
