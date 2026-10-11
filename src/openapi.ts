const bearer = [{ bearerAuth: [] }];
const ok = { '200': { description: 'OK' } };

export function openApiDocument(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Papertrade Alerts API',
      version: '0.1.0',
      description: 'Unofficial, not affiliated with Papertrade. Manage alert subscriptions with a one-time management token (Authorization: Bearer ptal_...).',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/healthz': { get: { summary: 'Liveness and D1 check', responses: ok } },
      '/api/status': { get: { summary: 'Channel availability, limits and last cron tick', responses: ok } },
      '/api/accounts': { post: { summary: 'Create an account. Returns the management token once.', responses: { '201': { description: 'Created' } } } },
      '/api/me': {
        get: { summary: 'Account, watches, channels, protocol rules', security: bearer, responses: ok },
        delete: { summary: 'Delete the account and everything under it', security: bearer, responses: ok },
      },
      '/api/watches': { post: { summary: 'Watch a wallet with per-type rules', security: bearer, responses: { '201': { description: 'Created' } } } },
      '/api/watches/{id}': {
        patch: { summary: 'Update rules (full object or shorthand like liq=3)', security: bearer, responses: ok },
        delete: { summary: 'Stop watching', security: bearer, responses: ok },
      },
      '/api/channels': { post: { summary: 'Add a discord or webhook channel. Webhook secret is returned once.', security: bearer, responses: { '201': { description: 'Created' } } } },
      '/api/channels/{id}': {
        patch: { summary: 'Pause or resume', security: bearer, responses: ok },
        delete: { summary: 'Remove channel', security: bearer, responses: ok },
      },
      '/api/channels/{id}/test': { post: { summary: 'Send a real test message and report the result', security: bearer, responses: ok } },
      '/api/telegram/link': { post: { summary: 'Mint a 15 minute code to link a Telegram chat via /start <code>', security: bearer, responses: ok } },
      '/api/telegram/webhook': { post: { summary: 'Telegram Bot API webhook (X-Telegram-Bot-Api-Secret-Token required)', responses: ok } },
      '/api/protocol-rules': { put: { summary: 'Set mint-rate, market status and followed-wallet alerts', security: bearer, responses: ok } },
      '/api/alerts': { get: { summary: 'Recent alerts with per-channel delivery status', security: bearer, responses: ok } },
      '/api/deliveries/dead': { get: { summary: 'Dead-letter deliveries', security: bearer, responses: ok } },
      '/api/deliveries/{id}/retry': { post: { summary: 'Re-queue a dead delivery', security: bearer, responses: ok } },
      '/api/papertrade/{path}': { get: { summary: 'Read-only same-origin proxy for the Papertrade API', responses: ok } },
    },
  };
}
