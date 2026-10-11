/**
 * Minimal, stateless MCP server over Streamable HTTP (JSON-RPC 2.0).
 *
 * Plumbing only: this file knows nothing about alerts. The tool registry lives in `mcp-tools.ts`.
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 16;

export type JsonObject = Record<string, unknown>;

type JsonType = 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';

export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  default?: unknown;
  format?: string;
  oneOf?: JsonSchema[];
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef<Ctx> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  handler(args: JsonObject, ctx: Ctx): Promise<JsonObject>;
}

/** Throw from a handler to return `isError: true` with a message the model can act on. */
export class ToolError extends Error {}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

export interface McpServer<Ctx> {
  info: ServerInfo;
  tools: ToolDef<Ctx>[];
  /** Human and agent readable pointers returned from a plain GET. */
  links: Record<string, string>;
}

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version, retry-after',
  'access-control-max-age': '86400',
};

const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function withCors(headers: Record<string, string> = {}): Headers {
  const h = new Headers({ ...CORS_HEADERS, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  return h;
}

/** Validate tool arguments against the (small) JSON Schema subset the tool definitions use. Returns problems, empty when valid. */
export function validateArgs(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const problems: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (value === null && types.includes('null')) return problems;
  if (value === null || value === undefined) return [`${path} is required`];
  const kind = types.find((t) => t !== 'null');
  switch (kind) {
    case 'object': {
      if (!isObj(value)) return [`${path} must be an object`];
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (value[key] === undefined) problems.push(`${path}.${key} is required`);
      for (const [key, v] of Object.entries(value)) {
        const sub = props[key];
        if (!sub) {
          if (schema.additionalProperties === false) problems.push(`${path}.${key} is not a known property`);
          continue;
        }
        if (v !== undefined) problems.push(...validateArgs(sub, v, `${path}.${key}`));
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} must be at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} must be at most ${schema.maxLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${path} has the wrong format`);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`];
      if (kind === 'integer' && !Number.isInteger(value)) problems.push(`${path} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} must be at most ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path} must be a boolean`];
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} must have at most ${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => problems.push(...validateArgs(schema.items as JsonSchema, v, `${path}[${i}]`)));
      break;
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  return problems;
}

export function toolDescriptor<Ctx>(tool: ToolDef<Ctx>) {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations };
}

async function dispatch<Ctx>(server: McpServer<Ctx>, ctx: Ctx, req: RpcRequest, negotiated: { version: string }): Promise<unknown> {
  const params = isObj(req.params) ? req.params : {};
  switch (req.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
      negotiated.version = version;
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.info.name, title: server.info.title, version: server.info.version },
        instructions: server.info.instructions,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: server.tools.map(toolDescriptor) };
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') throw new RpcError(RPC.invalidParams, 'tools/call needs a string "name".');
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) throw new RpcError(RPC.invalidParams, `Unknown tool "${name}". Call tools/list for the available tools.`);
      const args = params.arguments === undefined ? {} : params.arguments;
      const problems = validateArgs(tool.inputSchema, args);
      if (problems.length) throw new RpcError(RPC.invalidParams, `Invalid arguments for ${name}: ${problems.join('; ')}`);
      try {
        const out = await tool.handler(args as JsonObject, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      } catch (err) {
        if (err instanceof ToolError) return { isError: true, content: [{ type: 'text', text: err.message }] };
        throw err;
      }
    }
    default:
      throw new RpcError(RPC.methodNotFound, `Method not found: ${req.method}`);
  }
}

function isRequest(v: unknown): v is RpcRequest {
  return isObj(v) && v.jsonrpc === '2.0' && typeof v.method === 'string' && (v.id === undefined || v.id === null || typeof v.id === 'string' || typeof v.id === 'number');
}

async function handleOne<Ctx>(server: McpServer<Ctx>, ctx: Ctx, raw: unknown, negotiated: { version: string }): Promise<JsonObject | null> {
  if (!isRequest(raw)) {
    const id = isObj(raw) && (typeof raw.id === 'string' || typeof raw.id === 'number') ? raw.id : null;
    return { jsonrpc: '2.0', id, error: { code: RPC.invalidRequest, message: 'Invalid JSON-RPC 2.0 request.' } };
  }
  const isNotification = raw.id === undefined;
  try {
    if (raw.method.startsWith('notifications/')) return null;
    const result = await dispatch(server, ctx, raw, negotiated);
    return isNotification ? null : { jsonrpc: '2.0', id: raw.id, result };
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcError) return { jsonrpc: '2.0', id: raw.id, error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } };
    console.error('mcp internal error', err instanceof Error ? err.message : 'unknown');
    return { jsonrpc: '2.0', id: raw.id, error: { code: RPC.internal, message: 'Internal error. Try again shortly.' } };
  }
}

