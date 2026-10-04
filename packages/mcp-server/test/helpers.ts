/**
 * Wire helpers for the SDK-layer tests: drive the bridge through its public face (`fetch` /
 * `serveStdio`) with raw JSON-RPC requests — no MCP client package, no network, no external
 * service. The modern-era headers and per-request `_meta` envelope mirror what an MCP
 * 2026-07-28 client sends (protocol revision is mandatory in both the header and the envelope).
 */
import type { AuthInfo, JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import type { McpServer } from '@oribos/mcp-server';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: JsonRpcError;
}

export interface WireResponse {
  readonly status: number;
  readonly message: JsonRpcMessage;
}

export interface WireTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

const ACCEPT = 'application/json, text/event-stream';
const CONTENT_TYPE = 'application/json';

/** A 2025-era (legacy) request needs only JSON-RPC over an accepting POST. */
export function legacyHeaders(): Record<string, string> {
  return { 'content-type': CONTENT_TYPE, accept: ACCEPT };
}

/** A 2026-07-28 (modern) request names its protocol version and method in headers. */
export function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    'content-type': CONTENT_TYPE,
    accept: ACCEPT,
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(name === undefined ? {} : { 'mcp-name': name }),
  };
}

/** The per-request `_meta` envelope every modern request carries. */
export function withEnvelope(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'oribos-test', version: '0.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

export function rpc(method: string, params?: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/** Sends a raw request over a transport — the stdio tests' in-process seam. */
export function sendWire(transport: Transport, request: JsonRpcRequest): Promise<void> {
  return transport.send(request as unknown as JSONRPCMessage);
}

export function initializeRequest(id = 1): JsonRpcRequest {
  return rpc(
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oribos-test', version: '0.0.0' } },
    id,
  );
}

export async function post(
  server: McpServer,
  request: JsonRpcRequest,
  headers: Record<string, string>,
): Promise<WireResponse> {
  const response = await server.fetch(
    new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(request) }),
  );
  return { status: response.status, message: await readMessage(response) };
}

/** POSTs with a pre-parsed body — the `parsedBody` opt a body-parsing framework passes through. */
export async function postParsedBody(
  server: McpServer,
  request: JsonRpcRequest,
  headers: Record<string, string>,
): Promise<WireResponse> {
  const response = await server.fetch(new Request('http://localhost/mcp', { method: 'POST', headers }), {
    parsedBody: request,
  });
  return { status: response.status, message: await readMessage(response) };
}

/** POSTs with an `authInfo` — the pass-through opt an authenticating middleware supplies. */
export async function postAuthInfo(
  server: McpServer,
  request: JsonRpcRequest,
  headers: Record<string, string>,
  authInfo: AuthInfo,
): Promise<WireResponse> {
  const response = await server.fetch(
    new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(request) }),
    { authInfo },
  );
  return { status: response.status, message: await readMessage(response) };
}

/** Reads one JSON-RPC message off a response — SSE-framed (`data:` line) or a bare JSON body. */
export async function readMessage(response: Response): Promise<JsonRpcMessage> {
  const text = await response.text();
  const dataLine = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .at(-1);
  return JSON.parse(dataLine === undefined ? text : dataLine.slice(6)) as JsonRpcMessage;
}

export function toolsOf(response: WireResponse): WireTool[] {
  const tools = response.message.result?.tools;
  if (!Array.isArray(tools)) throw new Error(`expected a tools/list result, got ${JSON.stringify(response.message)}`);
  return tools as WireTool[];
}

export function contentOf(response: WireResponse): Array<{ type: string; text?: string }> {
  const content = response.message.result?.content;
  if (!Array.isArray(content)) throw new Error(`expected a tool result, got ${JSON.stringify(response.message)}`);
  return content as Array<{ type: string; text?: string }>;
}

/**
 * Compile-time assertion: `expectAssignable<To>(value)` requires `value`'s type to be assignable
 * to `To`, failing tsc outright when it is not. Not vitest's `expectTypeOf().toExtend()` — under
 * `exactOptionalPropertyTypes` that matcher gives false negatives on objects with unions and
 * optional properties (a plain assignment passes). The function body is empty at runtime.
 */
export function expectAssignable<To>(_value: To): void {}
