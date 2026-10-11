# `@oribos/mcp-client`

Bridge a remote [MCP](https://modelcontextprotocol.io) server's tools into a
[Oribos](https://github.com/0xnicholas/oribos-framework) tool container: one `createMcpClient()`
object with a `tools` snapshot you spread straight into an agent, a `refresh()`, and a `close()`.

```ts
import { createAgent } from '@oribos/core/agent';
import { createMcpClient } from '@oribos/mcp-client';

const client = await createMcpClient({
  transport: { type: 'http', url: 'https://example.com/mcp' },
  // or: { type: 'stdio', command: 'npx', args: ['my-mcp-server'] }
});

const agent = createAgent({
  name: 'assistant',
  instructions: 'You have remote tools.',
  model,                                     // any AI SDK provider instance
  tools: () => client.tools,                 // dynamic: every request resolves the latest snapshot
});

await client.refresh();                      // re-list remotely, swap the snapshot
await client.close();                        // tear down (idempotent)
```

- Spec: [`docs/architecture/tools.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/tools.md)
- SDK facts this package builds on: [`docs/research/mcp-v2-sdk-surface.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/research/mcp-v2-sdk-surface.md)
- Decisions: [ADR-0008](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0008-tools-mcp-abstraction.md) (tools/MCP), [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)
- Paired example (server + client in one script): [`examples/mcp-tools`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/mcp-tools)

## Install

```bash
npm install @oribos/mcp-client @oribos/core
```

`@oribos/core` is a peer dependency (one core instance by design). The only direct runtime
dependency is `@modelcontextprotocol/client`.

## Transports and options

```ts
const client = await createMcpClient({
  transport:
    | { type: 'stdio', command: string, args?: string[], env?: Record<string, string> }
    | { type: 'http', url: string | URL, headers?: Record<string, string> },
  protocol?: 'auto' | 'legacy' | { pin: '2026-07-28' },  // omitted = 'auto'
  timeoutMs?: number,                                     // omitted = the SDK's 60s per request
});
```

- **stdio** spawns the server subprocess (the SDK owns it: shutdown is stdin → SIGTERM → SIGKILL).
  `env`, when given, is the child's **whole** environment; omitted, the SDK applies its own safe
  whitelist — never your full `process.env`. The child's stderr is inherited, so its logs reach
  yours. `stderr` / `cwd` / `maxBufferSize` are not exposed — wire the official SDK yourself for
  those (the escape hatch for everything v1 doesn't expose).
- **http** speaks Streamable HTTP; `headers` go on every request (bearer tokens and the like).
  OAuth flows, custom `fetch`, `sessionId` reattach: not exposed in v1.
- **protocol**: `'auto'` (the default — raised here; the SDK's own default is `'legacy'`) probes
  with `server/discover` first and falls back to the 2025 handshake. `'legacy'` skips the probe.
  `{ pin: '2026-07-28' }` demands the modern era and fails loudly. Note the probe's cost: on
  stdio it spawns a short-lived sibling process once per connect; on HTTP a probe timeout is
  treated as an outage and rejects.
- **timeoutMs** is passed to the connect handshake and every request (the SDK has no client-level
  default setting). There is no per-call override — a long-running tool call is what this option
  is for.
- The client identity advertised to servers is this package's own name and version, not
  overridable.

## The snapshot and its lifecycle

`client.tools` is a getter over a frozen `Record<string, Tool>` — keys are the remote tool names.
The identity is stable until the next `refresh()`; old references never break. There is no
`listChanged` subscription and **no auto-reconnect**: a dropped connection surfaces as SDK errors
on the calls in flight and after it; recovery is a new client. `close()` is idempotent — HTTP
sends `terminateSession` first (failures there are silent), then tears down; in-flight requests
reject with `CONNECTION_CLOSED`. Not calling `close()` on a stdio client keeps the subprocess
alive — the host owns the lifetime.

`prefixTools(tools, prefix, separator = '_')` renames bridged tools into a new frozen record
(`prefix + separator + name`). The prefix never reaches the wire — execute still calls the remote
name. No collision detection runs (a fixed prefix is an isomorphic mapping), and whether a
prefixed name is legal for your model provider is your concern.

## What crosses the bridge

**Schemas** arrive as JSON Schema documents and are wrapped in a pass-through Standard Schema:
`validate` always succeeds locally (validation is the remote's business — failures come back
through the execute path), and `jsonSchema.input` returns the remote document verbatim — same
reference, no rewriting between draft versions. `jsonSchema.output` throws: a bridged tool
carries no `outputSchema`, and the SDK client already validates `structuredContent` against the
remote's schema. A consequence: MCP→MCP re-exporting loses `structuredContent` (text only) —
explicit opt-in fidelity is a future minor.

**Context**: of the six `ToolContext` pieces only `signal` crosses — `callTool({ signal })`
passthrough, no pre-checks. `toolCallId` / `runId` / `traceId` / `spanId` stay local (the protocol
has no slot for them), and `requestContext` is not transmitted.

**Results**: `structuredContent` returns verbatim when present (any JSON value); otherwise text
blocks join on newlines; image / audio / resource-link blocks degrade to placeholder text — the
tool-result channel carries no multimodal parts, an honest v1 boundary. An empty result is `''`.
An `isError` result **throws**, so the framework turns it into a `Tool 'x' failed: …` error result
fed back to the model — the same road the server-side failure lines take.

**Errors** propagate as-is: no layer added, no message rewritten. Connect-time: era negotiation
failures, 401/403, probe timeouts. Runtime: request timeouts, `CONNECTION_CLOSED`, protocol
errors, output-validation failures. A remote `input_required` answer (multi-round-trip) surfaces
as a deterministic `SdkError` — this package pins `inputRequired.autoFulfill: false` and registers
no elicitation/sampling handlers.

On modern HTTP connections the SDK must drop tools whose `x-mcp-header` declarations are illegal
(SPEC MUST, warned in console) — the snapshot can be smaller than what the server advertises.

## Install only what you use

- dependency closure: everything `@modelcontextprotocol/client` pulls in — its OAuth / SSE / stdio
  closure — recorded in `deps-budget.json`, where count and unpacked size are watched in CI
- first-party code: the minified baseline is recorded in `byte-budget.json` and checked on every
  PR — a warning, not a merge gate or a public budget
- `@oribos/core` stays a peer, so there is exactly one core instance

## License

[Apache-2.0](https://github.com/0xnicholas/oribos-framework/blob/main/LICENSE)
