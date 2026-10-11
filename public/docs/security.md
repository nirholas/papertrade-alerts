# Security and limits

## What it never does

It does not sign, send funds, swap, bridge, mint or pay. It has no private keys and no wallet connection. The MCP tools cannot move money.

## Tokens and secrets

- The management token is a bearer secret. Only its SHA-256 hash is stored.
- Webhook signing secrets are shown once. Discord webhook URLs are masked in every API and tool response.
- Secrets are never logged. MCP errors log a class name only.
- Telegram, Discord and webhook text from third parties is untrusted data and is never interpreted as instructions.

## SSRF guard

Webhook destinations must be `https:`, carry no credentials, and resolve to a public host by name: loopback, private, link-local, CGNAT, benchmark, multicast and reserved IPv4, any IPv6 literal, single-label hosts and `.local`, `.localhost`, `.internal`, `.lan`, `.home`, `.corp`, `.intranet` are refused. Deliveries never follow redirects and time out. Use `validate_destination` to test a URL without a request.

## Limits

| Limit | Value |
| --- | --- |
| MCP requests per client IP | 120 per minute |
| MCP write tools per client IP | 12 per minute |
| Wallet previews per client IP | 8 per minute |
| MCP body, batch | 64 KB, 16 messages |
| New subscriptions per network | 10 per hour |
| Wallets, channels per subscription | 25, 6 |
| Alerts per subscription | 60 per hour |
| Test messages | 5 per minute |

## CORS and origins

`/mcp` and the discovery files send `Access-Control-Allow-Origin: *`. This is safe because nothing authenticates by cookie or by origin: the only credential is the bearer token you send explicitly.

## Reporting a vulnerability

See `SECURITY.md` in the repository.
