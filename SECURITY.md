# Security

Report vulnerabilities privately through GitHub: https://github.com/nirholas/papertrade-alerts/security/advisories/new

## Model

- No wallet connections, no keys, no signing. The service only reads public Papertrade data.
- Ownership is a one-time management token (`ptal_...`). Only its SHA-256 is stored. Lose it and nobody can recover the account.
- Webhook secrets (`whsec_...`) are shown once and used to sign `t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`. Reject requests older than 5 minutes.
- Webhook targets must be public https URLs unless `ALLOW_INSECURE_WEBHOOKS=true` (development only). Discord URLs must be on discord.com.
- The Telegram webhook requires the `X-Telegram-Bot-Api-Secret-Token` header (compared in constant time).
- All API strings are rendered with text nodes only, and the CSP forbids inline script and style.
- Alerts are best effort. Never rely on them to protect funds.
