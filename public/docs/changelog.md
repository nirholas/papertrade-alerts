# Changelog

## 0.2.0

- MCP server at `/mcp` with ten tools (preview, subscription, destinations, rules).
- Agent discovery: MCP server card, A2A agent card, RFC 9727 API catalog, llms-full.txt.
- Documentation site at `/docs/` with search and markdown twins.
- Honest degradation: `503 service_initializing` and a quiet cron while D1 is not ready.
- Stricter SSRF guard (CGNAT, benchmark, multicast, reserved ranges, internal suffixes).
- Embeddable in Papertrade OS via `?embed=1`.

## 0.1.0

- Initial release: wallet and protocol alerts to Telegram, Discord and signed webhooks, web app, HTTP API.
