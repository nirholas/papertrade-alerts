import type { JsonSchema, McpServer, ToolDef } from './mcp.js';

/** Machine-readable discovery documents, generated from the live tool registry so they can never drift from /mcp. */

const DESCRIPTION = 'Unofficial, self-hostable alerts for Papertrade wallets: liquidation distance, positions opened, closed or liquidated, session key expiry and staking rewards, delivered to Telegram, Discord or a signed webhook. Not affiliated with Papertrade.';

interface Described {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolDef<unknown>['annotations'];
}

const describe = (t: Described) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

export function serverCard<Ctx>(server: McpServer<Ctx>, origin: string) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    serverInfo: { name: server.info.name, title: server.info.title, version: server.info.version },
    description: DESCRIPTION,
    protocolVersion: '2025-06-18',
    transport: { type: 'streamable-http', endpoint: `${origin}/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false, note: 'Preview and discovery tools are open. Subscription tools use the one-time management token from create_subscription as "Authorization: Bearer ptal_...".' },
    instructions: server.info.instructions,
    documentationUrl: `${origin}/docs/mcp`,
    repository: { url: 'https://github.com/nirholas/papertrade-alerts', source: 'github' },
    license: 'Apache-2.0',
    tools: server.tools.map(describe),
  };
}

export function agentCard<Ctx>(server: McpServer<Ctx>, origin: string) {
  return {
    name: server.info.title,
    description: DESCRIPTION,
    url: `${origin}/mcp`,
    version: server.info.version,
    protocolVersion: '0.3.0',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'nirholas (community, unofficial)', url: 'https://github.com/nirholas/papertrade-alerts' },
    documentationUrl: `${origin}/docs/`,
    iconUrl: `${origin}/icon.svg`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    securitySchemes: { managementToken: { type: 'http', scheme: 'bearer', description: 'One-time ptal_ token from create_subscription. Only the subscription tools need it.' } },
    skills: server.tools.map((t) => ({
      id: t.name,
      name: t.title,
      description: t.description,
      tags: ['papertrade', 'alerts', t.annotations.readOnlyHint ? 'read-only' : 'subscription'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
      examples: [],
    })),
    additionalInterfaces: [{ url: `${origin}/mcp`, transport: 'MCP-STREAMABLE-HTTP' }],
  };
}

/** RFC 9727 API catalog as an RFC 9264 linkset. */
export function apiCatalog(origin: string) {
  return {
    linkset: [
      {
        anchor: `${origin}/mcp`,
        'service-desc': [{ href: `${origin}/.well-known/mcp/server-card.json`, type: 'application/json' }],
        'service-doc': [{ href: `${origin}/docs/mcp`, type: 'text/html' }],
      },
      {
        anchor: `${origin}/api`,
        'service-desc': [{ href: `${origin}/openapi.json`, type: 'application/vnd.oai.openapi+json' }],
        'service-doc': [{ href: `${origin}/docs/api`, type: 'text/html' }],
        status: [{ href: `${origin}/api/status`, type: 'application/json' }],
      },
      {
        anchor: `${origin}/`,
        describedby: [
          { href: `${origin}/llms.txt`, type: 'text/plain' },
          { href: `${origin}/llms-full.txt`, type: 'text/plain' },
          { href: `${origin}/.well-known/agent-card.json`, type: 'application/json' },
        ],
        'service-doc': [{ href: `${origin}/docs/`, type: 'text/html' }],
      },
    ],
  };
}
