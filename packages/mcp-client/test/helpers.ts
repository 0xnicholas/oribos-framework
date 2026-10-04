/**
 * Wire helpers for the client-package tests: the seam under test is the package's own public
 * face (`createMcpClient` → `{ tools, refresh, close }`), driven against two in-process
 * counterparts — a real SDK server (`createMcpHandler` served over `node:http` on an ephemeral
 * loopback port) for full-stack behavior, and a raw JSON-RPC mock with canned bodies for
 * wire-level edge control (result projections, era postures, session teardown). No external
 * network, no external service.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createMcpHandler, McpServer, type ServerContext } from '@modelcontextprotocol/server';

/** A serving counterpart bound to an ephemeral loopback port. */
export interface Served {
  /** The endpoint URL (host overridden to `localhost` so the SDK's Host validation passes). */
  readonly url: URL;
  close(): Promise<void>;
}

/** The `{ fetch }` shape both the SDK handler and any web-standard handler speak. */
interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

/**
 * Serves a real SDK server built by `createMcpHandler`: every request gets a fresh `McpServer`
 * from the factory, with `register` filling its tools. Both protocol eras are served (the SDK
 * default), so a default `'auto'` client negotiates the modern era against it.
 */
export async function serveSdkServer(register: (server: McpServer) => void): Promise<Served> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });
    register(server);
    return server;
  });
  return serveHandler(handler);
}

/** Bridges a web-standard handler onto a `node:http` server on `127.0.0.1:<ephemeral>`. */
async function serveHandler(handler: FetchHandler): Promise<Served> {
  const server = createServer();
  server.on('request', (req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === 'host' || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const response = await handler.fetch(
        new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }),
      );
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'content-encoding' && name !== 'transfer-encoding') outHeaders[name] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (response.body === null) {
        res.end();
        return;
      }
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  return listen(server);
}

