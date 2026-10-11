# memory-chat

Oribos's memory subsystem in one scripted session: **message history** across two threads of one
resource, the `recall()` query, and **working memory** maintained by the model through a tool call.
Oribos is a TypeScript agent framework with zero runtime dependencies — compose only what you
use, run anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input. It runs a
concise concierge agent on a real OpenAI model and walks three acts:

1. **Two conversations, interleaved** — the same agent serves a trip-planning thread and a
   weeknight-dinners thread, alternating turns. The thread lives on the call, not on the agent:
   every run passes `memory: { thread, resource }`, and the run recalls that thread's recent window
   into the prompt and saves each step back. Neither thread exists beforehand — the first save of a
   run creates the thread it names, together with the `title` / `metadata` the per-call reference
   carries.
2. **`recall()` reads a thread back** — `memory.recall({ threadId })` is message history's single
   query entry, returning messages in chronological order with their storage envelope (`id` /
   `threadId` / `resourceId` / `createdAt`). Without a limit the `lastMessages` window (default 10)
   applies; `before` pages towards older history. The act also lists the resource's threads through
   the store port, showing both were created implicitly.
3. **Working memory is written by tool call** — naming a `workingMemory: { schema }` on the
   `Memory` instance switches the second mechanism on: every memory-enabled run attaches the
   framework's `updateWorkingMemory` tool and injects the resource's current record as a system
   message (right after the instructions). The closing turn asks the agent to remember the user's
   profile; the model calls the tool, the framework merges / validates / persists the patch, and
   the act prints the stored record. Working memory is resource-scoped, so it carries across
   threads and later runs. The act asserts its own payoff: if the model never calls the tool, the
   example exits non-zero instead of printing `undefined`.

## Observability

The composition root wires one tracer for the agent (`createApp({ tracer })`, ADR-0002) and the
console exporter pretty-prints each span event. On every traced, memory-enabled run expect:

- `memory-recall` under the run's `agent-run` span — one per run, before the input processors, with
  the recalled messages as its output;
- `memory-save` under each `agent-step` — one per step, the first carrying the run's input.

No memory-specific wiring is needed: naming the thread and resource per call is enough.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-memory-chat start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-memory-chat start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one.

Expected output: the console exporter's `[oribos] span_started / …` lines, the act banners with each
`[user → thread]` / `[assistant]` turn, the recalled history, and finally the working-memory record:

```json
{
  "name": "Ada",
  "homeCity": "Lisbon",
  "diet": "vegetarian"
}
```

## Notes

- The store is the core's in-memory default (`createInMemoryStore()`); the example holds onto it
  only to list the auto-created threads. Swapping in a persistent adapter changes nothing above the
  store line.
- One `Memory` instance is shared by every run; the per-call `memory` option is what makes a run
  stateful. A run without it does no memory I/O at all.
- `updateWorkingMemory` merges patches: objects merge deeply, `null` deletes a field, arrays are
  replaced whole. The merged record is validated against the configured schema, and a
  non-conforming update comes back to the model as an error tool result.
- The example uses `openai.chat(...)` (Chat Completions), the lowest common denominator across
  OpenAI and OpenAI-compatible endpoints. Use `openai('gpt-4o-mini')` for OpenAI's Responses API.
- Like `examples/minimal-agent`, the script consumes `@oribos/core` through its built package
  exports — run `pnpm build` before `start`.
