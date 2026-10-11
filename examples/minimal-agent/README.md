# minimal-agent

The smallest runnable Oribos example. Oribos is a TypeScript agent framework — zero
runtime dependencies, compose only what you use, run anywhere.

This example defines a five-field agent (`name` / `instructions` / `model` / `tools`) with one
tool and runs one `stream()` round-trip. The output object supports both consumption styles:
`for await` yields the core's own chunk protocol (here: each `text-delta` is rendered as it
arrives), and the terminal values (`finishReason` / `usage` / `steps`) are awaited on the same
object. The model instance comes straight from an AI SDK provider package (`@ai-sdk/openai`) — no
adapter, no registry (ADR-0004). Instructions become the system message, the input becomes the
user message.

`generate()` is the same run collapsed to its terminal value — literally `stream()` + await the
terminal values, one code path, so the two always agree.

## Tools and the built-in loop

The `weather` tool is a four-field plain object — `description`, optional `inputSchema` /
`outputSchema`, `execute` — and its name is its key in the `tools` container. The schemas are
Standard Schema dual interfaces (here via zod@4): the framework validates the model's arguments
against them and sends `~standard.jsonSchema` to the provider. The second `execute` parameter is
the six-piece tool context (`signal` / `runId` / `toolCallId` / `requestContext` / `traceId` /
`spanId`).

When the model answers with a tool call, the built-in loop executes the tool, appends the round
trip to the conversation in the provider's own prompt format and calls the model again — until a
step requests no tool call or `maxSteps` (default 5) is reached. Failures never abort the run:
invalid input, an `execute` throw and invalid output all come back to the model as an `isError`
tool result, so it can recover or give up on its own.

Expected output: the console exporter's `[oribos] span_started / …` lines for the agent run, each
step and the tool call; a `[tool-call] …` line, the tool's result, then the model's text streamed
as it arrives, followed by a `steps` / `finishReason` / `usage` summary.

## Composition root and observability

`createApp({ tracer })` is the optional thin assembly point (ADR-0002): the tracer is assembled
once here and handed to every agent built through the app — `app.agent({ … })` — with no
per-agent wiring. The example uses the built-in console exporter, which pretty-prints each span
event (`agent-run` → `agent-step` → `tool-call`) as it happens; the memory exporter is its
test-time counterpart (a ring buffer your tests assert against). A standalone `new Agent({ … })`
stays a first-class usage: no app, no tracer, no span objects, zero overhead.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-minimal-agent start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-minimal-agent start
```

## Notes

- The example uses `openai.chat(...)` (Chat Completions), the lowest common denominator across
  OpenAI and OpenAI-compatible endpoints. Use `openai('gpt-4o-mini')` for OpenAI's Responses API.
- The run starts on first consumption (the first `for await` step or the first terminal promise).
- Leaving the `for await` loop early does not cancel the run; pass a per-call `signal` to cancel.
- `maxSteps` bounds the loop; when it is reached while the model still asks for tools, the
  terminal `finishReason` is `'tool-calls'` — the truncation signal.
- Observability is wired through the composition root (see above): swapping in the memory
  exporter, or dropping the tracer entirely, needs no change to the agent.
