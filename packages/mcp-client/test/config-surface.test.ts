/**
 * The config type surface (tools.md「MCP client 能力包」): the transport is exactly
 * `{ type:'stdio', command, args?, env? }` or `{ type:'http', url, headers? }`, plus
 * `protocol?` / `timeoutMs?` at the top level — the stdio `stderr` / `cwd` / `maxBufferSize`
 * knobs, HTTP's `fetch` / `authProvider` / `sessionId`, `listMaxPages`, the response-cache
 * trio, client middleware, and transport-instance injection are all deliberately not exposed
 * (the escape hatch is wiring the official SDK yourself). These are compile-time pins: the
 * bodies run as no-ops and `pnpm typecheck` is what enforces them — a `@ts-expect-error`
 * whose line stops erroring fails the typecheck as unused.
 */
import { describe, it } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpClientConfig } from '@oribos/mcp-client';
import { expectAssignable } from './helpers.js';

describe('McpClientConfig knob surface', () => {
  it('accepts exactly the two transport shapes plus protocol and timeoutMs', () => {
    expectAssignable<McpClientConfig>({ transport: { type: 'stdio', command: 'mcp-server' } });
    expectAssignable<McpClientConfig>({
      transport: { type: 'stdio', command: 'mcp-server', args: ['--flag'], env: { MARKER: '1' } },
    });
    expectAssignable<McpClientConfig>({ transport: { type: 'http', url: 'https://mcp.example.com/mcp' } });
    expectAssignable<McpClientConfig>({
      transport: { type: 'http', url: new URL('https://mcp.example.com/mcp'), headers: { authorization: 'Bearer t' } },
    });
    expectAssignable<McpClientConfig>({ transport: { type: 'http', url: 'https://mcp.example.com/mcp' }, protocol: 'auto' });
    expectAssignable<McpClientConfig>({ transport: { type: 'http', url: 'https://mcp.example.com/mcp' }, protocol: 'legacy' });
    expectAssignable<McpClientConfig>({
      transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
      protocol: { pin: '2026-07-28' },
      timeoutMs: 5_000,
    });
  });

  it('exposes none of the SDK stdio knobs beyond command/args/env', () => {
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'stdio',
        command: 'mcp-server',
        // @ts-expect-error stderr stays the SDK default (inherit) — child logs go to the parent's stderr
        stderr: 'pipe',
      },
    });
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'stdio',
        command: 'mcp-server',
        // @ts-expect-error cwd is not a package knob
        cwd: '/tmp',
      },
    });
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'stdio',
        command: 'mcp-server',
        // @ts-expect-error maxBufferSize is not a package knob
        maxBufferSize: 1024,
      },
    });
  });

  it('exposes none of the SDK HTTP knobs beyond url/headers', () => {
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        // @ts-expect-error authProvider is not wired — bearer-style headers cover v1
        authProvider: {},
      },
    });
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        // @ts-expect-error sessionId is transport state, not configuration
        sessionId: 'pinned',
      },
    });
    expectAssignable<McpClientConfig>({
      transport: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        // @ts-expect-error fetch injection is not a package knob
        fetch: globalThis.fetch,
      },
    });
  });

  it('exposes no top-level SDK knobs beyond protocol/timeoutMs', () => {
    // @ts-expect-error listMaxPages stays at the SDK's own 64-page cap
    expectAssignable<McpClientConfig>({ transport: { type: 'http', url: 'https://mcp.example.com/mcp' }, listMaxPages: 8 });
    expectAssignable<McpClientConfig>({
      transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
      // @ts-expect-error the response-cache trio is not exposed
      defaultCacheTtlMs: 1_000,
    });
  });

  it('rejects transport-instance injection: config is data, not a live SDK object', () => {
    // @ts-expect-error an SDK transport instance is not a config literal (escape hatch: wire the SDK yourself)
    expectAssignable<McpClientConfig>({ transport: new StdioClientTransport({ command: 'mcp-server' }) });
  });
});
