# ai-chat-route

One `useChat()`-compatible HTTP route around a durable agent: [`@oribos/ai-sdk`](../../packages/ai-sdk/)'s
`createChatRoute` speaks the AI SDK UI message stream, memory is the conversation authority, and a gated
tool call suspends inside the stream — the application resumes it out-of-band. Oribos is a TypeScript
agent framework with zero runtime dependencies — compose only what you use, run anywhere.

The example hosts the route on plain `node:http` (`src/index.ts`; any web-standard host works the same
way — the route speaks `Request → Response`) and plays the client with raw `fetch`, exactly the bytes
`useChat`'s transport sends. Three acts plus the negative space:

1. **The client chats** — the request's tail user message crosses, history is thread recall (the client's
   message list is never replayed), and the answer streams back with the official five headers, `start`
   without a messageId, body frames, `finish` and `[DONE]`.
2. **The run suspends in the stream** — the model calls the approval-gated `issueRefund`; the stream ends
   `finishReason: 'other'` with `messageMetadata.suspended { runId, awaitingApproval }`. No
   `tool-approval-*` frames: the UI renders the held tool part itself.
3. **The application resumes out-of-band** — read the `runId` off the finish frame and call
   `durable.resume(runId, { approved: true, memory })`; resuming is application orchestration, not route
   logic. The next turn recalls the same thread, and `toAISdkMessages` renders the stored thread back as
   UI messages.
4. **The negative space** — `GET` → 405 (`Allow: POST`), invalid JSON → 400, a tail that is not a user
   message → 400.

## Run

From the repo root:

```bash
pnpm install
pnpm build
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-ai-chat-route start
```

Any OpenAI-compatible endpoint works too, e.g. a local Ollama:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-ai-chat-route start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one. The script self-asserts
(`node:assert/strict`): a stream that does not suspend, a resume that does not execute the held call, a
second turn that fails to recall — each exits non-zero instead of printing a happy face.

## Notes

- The `node:http` adapter is example glue — `createChatRoute` returns a web-standard
  `(request: Request) => Promise<Response>`, so Next.js / Hono / Workers hosts plug in directly.
- The example consumes `@oribos/core` and `@oribos/ai-sdk` through their built package exports — run
  `pnpm build` before `start`. Package docs: [`packages/ai-sdk`](../../packages/ai-sdk/) — the AI SDK
  interoperability capability package; the suspension/resume underneath it is the core's durable-agent
  semantics.