/** Reads a request body into an ArrayBuffer for the web-standard `Request`. */
function readBody(req: import('node:http').IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
  return new Promise((resolve, reject) => {
    req.on('end', () => resolve(concat(chunks)));
    req.on('error', reject);
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** One recorded exchange of the raw mock. */
export interface RawCall {
  /** The HTTP method (`POST` requests, `DELETE` session teardown, `GET` standby stream probes). */
  readonly method: string;
  /** The parsed JSON-RPC message body, when the request carried one. */
  readonly jsonRpc: JsonRpcBody | undefined;
  /** The request headers, lower-cased. */
  readonly headers: Record<string, string>;
}

export interface JsonRpcBody {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** What a raw-mock handler answers with. */
export interface RawReply {
  readonly status?: number;
  /** A JSON-serializable body (a full JSON-RPC message object, or anything else). */
  readonly body?: unknown;
  /** Extra response headers (e.g. `mcp-session-id` to pin the legacy session path). */
  readonly headers?: Record<string, string>;
  /** Delay the response by this many milliseconds (timeout-path tests). */
  readonly delayMs?: number;
}

export interface RawServed extends Served {
  /** Every request the mock saw, in arrival order. */
  readonly calls: RawCall[];
}

/**
 * A raw JSON-RPC mock: records every request and answers from `respond` — full control over
 * bodies, headers, status codes, and timing, without any MCP server implementation in between.
 */
export async function serveRaw(respond: (call: RawCall) => Promise<RawReply> | RawReply): Promise<RawServed> {
  const calls: RawCall[] = [];
  const server = createServer();
  server.on('request', (req, res) => {
    void (async () => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : (value ?? '')]),
      );
      const method = req.method ?? '';
      const text = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : await bodyText(req);
      const jsonRpc = text === undefined ? undefined : (JSON.parse(text) as JsonRpcBody);
      const call: RawCall = { method, jsonRpc, headers };
      calls.push(call);
      const reply = await respond(call);
      const delay = reply.delayMs ?? 0;
      if (delay > 0) await sleep(delay);
      const outHeaders: Record<string, string> = { 'content-type': 'application/json', ...(reply.headers ?? {}) };
      res.writeHead(reply.status ?? 200, outHeaders);
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const served = await listen(server);
  return { ...served, calls };
}

function bodyText(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function listen(server: Server): Promise<Served> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://localhost:${port}/mcp`),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compile-time assertion: `expectAssignable<To>(value)` requires `value`'s type to be assignable
 * to `To`, failing tsc outright when it is not. Not vitest's `expectTypeOf().toExtend()` — under
 * `exactOptionalPropertyTypes` that matcher gives false negatives on objects with unions and
 * optional properties (a plain assignment passes). The function body is empty at runtime.
 */
export function expectAssignable<To>(_value: To): void {}

/**
 * A tool handler that never answers on its own: it resolves only when the request's signal is
 * aborted (a client timeout or cancellation), then returns a result nobody is left to read —
 * `lateText` names that result so the two fixtures can be told apart. Lets a test assert the
 * client-side budget without racing a loaded scheduler.
 */
export function neverAnswers(lateText: string) {
  return async (srv: ServerContext) => {
    await new Promise<void>((resolve) => {
      srv.mcpReq.signal.addEventListener('abort', () => resolve());
    });
    return { content: [{ type: 'text' as const, text: lateText }] };
  };
}

/** The six-piece context the framework guarantees every `execute`; only `signal` crosses the bridge. */
export function toolContext(signal: AbortSignal = new AbortController().signal): import('@oribos/core/tools').ToolContext {
  return {
    signal,
    runId: '',
    toolCallId: 'test',
    requestContext: Object.freeze({ signal, runId: '' }),
    traceId: '',
    spanId: '',
  };
}

/** Snapshot accessor: fails loudly on a missing name instead of testing `undefined`. */
export function toolOf(client: { readonly tools: Record<string, import('@oribos/core/tools').Tool> }, name: string): import('@oribos/core/tools').Tool {
  const found = client.tools[name];
  if (found === undefined) throw new Error(`tool ${name} missing from the snapshot`);
  return found;
}

/** A canned tool entry the legacy mock advertises on `tools/list`. */
export interface LegacyTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** A canned `tools/call` result body (the `result` object of the JSON-RPC response). */
export type LegacyCallResult =
  | Record<string, unknown>
  | { readonly jsonRpcError: { readonly code: number; readonly message: string } };

/**
 * A legacy-only (2025 handshake) JSON-RPC server with full wire control. `server/discover` is
 * answered with 404 so a default `'auto'` client falls back to `initialize` (the SDK treats an
 * unrecognized probe outcome as a legacy signal); `protocol: 'legacy'` skips the probe; a pinned
 * client fails loudly against it. The `mcp-session-id` response header pins the session so
 * `close()` exercises `terminateSession` (DELETE). Notifications get a bare 202.
 */
export async function serveLegacy(options: {
  readonly tools: LegacyTool[] | ((listIndex: number) => LegacyTool[]);
  readonly call?: (name: string, args: unknown) => LegacyCallResult;
  readonly session?: string;
  readonly initializeDelayMs?: number;
  /** After this many successful `tools/list` responses, answer with a JSON-RPC error instead. */
  readonly listErrorAfter?: number;
  /**
   * Pages every `tools/list` walk: the no-cursor request is page 0 and each cursor follow-up
   * the next page; page i answers `nextCursor: nextCursor(i)` (`undefined` ends the walk).
   */
  readonly nextCursor?: (pageIndex: number) => string | undefined;
}): Promise<RawServed> {
  let listIndex = 0;
  let walkPage = 0;
  return serveRaw(async (call) => {
    if (call.method === 'GET') return { status: 405, body: {} };
    const message = call.jsonRpc;
    if (message === undefined) return { status: 202 };
    const id = message.id;
    if (id === undefined) return { status: 202 };
    if (call.method === 'DELETE') return { body: {} };
    const method = message.method ?? '';
    if (method === 'server/discover') return { status: 404, body: { error: 'no modern here' } };
    if (method === 'initialize') {
      const delay = options.initializeDelayMs ?? 0;
      if (delay > 0) await sleep(delay);
      return response(id, {
        protocolVersion: (message.params?.protocolVersion as string) ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-fixture', version: '1.0.0' },
      }, options.session === undefined ? {} : { 'mcp-session-id': options.session });
    }
    if (method === 'tools/list') {
      if (options.listErrorAfter !== undefined && listIndex > options.listErrorAfter) {
        return response(id, undefined, {}, { code: -32603, message: 'mock list failure' });
      }
      walkPage = message.params?.cursor === undefined ? 0 : walkPage + 1;
      const tools = typeof options.tools === 'function' ? options.tools(listIndex) : options.tools;
      listIndex += 1;
      const cursor = options.nextCursor?.(walkPage);
      return response(id, cursor === undefined ? { tools } : { tools, nextCursor: cursor });
    }
    if (method === 'tools/call') {
      const name = message.params?.name as string;
      const args = message.params?.arguments as unknown;
      const result = options.call?.(name, args) ?? { content: [{ type: 'text', text: `echo:${name}` }] };
      const jsonRpcError = (result as { jsonRpcError?: { code: number; message: string } }).jsonRpcError;
      if (jsonRpcError !== undefined) {
        return response(id, undefined, {}, jsonRpcError);
      }
      return response(id, result);
    }
    return response(id, undefined, {}, { code: -32601, message: `no mock for ${method}` });
  });
}

function response(
  id: number | string,
  result: unknown,
  headers: Record<string, string> = {},
  error?: { readonly code: number; readonly message: string },
): RawReply {
  return {
    body: {
      jsonrpc: '2.0',
      id,
      ...(error === undefined ? { result: result ?? {} } : { error }),
    },
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}
