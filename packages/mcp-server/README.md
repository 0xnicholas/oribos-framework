# `@oribos/mcp-server`

Serve a [Oribos](https://github.com/0xnicholas/oribos-framework) tool container over MCP: one
`createMcpServer()` object with a web-standard HTTP `fetch` handler and a stdio entry, both fed
by the same tools.

```ts
import { createTool } from '@oribos/core/tools';
import { createMcpServer } from '@oribos/mcp-server';
import { z } from 'zod';

const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, celsius: 18 }),
});

const server = createMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: { weather },
});

export default { fetch: server.fetch }; // web-standard HTTP handler
// or: const handle = server.serveStdio(); // JSON-RPC over stdin/stdout
```

Servers speak both protocol generations by default: the 2026-07-28 per-request model and the
2025 legacy handshake, stateless. Pass `{ http: { legacy: 'reject' } }` (`{ legacy: 'reject' }`
for stdio) to serve modern only. Legacy **sessionful** serving is out of scope — wire it yourself
with the official `McpServer.connect(transport)` when you need it.

- Spec: [`docs/architecture/tools.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/tools.md)
- SDK facts this package builds on: [`docs/research/mcp-v2-sdk-surface.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/research/mcp-v2-sdk-surface.md)
- Decisions: [ADR-0008](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0008-tools-mcp-abstraction.md) (tools/MCP), [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)

## Install

```bash
npm install @oribos/mcp-server @oribos/core zod
```

`@oribos/core` is a peer dependency (one core instance by design); `zod` is only needed when
your tools declare schemas. The only direct runtime dependency is
`@modelcontextprotocol/server`.

## HTTP

`server.fetch` is a plain web-standard handler: `(request, options?) => Response`. The optional
options are passed through to the SDK — `parsedBody` for frameworks that already consumed the
body, `authInfo` as a pass-through (not consumed in v1).

### Web-standard runtimes

```ts
export default { fetch: server.fetch }; // Cloudflare Workers, Deno, Bun, …
```

### Next.js (App Router)

```ts
// app/mcp/route.ts
import { server } from '@/lib/mcp';

export const POST = (request: Request) => server.fetch(request);
```

### Hono

```ts
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { server } from './mcp';

declare module 'hono' {
  interface ContextVariableMap {
    parsedBody: unknown;
  }
}

const app = createMcpHonoApp(); // binds 127.0.0.1 per default → Host/Origin validation on
app.all('/mcp', (c) => server.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));

export default app; // on Node, hand it to @hono/node-server's serve()
```

### Plain `node:http` (with Host/Origin protection)

Install the official Node adapter and wire its guards in front of the handler:

```ts
import { createServer } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { server } from './mcp';

const handle = toNodeHandler(server); // accepts anything with a `fetch` member
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer((req, res) => {
  if (!validateHost(req, res)) return; // 403 on a non-localhost Host
  if (!validateOrigin(req, res)) return; // 403 on a non-localhost Origin; absent Origin passes
  void handle(req, res);
}).listen(3000, '127.0.0.1');
```

When you bind a public interface (`0.0.0.0`, `::`), localhost validation is the wrong guard —
use explicit allowlists instead: `hostHeaderValidation(['mcp.example.com'])` and
`originValidation(['mcp.example.com'])`. Requests without an `Origin` header always pass
(non-browser MCP clients do not send one). The Hono/Express/Fastify middleware packages apply
the same guards with their own defaults (`@modelcontextprotocol/hono`, `-express`, `-fastify`).

## stdio

```ts
const handle = server.serveStdio(); // process stdin/stdout; JSON-RPC on stdout
// …on shutdown:
await handle.close();
```

stdout is the JSON-RPC channel — log to stderr. On stdin EOF the transport closes and in-flight
requests are aborted. `server.close()` closes every stdio connection opened through it, plus the
HTTP handler (after which `fetch` rejects).

## What crosses the bridge

**Tool names** are validated at construction: `[A-Za-z0-9_.-]{1,128}` (the MCP spec's SHOULD
charset — dots included). An illegal key throws from `createMcpServer()`; the SDK itself checks
neither charset nor length. Agent-domain legality does not imply MCP-domain legality.

**Schemas** go over untouched (Standard Schema dual interface): the SDK derives the `tools/list`
JSON Schema through `~standard.jsonSchema` (target 2020-12), and validates input and output
through `~standard.validate()`. Tool input schemas need an object root. This is the same source
the core sends to model providers through its own draft-07 exit.

**Context**: every `execute(input, ctx)` receives the six-piece `ToolContext`. From MCP:
`signal` is the request's abort signal, and `toolCallId` is the JSON-RPC request id
(`String(ctx.mcpReq.id)`) — an identity, not a cross-connection-stable key. `runId` / `traceId` /
`spanId` are empty strings (MCP has no run; no tracer is injected), and `requestContext` is the
frozen empty bag with the framework-written `signal` / `runId` fields only.

**Results**: with an `outputSchema`, the result carries `structuredContent` (the output as
returned) plus one text block rendered from it; without one, only the text block. Rendering: a
string passes through verbatim, everything else is `JSON.stringify`, and a stringify miss
(`undefined`, functions) degrades to `String(value)`. On the 2025 wire the SDK wraps a
non-object `structuredContent` as `{ result: … }` (the era's schema requires an object); the
2026 era carries the natural value.

**Errors**: input validation failure, an `execute` throw, and output validation failure all come
back as `isError: true` tool results — the SDK normalizes them, this package adds no layer and
rewrites no message. An unknown tool is a protocol error instead, as MCP requires.

## Install only what you use

- dependency closure: `@modelcontextprotocol/server` plus its core / zod closure, recorded in
  `deps-budget.json`, where count and unpacked size are watched in CI
- first-party code: the minified baseline is recorded in `byte-budget.json` and checked on every
  PR — a warning, not a merge gate or a public budget
- `@oribos/core` stays a peer, so there is exactly one core instance

## License

[Apache-2.0](https://github.com/0xnicholas/oribos-framework/blob/main/LICENSE)