function wantsSseOnly(accept: string): boolean {
  const a = accept.toLowerCase();
  return a.includes('text/event-stream') && !a.includes('application/json') && !a.includes('*/*');
}

function payloadResponse(payload: unknown, accept: string, status = 200, extra: Record<string, string> = {}): Response {
  if (wantsSseOnly(accept)) {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status, headers: withCors({ 'content-type': 'text/event-stream; charset=utf-8', ...extra }) });
  }
  return new Response(JSON.stringify(payload), { status, headers: withCors({ 'content-type': 'application/json; charset=utf-8', ...extra }) });
}

/** Optional per-request gate, run before dispatch. Return a Response to short-circuit (for example a 429). */
export type Gate = (request: Request) => Promise<Response | null> | Response | null;

export async function handleMcpRequest<Ctx>(request: Request, server: McpServer<Ctx>, ctx: Ctx, gate?: Gate): Promise<Response> {
  const accept = request.headers.get('accept') ?? '';
  switch (request.method) {
    case 'OPTIONS':
      return new Response(null, { status: 204, headers: withCors() });
    case 'GET': {
      if (accept.toLowerCase().includes('text/event-stream')) {
        return new Response(JSON.stringify({ error: 'This server does not offer a server-initiated SSE stream. POST JSON-RPC messages to this URL.' }), {
          status: 405,
          headers: withCors({ allow: 'POST, OPTIONS', 'content-type': 'application/json; charset=utf-8' }),
        });
      }
      return new Response(
        JSON.stringify(
          {
            name: server.info.name,
            title: server.info.title,
            version: server.info.version,
            protocol: 'MCP Streamable HTTP (stateless). POST JSON-RPC 2.0 to this URL.',
            protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
            tools: server.tools.map((t) => ({ name: t.name, title: t.title, readOnly: t.annotations.readOnlyHint })),
            links: server.links,
          },
          null,
          2,
        ),
        { status: 200, headers: withCors({ 'content-type': 'application/json; charset=utf-8' }) },
      );
    }
    case 'POST':
      break;
    default:
      return new Response(JSON.stringify({ error: `${request.method} is not supported. POST JSON-RPC messages to this URL.` }), {
        status: 405,
        headers: withCors({ allow: 'GET, POST, OPTIONS', 'content-type': 'application/json; charset=utf-8' }),
      });
  }

  const versionHeader = request.headers.get('mcp-protocol-version');
  if (versionHeader && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(versionHeader)) {
    return payloadResponse({ jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: `Unsupported MCP-Protocol-Version "${versionHeader.slice(0, 40)}". Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.` } }, accept, 400);
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return payloadResponse({ jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: `Request body is larger than ${MAX_BODY_BYTES} bytes.` } }, accept, 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return payloadResponse({ jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: `Request body is larger than ${MAX_BODY_BYTES} bytes.` } }, accept, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return payloadResponse({ jsonrpc: '2.0', id: null, error: { code: RPC.parse, message: 'Parse error: body is not valid JSON.' } }, accept, 400);
  }

  const blocked = gate ? await gate(request) : null;
  if (blocked) return blocked;

  const negotiated = { version: versionHeader ?? DEFAULT_PROTOCOL_VERSION };
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) {
      return payloadResponse({ jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: `A batch must hold between 1 and ${MAX_BATCH} messages.` } }, accept, 400);
    }
    const out: JsonObject[] = [];
    for (const item of body) {
      const r = await handleOne(server, ctx, item, negotiated);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202, headers: withCors() });
    return payloadResponse(out, accept);
  }
  const result = await handleOne(server, ctx, body, negotiated);
  if (!result) return new Response(null, { status: 202, headers: withCors() });
  const isInit = isObj(body) && body.method === 'initialize' && 'result' in result;
  return payloadResponse(result, accept, 200, isInit ? { 'mcp-protocol-version': negotiated.version } : {});
}
