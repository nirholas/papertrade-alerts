---
title: FAQ
description: Common questions about alerts, tokens, delivery and the MCP server.
order: 10
---
# FAQ

**Is this official?** No. It is an unofficial community tool, not affiliated with Papertrade.

**Can it trade for me or protect my position?** No. It only reads and notifies. Alerts are best effort and can be late or missed.

**I lost my token.** It cannot be recovered. Create a new subscription and re-add your wallets.

**Why did I not get an alert for a position that already existed?** A new watch is seeded silently. Only changes after the first poll alert.

**Why one alert and not one per minute?** Thresholds are edge-triggered with hysteresis. See [Concepts](concepts).

**How fast are alerts?** The cron polls every minute and each wallet is polled when due, so expect roughly a minute plus delivery time.

**The API says service_initializing or 503.** The deployment's D1 schema has not been applied or its daily D1 quota is used up. It recovers on its own after the fix or at midnight UTC.

**Can an agent read a wallet without an account?** Yes: `preview_wallet_alerts` needs no token.

**Can an agent send a message to an arbitrary URL?** Only to a destination the caller registered and that passes the SSRF guard, at most 5 test messages a minute.

**Which chains?** Papertrade runs on HyperEVM (chain 999). Addresses are standard 0x addresses.
