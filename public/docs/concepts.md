# Concepts

## Subscription and token

A subscription is an account with no email or password. Creating one returns a management token that starts with `ptal_`. Only its SHA-256 hash is stored, so a lost token cannot be recovered. Send it as `Authorization: Bearer ptal_...`.

## Watches and roles

A watch is one wallet address plus rules. The role decides what it reports:

- `own`: your wallet. Account-level alerts (liquidation distance, balance change, session keys, rewards) plus trade events.
- `follow`: someone else's wallet, for example from the leaderboard. Trade events only.

## Alert types

| Type | Fires when | Default |
| --- | --- | --- |
| `liquidation_distance` | Mark price is closer than `belowPct` percent to a position's bust price | on, 0.05% |
| `position_opened` / `follow_opened` | A new position appears | on |
| `position_closed` | A position closes, with net PnL and PAPER minted | on |
| `position_liquidated` | A position is liquidated | on |
| `balance_change` | Equity moved by more than `changeUsd` | off |
| `session_key_expiring` | A session key expires within `withinDays` | on, 3 days |
| `staking_rewards` | Pending staking rewards reach `aboveUsdc` | off |
| `mint_rate`, `market_status` | Protocol level: PAPER mint rate threshold, market paused or close-only | market status on |

## Edge-triggered, not level-triggered

A threshold alert fires when a value crosses its threshold and re-arms only after it recovers (liquidation distance re-arms at 1.5 times the threshold). A wallet that sits below a threshold for an hour produces one alert, not sixty. Trade events carry a per-position dedupe key, so a retried poll can never send twice.

## Silent seeding

A new watch records its first snapshot without alerting. Positions that already exist are not announced.

## Closed or liquidated?

A vanished position waits for its settlement row from the Papertrade indexer to learn whether it closed or was liquidated, and to include PnL. After 10 minutes without a row it is reported as closed without PnL.

## Delivery

Each alert is queued per active channel and retried with backoff. A delivery that exhausts its attempts lands in the dead-letter list (`GET /api/deliveries/dead`) and can be re-queued after you fix the channel. An account is capped at 60 alerts per hour; extra alerts are stored as suppressed and never sent.

## Papertrade API etiquette

A `429` from Papertrade pauses polling for the advertised time and is never counted as a wallet error. At most `MAX_WALLETS_PER_TICK` wallets are polled per minute.
