/**
 * The HTTP face against a real SDK server (`createMcpHandler` on a loopback port): connection
 * and snapshot, the bridged-tool projection round-trips, timeout/signal passthrough, the MRTR
 * posture, and close semantics. The seam is the package's public face only.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inputRequired } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { createMcpClient } from '@oribos/mcp-client';
import { neverAnswers, serveSdkServer, sleep, toolContext, toolOf, type Served } from './helpers.js';

/** Captures a rejection (or a resolution's absence) as a value for asserting on. */
const caught = (call: unknown): Promise<unknown> =>
  Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error,
  );

function httpConfig(served: Served, timeoutMs?: number) {
  return {
    transport: { type: 'http' as const, url: served.url },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

describe('createMcpClient over HTTP', () => {
  it('connects and snapshots the remote tool list', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool(
        'echo',
        { description: 'Echo back the input', inputSchema: z.object({ value: z.string() }) },
        async ({ value }: { value: string }) => ({
          content: [{ type: 'text' as const, text: value }],
        }),
      );
    });
    try {
      const client = await createMcpClient(httpConfig(served));

      expect(Object.keys(client.tools).sort()).toEqual(['echo']);
      expect(client.tools.echo?.description).toBe('Echo back the input');
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('returns structuredContent verbatim for a tool with an output schema', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool(
        'weather',
        { description: 'Weather', inputSchema: z.object({ city: z.string() }), outputSchema: z.object({ celsius: z.number() }) },
        async ({ city }: { city: string }) => ({
          content: [{ type: 'text' as const, text: String(city.length) }],
          structuredContent: { celsius: city.length },
        }),
      );
    });
    try {
      const client = await createMcpClient(httpConfig(served));
      const output = await toolOf(client, 'weather').execute({ city: 'Oslo' }, toolContext());
      expect(output).toEqual({ celsius: 4 });
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('joins text blocks when there is no structuredContent', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool('plain', { description: 'Text only' }, async () => ({
        content: [{ type: 'text' as const, text: 'first' }],
      }));
    });
    try {
      const client = await createMcpClient(httpConfig(served));
      const output = await toolOf(client, 'plain').execute(undefined, toolContext());
      expect(output).toBe('first');
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('throws when the remote tool answers isError', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool('broken', { description: 'Always fails' }, async () => {
        throw new Error('boom from the server');
      });
    });
    try {
      const client = await createMcpClient(httpConfig(served));
      await expect(toolOf(client, 'broken').execute(undefined, toolContext())).rejects.toThrow(/boom from the server/);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('passes timeoutMs to every callTool (REQUEST_TIMEOUT when the tool never answers)', async () => {
    // `timeoutMs` is one budget shared by the connect handshake, listTools and every callTool
    // (the package's per-request semantics), so it must clear a loopback handshake even when the
    // suite runs many workers in parallel. The tool below never answers on its own: what the
    // assertion times is the call's timeout, far above any handshake, not a scheduler race.
    const served = await serveSdkServer((server) => {
      server.registerTool('hangs', { description: 'Never answers' }, neverAnswers('finally'));
    });
    try {
      const client = await createMcpClient(httpConfig(served, 1_000));
      const error: unknown = await caught(toolOf(client, 'hangs').execute(undefined, toolContext()));
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('propagates the context signal into the remote call', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool('hanging', { description: 'Waits for cancellation' }, neverAnswers('never seen'));
    });
    try {
      const client = await createMcpClient(httpConfig(served, 10_000));
      const controller = new AbortController();
      const pending = toolOf(client, 'hanging').execute(undefined, { ...toolContext(), signal: controller.signal });
      await sleep(100);
      controller.abort();
      await expect(pending).rejects.toThrow();
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('answers input_required with a deterministic SdkError (autoFulfill pinned false)', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool('asker', { description: 'Asks for input' }, async () =>
        inputRequired({ requestState: 'opaque-state' }),
      );
    });
    try {
      const client = await createMcpClient(httpConfig(served));
      const error: unknown = await caught(toolOf(client, 'asker').execute(undefined, toolContext()));
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.UnsupportedResultType);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('is idempotent on close and rejects further calls with the SDK error untouched', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool(
        'echo',
        { description: 'Echo', inputSchema: z.object({ value: z.string() }) },
        async ({ value }: { value: string }) => ({
          content: [{ type: 'text' as const, text: value }],
        }),
      );
    });
    try {
      const client = await createMcpClient(httpConfig(served));
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
      // A new call after close hits the SDK's own "Not connected" — thrown through untouched,
      // no layer added (spec:「错误面」); in-flight requests at close time reject with
      // CONNECTION_CLOSED inside the SDK.
      await expect(toolOf(client, 'echo').execute({ value: 'x' }, toolContext())).rejects.toThrow(/Not connected/);
    } finally {
      await served.close();
    }
  });

  it('rejects an in-flight call with CONNECTION_CLOSED when close() runs', async () => {
    const served = await serveSdkServer((server) => {
      server.registerTool('hanging', { description: 'Never answers' }, neverAnswers('closed mid-flight'));
    });
    try {
      const client = await createMcpClient(httpConfig(served, 10_000));
      const pending = caught(toolOf(client, 'hanging').execute(undefined, toolContext()));
      await sleep(100);

      await client.close();

      const inFlight: unknown = await pending;
      expect(SdkError.isInstance(inFlight)).toBe(true);
      expect((inFlight as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
      expect((inFlight as SdkError).message).toBe('Connection closed');
      // The error face after close is different: a fresh call fails before any transport work
      // with the SDK's plain "Not connected" (no SdkError code), and close stays idempotent.
      const afterClose: unknown = await caught(toolOf(client, 'hanging').execute(undefined, toolContext()));
      expect(SdkError.isInstance(afterClose)).toBe(false);
      expect((afterClose as Error).message).toBe('Not connected');
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await served.close();
    }
  });
});
