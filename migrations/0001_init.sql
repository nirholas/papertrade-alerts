-- papertrade-alerts schema. D1 (SQLite). All timestamps are unix milliseconds.

-- One account per management token. No emails, no wallets, no passwords: the token is the credential.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  creator_hash TEXT,
  last_seen_at INTEGER,
  protocol_rules TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_accounts_creator ON accounts (creator_hash, created_at);

-- Where alerts go. `target` is a Telegram chat id, a Discord webhook URL, or a webhook URL.
-- `secret` signs generic webhook bodies (HMAC-SHA256).
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'discord', 'webhook')),
  target TEXT NOT NULL,
  secret TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  UNIQUE (account_id, kind, target)
);
CREATE INDEX idx_channels_account ON channels (account_id);

-- Short-lived codes that link a Telegram chat to an account: `/start <code>`.
CREATE TABLE link_codes (
  code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- A watched wallet. role 'own' covers every alert type; 'follow' is a leaderboard wallet you only track trades of.
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'own' CHECK (role IN ('own', 'follow')),
  label TEXT,
  rules TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, address, role)
);
CREATE INDEX idx_watches_address ON watches (address);
CREATE INDEX idx_watches_account ON watches (account_id);

-- Latest compact snapshot per wallet, shared by every watch on that wallet so each wallet is polled once per tick.
CREATE TABLE wallet_state (
  address TEXT PRIMARY KEY,
  snapshot TEXT,
  polled_at INTEGER NOT NULL DEFAULT 0,
  ok_at INTEGER,
  error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_wallet_state_polled ON wallet_state (polled_at);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  watch_id TEXT REFERENCES watches (id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX idx_alerts_account_time ON alerts (account_id, created_at DESC);

-- One row per (alert, channel). pending rows with attempts > 0 are waiting for a retry; dead rows are the dead-letter queue.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  last_http_status INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_deliveries_due ON deliveries (status, next_attempt_at);
CREATE INDEX idx_deliveries_account ON deliveries (account_id, created_at DESC);
CREATE INDEX idx_deliveries_alert ON deliveries (alert_id);
CREATE INDEX idx_deliveries_channel_sent ON deliveries (channel_id, sent_at);

-- Small key/value store for engine bookkeeping: the cron lease and the last protocol snapshot.
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
