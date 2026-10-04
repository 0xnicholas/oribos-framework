/**
 * Connect-time `listTools` auto-pagination against the raw legacy mock: a no-cursor call follows
 * `nextCursor` and aggregates every page into one snapshot (order preserved); `refresh()`
 * re-walks the pages for real (`cacheMode: 'refresh'` forces a fetch past the SDK's response
 * cache); a server whose paging never converges hits the SDK's 64-page cap with
 * `LIST_PAGINATION_EXCEEDED`. Existing list coverage is single-page only — this is the
 * multi-page pin.
 */
import { describe, expect, it } from 'vitest';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { createMcpClient } from '@oribos/mcp-client';
import { serveLegacy, type LegacyTool } from './helpers.js';

const caught = (call: unknown): Promise<unknown> =>
  Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error,
  );

const page = (...names: string[]): LegacyTool[] =>
  names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));

describe('listTools pagination', () => {
  it('aggregates every page at connect (order preserved) and re-paginates on refresh', async () => {
    // Two pages per walk: page 0 carries `nextCursor: 'p2'`, page 1 ends the walk.
    const pages = [
      page('alpha', 'beta'),
      page('gamma'),
      page('delta'),
      page('epsilon', 'zeta'),
    ];
    const served = await serveLegacy({
      tools: (listIndex) => pages[listIndex] ?? [],
      nextCursor: (pageIndex) => (pageIndex === 0 ? 'p2' : undefined),
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });

      expect(Object.keys(client.tools)).toEqual(['alpha', 'beta', 'gamma']);
      const firstWalk = served.calls.filter((call) => call.jsonRpc?.method === 'tools/list');
      expect(firstWalk).toHaveLength(2);
      expect(firstWalk[0]?.jsonRpc?.params?.cursor).toBeUndefined();
      expect(firstWalk[1]?.jsonRpc?.params?.cursor).toBe('p2');

      await client.refresh();

      expect(Object.keys(client.tools)).toEqual(['delta', 'epsilon', 'zeta']);
      const secondWalk = served.calls.filter((call) => call.jsonRpc?.method === 'tools/list');
      expect(secondWalk).toHaveLength(4);
      expect(secondWalk[2]?.jsonRpc?.params?.cursor).toBeUndefined();
      expect(secondWalk[3]?.jsonRpc?.params?.cursor).toBe('p2');
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('caps a never-converging walk at the SDK listMaxPages with LIST_PAGINATION_EXCEEDED', async () => {
    // Every page is fresh (a same-items page would trip the SDK's loop guard instead) and every
    // page points onward — the walk only ends at the cap.
    const served = await serveLegacy({
      tools: (listIndex) => page(`tool-${listIndex}`),
      nextCursor: () => 'more',
    });
    try {
      const error = await caught(createMcpClient({ transport: { type: 'http', url: served.url } }));
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.ListPaginationExceeded);
      expect((error as SdkError).data).toMatchObject({ method: 'tools/list', listMaxPages: 64 });
    } finally {
      await served.close();
    }
  });
});
