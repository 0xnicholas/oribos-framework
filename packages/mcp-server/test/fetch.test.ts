import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from '@oribos/mcp-server';
import type { McpServerRequestOptions } from '@oribos/mcp-server';
import { createTool } from '@oribos/core/tools';
import type { Tool, ToolContext } from '@oribos/core/tools';
import { contentOf, expectAssignable, initializeRequest, legacyHeaders, modernHeaders, post, postAuthInfo, postParsedBody, readMessage, rpc, toolsOf, withEnvelope } from './helpers.js';

const SERVER_INFO = { name: 'tools-server', version: '1.2.3' };

/**
 * The HTTP face: one `fetch` entry serving both protocol generations (the 2025 legacy
 * handshake and the 2026-07-28 per-request envelope). Tests assert the wire, not internals.
 */
describe('createMcpServer fetch', () => {
  it('initializes a legacy exchange and advertises static tools without listChanged', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } });

    const { status, message } = await post(server, initializeRequest(), legacyHeaders());

    expect(status).toBe(200);
    expect(message.result).toMatchObject({
      serverInfo: { name: 'tools-server', version: '1.2.3' },
      capabilities: { tools: { listChanged: false } },
    });
    await server.close();
  });

  it('lists every container entry with its schemas', async () => {
    const weather = createTool({
      description: 'Weather lookup',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ tempC: z.number() }),
      execute: ({ city }) => ({ tempC: city.length }),
    });
    const ping = createTool({ description: 'Liveness check', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { weather, ping } });

    const response = await post(server, rpc('tools/list', {}), legacyHeaders());
    const tools = toolsOf(response);

    expect(tools.map((tool) => tool.name).sort()).toEqual(['ping', 'weather']);
    expect(tools.find((tool) => tool.name === 'weather')).toMatchObject({
      description: 'Weather lookup',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      outputSchema: {
        type: 'object',
        properties: { tempC: { type: 'number' } },
      },
    });
    expect(tools.find((tool) => tool.name === 'ping')?.inputSchema).toEqual({ type: 'object', properties: {} });
    await server.close();
  });

  it('projects an outputSchema result as structuredContent plus rendered text', async () => {
    const echo = createTool({
      description: 'Echo',
      outputSchema: z.object({ echoed: z.string() }),
      execute: () => ({ echoed: 'ok' }),
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { echo } });

    const response = await post(server, rpc('tools/call', { name: 'echo', arguments: {} }), legacyHeaders());

    expect(response.message.result?.structuredContent).toEqual({ echoed: 'ok' });
    expect(contentOf(response)).toEqual([{ type: 'text', text: '{"echoed":"ok"}' }]);
    await server.close();
  });

  it('renders a string output over a non-object outputSchema, era-shaped on the wire', async () => {
    const greet = createTool({
      description: 'Greet',
      outputSchema: z.string(),
      execute: () => 'hello',
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { greet } });

    // The 2025 legacy wire requires an object-shaped structuredContent: the SDK wraps the value.
    const legacy = await post(server, rpc('tools/call', { name: 'greet', arguments: {} }), legacyHeaders());
    expect(legacy.message.result?.structuredContent).toEqual({ result: 'hello' });
    expect(contentOf(legacy)).toEqual([{ type: 'text', text: 'hello' }]);

    // The 2026 era carries the natural value directly.
    const modern = await post(
      server,
      rpc('tools/call', withEnvelope({ name: 'greet', arguments: {} })),
      modernHeaders('tools/call', 'greet'),
    );
    expect(modern.message.result?.structuredContent).toBe('hello');
    expect(contentOf(modern)).toEqual([{ type: 'text', text: 'hello' }]);
    await server.close();
  });

  it('projects a schema-less result as content only, JSON-stringifying non-strings', async () => {
    const stats = createTool({ description: 'Stats', execute: () => ({ count: 2 }) });
    const server = createMcpServer({ ...SERVER_INFO, tools: { stats } });

    const response = await post(server, rpc('tools/call', { name: 'stats', arguments: {} }), legacyHeaders());

    expect(response.message.result?.structuredContent).toBeUndefined();
    expect(contentOf(response)).toEqual([{ type: 'text', text: '{"count":2}' }]);
    await server.close();
  });

  it('degrades an undefined schema-less result to String', async () => {
    const nothing = createTool({ description: 'Nothing', execute: () => undefined });
    const server = createMcpServer({ ...SERVER_INFO, tools: { nothing } });

    const response = await post(server, rpc('tools/call', { name: 'nothing', arguments: {} }), legacyHeaders());

    expect(contentOf(response)).toEqual([{ type: 'text', text: 'undefined' }]);
    await server.close();
  });

  it('synthesizes the six-piece ToolContext from the MCP request', async () => {
    let captured: ToolContext | undefined;
    const capture: Tool = {
      description: 'Capture',
      execute: (_input, ctx) => {
        captured = ctx;
        return 'ok';
      },
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { capture } });

    await post(server, rpc('tools/call', { name: 'capture', arguments: {} }, 42), legacyHeaders());

    expect(captured).toBeDefined();
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.toolCallId).toBe('42');
    expect(captured?.runId).toBe('');
    expect(captured?.traceId).toBe('');
    expect(captured?.spanId).toBe('');
    expect(Object.isFrozen(captured?.requestContext)).toBe(true);
    expect(captured?.requestContext.signal).toBe(captured?.signal);
    expect({ ...captured?.requestContext }).toEqual({ signal: captured?.signal, runId: '' });
    await server.close();
  });

  it('calls a tool without inputSchema with an undefined input', async () => {
    let seen: unknown = 'unset';
    const noargs: Tool = {
      description: 'No arguments',
      execute: (input) => {
        seen = input;
        return 'ok';
      },
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { noargs } });

    await post(server, rpc('tools/call', { name: 'noargs', arguments: {} }), legacyHeaders());

    expect(seen).toBeUndefined();
    await server.close();
  });

  it('normalizes input validation failures into isError results', async () => {
    const echo = createTool({
      description: 'Echo',
      inputSchema: z.object({ city: z.string() }),
      execute: ({ city }) => city,
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { echo } });

    const response = await post(server, rpc('tools/call', { name: 'echo', arguments: { city: 42 } }), legacyHeaders());

    expect(response.message.error).toBeUndefined();
    expect(response.message.result?.isError).toBe(true);
    expect(contentOf(response)[0]?.text).toMatch(/Input validation error/);
    await server.close();
  });

  it('normalizes an execute throw into an isError result', async () => {
    const boom: Tool = {
      description: 'Boom',
      execute: () => {
        throw new Error('boom');
      },
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { boom } });

    const response = await post(server, rpc('tools/call', { name: 'boom', arguments: {} }), legacyHeaders());

    expect(response.message.result?.isError).toBe(true);
    expect(contentOf(response)).toEqual([{ type: 'text', text: 'boom' }]);
    await server.close();
  });

  it('normalizes output validation failures into isError results', async () => {
    const broken: Tool = {
      description: 'Broken',
      outputSchema: z.object({ count: z.number() }),
      execute: () => ({ count: 'not a number' }),
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { broken } });

    const response = await post(server, rpc('tools/call', { name: 'broken', arguments: {} }), legacyHeaders());

    expect(response.message.result?.isError).toBe(true);
    expect(contentOf(response)[0]?.text).toMatch(/Output validation error/);
    await server.close();
  });

  it('answers an unknown tool with a protocol error, not a tool result', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } });

    const response = await post(server, rpc('tools/call', { name: 'nope', arguments: {} }), legacyHeaders());

    expect(response.message.result).toBeUndefined();
    expect(response.message.error?.code).toBe(-32602);
    expect(response.message.error?.message).toMatch(/not found/);
    await server.close();
  });

  it('forwards request cancellation into the tool context signal', async () => {
    let aborted = false;
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold: Tool = {
      description: 'Hold',
      execute: (_input, ctx) =>
        new Promise((resolve) => {
          started();
          if (ctx.signal.aborted) {
            aborted = true;
            return resolve('done');
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve('done');
            },
            { once: true },
          );
        }),
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { hold } });
    const controller = new AbortController();

    const pending = server.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: legacyHeaders(),
        body: JSON.stringify(rpc('tools/call', { name: 'hold', arguments: {} })),
        signal: controller.signal,
      }),
    );
    await running;
    controller.abort();
    await pending.catch(() => undefined);

    await vi.waitFor(() => expect(aborted).toBe(true));
    await server.close();
  });

  it('serves a modern exchange with the per-request envelope', async () => {
    const echo = createTool({
      description: 'Echo',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      execute: ({ city }) => ({ echoed: city }),
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { echo } });

    const listed = await post(server, rpc('tools/list', withEnvelope({})), modernHeaders('tools/list'));
    expect(toolsOf(listed).map((tool) => tool.name)).toEqual(['echo']);

    const called = await post(
      server,
      rpc('tools/call', withEnvelope({ name: 'echo', arguments: { city: 'modern' } })),
      modernHeaders('tools/call', 'echo'),
    );
    expect(called.message.result?.structuredContent).toEqual({ echoed: 'modern' });
    await server.close();
  });

  it('serves modern-only when the legacy posture is reject', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } }, { http: { legacy: 'reject' } });

    const rejected = await post(server, initializeRequest(), legacyHeaders());
    expect(rejected.status).toBe(400);
    expect(rejected.message.error?.code).toBe(-32022);
    expect(rejected.message.error?.data?.supported).toContain('2026-07-28');

    const listed = await post(server, rpc('tools/list', withEnvelope({})), modernHeaders('tools/list'));
    expect(toolsOf(listed).map((tool) => tool.name)).toEqual(['ping']);
    await server.close();
  });

  it('passes a pre-parsed body through to the handler', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } });

    const response = await postParsedBody(server, rpc('tools/list', {}), legacyHeaders());

    expect(toolsOf(response).map((tool) => tool.name)).toEqual(['ping']);
    await server.close();
  });

  it('rejects fetch after close', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } });
    await server.close();

    await expect(
      server.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: legacyHeaders(),
          body: JSON.stringify(rpc('tools/list', {})),
        }),
      ),
    ).rejects.toThrow(/closed/i);
  });

  it('passes authInfo straight through to the SDK handler, never into the ToolContext', async () => {
    let captured: ToolContext | undefined;
    const capture: Tool = {
      description: 'Capture',
      execute: (_input, ctx) => {
        captured = ctx;
        return 'ok';
      },
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { capture } });
    const authInfo = { token: 'tok', clientId: 'client-1', scopes: ['read'] };
    // The option type is the SDK's own, re-exported: `authInfo` is part of the surface.
    expectAssignable<McpServerRequestOptions>({ authInfo });

    const response = await postAuthInfo(server, rpc('tools/call', { name: 'capture', arguments: {} }), legacyHeaders(), authInfo);

    expect(response.message.error).toBeUndefined();
    expect(captured).toBeDefined();
    // v1 does not consume authInfo: the synthesized context stays the six-piece shape, MCP
    // facts are not stuffed in (authorization is the transport middleware's business).
    expect({ ...captured?.requestContext }).toEqual({ signal: captured?.signal, runId: '' });
    await server.close();
  });

  it('serves both eras with no config at all: legacy stateless (session ops 405) and modern', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ ...SERVER_INFO, tools: { ping } });

    const legacy = await post(server, rpc('tools/list', {}), legacyHeaders());
    expect(toolsOf(legacy).map((tool) => tool.name)).toEqual(['ping']);

    const modern = await post(server, rpc('tools/list', withEnvelope({})), modernHeaders('tools/list'));
    expect(toolsOf(modern).map((tool) => tool.name)).toEqual(['ping']);

    // The default legacy posture is stateless: 2025 session operations have nothing to act on.
    const get = await server.fetch(new Request('http://localhost/mcp', { method: 'GET', headers: legacyHeaders() }));
    expect(get.status).toBe(405);
    expect((await readMessage(get)).error?.code).toBe(-32000);
    const del = await server.fetch(new Request('http://localhost/mcp', { method: 'DELETE', headers: legacyHeaders() }));
    expect(del.status).toBe(405);
    await server.close();
  });

  it('close() aborts an in-flight modern exchange: the tool signal fires and the exchange settles 499', async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const slow: Tool = {
      description: 'Slow',
      execute: (_input, ctx) =>
        new Promise(() => {
          started();
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { slow } });

    const pending = server.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: modernHeaders('tools/call', 'slow'),
        body: JSON.stringify(rpc('tools/call', withEnvelope({ name: 'slow', arguments: {} }))),
      }),
    );
    await running;
    await server.close();

    // The aborted exchange settles as the SDK's client-gone answer (499, empty body) — no result.
    const response = await pending;
    expect(response.status).toBe(499);
    expect(aborted).toBe(true);
  });

  it('close() does not track a legacy stateless exchange: it resolves while one is in flight and the exchange still completes', async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const slow: Tool = {
      description: 'Slow',
      execute: async () => {
        started();
        return gate;
      },
    };
    const server = createMcpServer({ ...SERVER_INFO, tools: { slow } });

    const pending = server.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: legacyHeaders(),
        body: JSON.stringify(rpc('tools/call', { name: 'slow', arguments: {} })),
      }),
    );
    await running;
    // Per-request by construction: close() holds nothing open and returns without awaiting the exchange.
    await server.close();
    release('legacy-done');

    const response = await pending;
    expect(response.status).toBe(200);
    expect((await readMessage(response)).result?.content).toEqual([{ type: 'text', text: 'legacy-done' }]);
  });

  it('snapshots the tool container at construction: later mutations never reach the wire', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const tools: Record<string, Tool> = { ping };
    const server = createMcpServer({ ...SERVER_INFO, tools });

    tools.late = createTool({ description: 'Late', execute: () => 'late' });
    tools.ping = createTool({ description: 'Ping', execute: () => 'replaced' });

    const listed = await post(server, rpc('tools/list', {}), legacyHeaders());
    expect(toolsOf(listed).map((tool) => tool.name)).toEqual(['ping']);

    const called = await post(server, rpc('tools/call', { name: 'ping', arguments: {} }), legacyHeaders());
    expect(contentOf(called)).toEqual([{ type: 'text', text: 'pong' }]);

    const late = await post(server, rpc('tools/call', { name: 'late', arguments: {} }), legacyHeaders());
    expect(late.message.result).toBeUndefined();
    expect(late.message.error?.code).toBe(-32602);
    await server.close();
  });

  it('runs the input schema transform: execute receives the validated (transformed) value', async () => {
    let seen: unknown;
    const trim = createTool({
      description: 'Trim',
      inputSchema: z.object({ city: z.string().trim() }),
      execute: (input) => {
        seen = input;
        return input.city;
      },
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { trim } });

    const response = await post(server, rpc('tools/call', { name: 'trim', arguments: { city: '  Oslo  ' } }), legacyHeaders());

    expect(seen).toEqual({ city: 'Oslo' });
    expect(contentOf(response)).toEqual([{ type: 'text', text: 'Oslo' }]);
    await server.close();
  });

  it('rejects a non-object-root inputSchema at tools/list with the SDK object-root error', async () => {
    // MCP requires `type: "object"` at an inputSchema's root; the SDK converts schemas at list
    // time (registration only memoizes), so the rejection surfaces there, not at construction.
    const bare = createTool({
      description: 'Bare string root',
      inputSchema: z.string(),
      execute: (input) => String(input),
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { bare } });

    const listed = await post(server, rpc('tools/list', {}), legacyHeaders());

    expect(listed.message.result).toBeUndefined();
    expect(listed.message.error?.code).toBe(-32603);
    expect(listed.message.error?.message).toMatch(/must describe objects \(got type: "string"\)/);
    await server.close();
  });

  it('derives the tools/list JSON Schema at draft 2020-12 ($schema marker)', async () => {
    const weather = createTool({
      description: 'Weather lookup',
      inputSchema: z.object({ city: z.string() }),
      execute: ({ city }) => city,
    });
    const server = createMcpServer({ ...SERVER_INFO, tools: { weather } });

    const listed = await post(server, rpc('tools/list', {}), legacyHeaders());

    expect(toolsOf(listed).find((tool) => tool.name === 'weather')?.inputSchema?.['$schema']).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    await server.close();
  });
});
