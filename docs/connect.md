---
title: Connect your AI
description: Copy-paste setup for Claude, Codex, ChatGPT, Gemini, Cursor, VS Code, Windsurf, Zed, Cline, Goose, Continue and any OpenAI-compatible agent.
order: 6
---
# Connect your AI

Server URL: `https://papertrade-alerts.ninabrekkerese.workers.dev/mcp`. Streamable HTTP, no OAuth. Preview tools work with no credentials. For subscription tools, add the management token from `create_subscription` as an `Authorization: Bearer ptal_...` header where the client supports headers (examples below use `$ALERTS_TOKEN`), or just let the agent pass it as the `token` argument.

Client config formats change; each snippet follows the vendor documentation at the time of writing.

## Claude Code

```bash
claude mcp add --transport http papertrade-alerts https://papertrade-alerts.ninabrekkerese.workers.dev/mcp
# with a token
claude mcp add --transport http papertrade-alerts https://papertrade-alerts.ninabrekkerese.workers.dev/mcp --header "Authorization: Bearer $ALERTS_TOKEN"
```

## Claude Desktop and claude.ai

Settings, Connectors, **Add custom connector**, paste the server URL. For Claude Desktop you can also use the `mcp-remote` bridge in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "papertrade-alerts": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp"]
    }
  }
}
```

## Claude API (MCP connector)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Preview the alerts for 0x..."}],
    "mcp_servers": [{"type": "url", "url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp", "name": "papertrade-alerts"}],
    "tools": [{"type": "mcp_toolset", "mcp_server_name": "papertrade-alerts"}]
  }'
```

Set `authorization_token` on the server entry to send the management token. Use any current Claude model id.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.papertrade-alerts]
url = "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp"
# optional: name of an environment variable holding the management token
bearer_token_env_var = "ALERTS_TOKEN"
```

Or: `codex mcp add papertrade-alerts --url https://papertrade-alerts.ninabrekkerese.workers.dev/mcp`

## OpenAI Responses API

```json
{
  "model": "gpt-5",
  "input": "Preview the alerts for 0x...",
  "tools": [{
    "type": "mcp",
    "server_label": "papertrade_alerts",
    "server_description": "Wallet alerts for Papertrade. Read-only, never moves funds.",
    "server_url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp",
    "require_approval": "never"
  }]
}
```

Use `"require_approval": "always"` if you want to confirm each call; the write tools change your alert subscription.

## ChatGPT

Settings, Connectors, Advanced, enable **Developer mode**, then create a connector with the server URL and authentication set to none. Availability depends on your plan.

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "papertrade-alerts": {
      "httpUrl": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ptal_your_token" }
    }
  }
}
```

Or: `gemini mcp add --transport http papertrade-alerts https://papertrade-alerts.ninabrekkerese.workers.dev/mcp`

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "papertrade-alerts": { "url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp" }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "papertrade-alerts": { "type": "http", "url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp" }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "papertrade-alerts": { "serverUrl": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp" }
  }
}
```

## Zed

`settings.json`:

```json
{
  "context_servers": {
    "papertrade-alerts": { "url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp" }
  }
}
```

## Cline

`cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "papertrade-alerts": { "url": "https://papertrade-alerts.ninabrekkerese.workers.dev/mcp", "type": "streamableHttp" }
  }
}
```

## Goose

Run `goose configure`, choose **Add Extension**, then **Remote Extension (Streaming HTTP)**, and enter the server URL. Or in `~/.config/goose/config.yaml`:

```yaml
extensions:
  papertrade-alerts:
    type: streamable_http
    name: papertrade-alerts
    uri: https://papertrade-alerts.ninabrekkerese.workers.dev/mcp
    enabled: true
    timeout: 300
```

## Continue

`.continue/mcpServers/papertrade-alerts.yaml`:

```yaml
name: Papertrade Alerts
version: 0.0.1
schema: v1
mcpServers:
  - name: papertrade-alerts
    type: streamable-http
    url: https://papertrade-alerts.ninabrekkerese.workers.dev/mcp
```

## Any other agent framework

Frameworks without MCP support can use the HTTP API through the OpenAPI document at [/openapi.json](/openapi.json), which describes every endpoint, or fetch [/llms-full.txt](/llms-full.txt) for the full documentation in one file.

## Verify

```bash
npx @modelcontextprotocol/inspector --cli https://papertrade-alerts.ninabrekkerese.workers.dev/mcp --transport http --method tools/list
```
