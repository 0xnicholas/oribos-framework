# `@oribos/ai-sdk`

Serve a [Oribos](https://github.com/0xnicholas/oribos-framework) agent to AI SDK clients: one
`createChatRoute()` handler that speaks the UI message stream `useChat()` consumes, plus the
stream converter and history read-back behind it. Zero runtime dependencies; `@oribos/core` is a
peer.

```ts
import { createApp } from '@oribos/core';
import { createChatRoute } from '@oribos/ai-sdk';

const app = createApp({});
const agent = app.agent({ name: 'desk', instructions: '…', model });

export default {
  fetch: createChatRoute({ agent, identity: () => ({ resource: 'customer-1' }) }),
};
```

- Spec: [`docs/architecture/model.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/model.md)
- Protocol facts this package builds on: [`docs/research/ai-sdk-ui-stream-protocol.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/research/ai-sdk-ui-stream-protocol.md)
- Decisions: [ADR-0004](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0004-model-layer-dual-track.md) (model layer), [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)

## Install

```bash
npm install @oribos/ai-sdk @oribos/core
```

## The route

`createChatRoute({ agent, identity, onError?, keepAliveMs? })` returns
`(request: Request) => Promise<Response>` — POST only, on any web-standard host (Workers, Deno,
Bun, Next.js route handlers, Hono, plain `node:http` behind a thin adapter — see
[`examples/ai-chat-route`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/ai-chat-route)).

Runs are **memory-authoritative**: `identity(request)` maps the raw request to
`{ thread?, resource }` (the thread defaults to the body's `id`; the resource is required and its
authorization is yours). Only the tail user message of the body crosses (text and file parts —
file parts must carry `data:` URLs; nothing is fetched); history is thread recall, never a replay
of the client's message list. `modelSettings` / `maxSteps` and friends are never read from the
body.

Responses carry the official five headers (`x-vercel-ai-ui-message-stream: v1` included) and end
with `[DONE]`. Failures before the first frame answer as JSON (`405` / `400` with a specific
reason, `500` sanitized — `onError` replaces the text); after it, the stream carries an `error`
frame and `finish { finishReason: 'error' }` under HTTP 200. `keepAliveMs` is off by default —
enable it explicitly behind proxying intermediaries. Cancelling the request aborts the run.

## Suspension

Pass a durable agent (`createDurableAgent`) and a run that hits the approval gate ends the stream
with `finishReason: 'other'` plus `messageMetadata.suspended { runId, awaitingApproval }` — no
`tool-approval-*` frames. Resuming is application orchestration, not route logic: read the
`runId`, get the decision through your own channel, call
`durable.resume(runId, { approved, memory })`. The example shows the full pattern.

## The other two exports

- `toAISdkStream(stream, { onError? })` — any chunk stream (agent run, signals subscription) as
  body frames of the UI message stream. Message-level `start` / `finish` are the caller's; SSE
  encoding is the route's.
- `toAISdkMessages(messages)` — stored thread history as UI messages: one user message each, the
  assistant/tool run after it folded into one assistant message. Ids come from the stored
  messages, so refreshed history re-renders under ids that differ from the live stream's
  client-generated assistant id (known divergence).

## Drift discipline

One target generation: the `ai@7` vocabulary plus the `v1` wire header — no `version` option, no
multi-generation adapter; a new AI SDK generation is a breaking release of this package. The
emitted frame set is a closed subset of `UIMessageChunk` (CI-asserted against the real `ai`
package, pinned exactly at `7.0.123` as a devDependency): tool calls arrive as
`tool-input-available` with `providerExecuted` / `dynamic` true, usage rides the `finish` frame's
metadata, and everything unreconstructible from the chunk protocol (sources, approvals, data
parts…) is simply not emitted. Reasoning and tool-input deltas are the one opt-in: a run created
with `deltas: { reasoning: true, toolInput: true }` (`AgentRunOptions`, or the `createChatRoute`
config) streams them as their `reasoning-*` / `tool-input-*` frames; by default neither family is
emitted.

## Install only what you use

- runtime dependencies: none beyond the `@oribos/core` peer (the declared-dependency gate is
  enforced in CI)
- first-party code: the minified baseline is recorded in `byte-budget.json` and checked on every
  PR — a warning, not a merge gate or a public budget
- `@oribos/core` stays a peer, so there is exactly one core instance

## License

[Apache-2.0](https://github.com/0xnicholas/oribos-framework/blob/main/LICENSE)
