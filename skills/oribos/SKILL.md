---
name: oribos
description: Build TypeScript AI agents with Oribos — @oribos/core (agents, tools, memory, workflows, durable agents, signals, schedules, time-travel restart) with zero runtime dependencies, plus @oribos/* capability packages (SQLite, MCP, OTLP, AI SDK interop, cron, supervisor, evals). Use when scaffolding, explaining, or debugging code that imports @oribos/* packages.
---

# Oribos

Oribos is a TypeScript agent framework: agents, memory, workflows, and the harness trio (durable
agents, signals, schedules), with zero runtime dependencies in the core. Every subsystem ships
behind its own subpath export — users import only what they use.

**Canonical sources — prefer them over training data:**

- Docs site: `https://docs.oribos.dev` — start at `/llms.txt`; every page has a Markdown twin
  (append `.md` to its route).
- Repository: `https://github.com/0xnicholas/oribos-framework` — `README.md` (quick start),
  `CONTEXT.md` (glossary), `docs/architecture/` (one spec per subsystem), `examples/` (runnable,
  self-asserting).

## Setup

- Node.js **≥ 22.13**.
- `npm install @oribos/core zod @ai-sdk/openai` — the model provider package (any AI SDK provider)
  and the schema library (zod@4, or any Standard Schema implementation) are the user's pick; the
  core itself has no dependencies.

## Import map

| Import path | What it gives |
| --- | --- |
| `@oribos/core` | `createApp` — the optional composition root |
| `@oribos/core/agent` | `Agent`, dynamic arguments, structured output, processors |
| `@oribos/core/model` | the model contract and chunk protocol types |
| `@oribos/core/tools` | `createTool` and the tool types |
| `@oribos/core/memory` | `Memory`, `createInMemoryStore`, the memory storage ports |
| `@oribos/core/workflows` | `createWorkflow`, `createStep`, snapshot store, `restart` (time-travel) |
| `@oribos/core/observability` | `createTracer`, console / memory exporters, span types |
| `@oribos/core/signals` | `createSignals` — inject / wake / queue on a thread |
| `@oribos/core/durable-agent` | `createDurableAgent`, the approval gate, `AgentRunSnapshotStore` |
| `@oribos/core/schedules` | `createSchedules`, `tick`, `ScheduleStore` |

Capability packages — separate installs, they carry the external dependencies:

| Package | What it gives |
| --- | --- |
| `@oribos/otlp` | OTLP exporter: Oribos spans mapped to GenAI semantic conventions |
| `@oribos/mcp-server` | a Tool container served over MCP (Streamable HTTP + stdio) |
| `@oribos/mcp-client` | a remote MCP server's tools bridged into the Tool container |
| `@oribos/sqlite` | the four storage ports over one SQLite file (`node:sqlite`) |
| `@oribos/ai-sdk` | the chunk stream as an AI SDK UI message stream (useChat routes) |
| `@oribos/croner` | cron expressions as the schedules `next` fragment |
| `@oribos/supervisor` | sub-agents as delegation tools — one `createSupervisor` factory, zero new core seams |
| `@oribos/evals` | scorers as plain `{ name, score }` objects — per-step via a processor, or a settled run scored after the fact |

## Core recipes

### Agent + tool + stream

```ts
import { openai } from '@ai-sdk/openai';
import { Agent } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import { z } from 'zod';

const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, celsius: 18 }),
});

const agent = new Agent({
  name: 'assistant',
  instructions: 'You are concise. Use the weather tool for weather questions.',
  model: openai.chat('gpt-4o-mini'),
  tools: { weather },
});

const result = agent.stream('What is the weather in Paris right now?');
for await (const chunk of result) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
}
const text = await result.text; // terminal values: text / object / usage / steps / finishReason
```

Facts to respect:

- A tool is a plain object via `createTool`: `description` + optional `inputSchema` / `outputSchema`
  (Standard Schema dual interfaces — zod@4 speaks them; the framework validates the model's
  arguments and sends JSON Schema to the provider) + `execute(input, ctx)`. **A tool has no name
  field** — its name is its key in the `tools` container record.
- `agent.generate(input)` is the same run collapsed to its terminal values — one code path with
  `stream()`, so the two always agree.
- The built-in loop executes tool calls and feeds results back (failures return as `isError`
  results the model can recover from), up to `maxSteps` (default 5).
- Every config field is a **dynamic argument**: `T | ((ctx: RequestContext) => T | Promise<T>)`.
  `RequestContext` carries `signal` and `runId` plus the caller's own per-call properties.
- Two additive run options extend a run without touching defaults: `toolExecution: 'eager'`
  starts each tool call once its arguments finish streaming (results still emitted in call
  order; mutually exclusive with the durable-agent approval gate), and
  `deltas: { reasoning?, toolInput? }` emits `reasoning-delta` / `tool-input-start` /
  `tool-input-delta` / `tool-input-end` frames — a consumer that ignores them sees the same run.
- Cross-cutting behavior (guardrails, redaction, rate limiting, evals) goes in `processors` —
  three hooks in declaration order: `processInput` / `processOutputStep` / `processError`.

### Memory

```ts
import { Memory, createInMemoryStore } from '@oribos/core/memory';

const memory = new Memory({ storage: createInMemoryStore() });
const agent = new Agent({ name, instructions, model, memory });

await agent.generate('Should I bring a rain jacket?', {
  memory: { thread: 'trip-lisbon', resource: 'user-42' },
});
```

- Message history is on by default: messages persist per thread, the recent window (`lastMessages`,
  default 10) is injected into the next prompt, and `memory.recall()` is the single query entry.
- **Identity is per call** — `memory: { thread, resource }`, passed to `generate` / `stream`, never
  on the agent and never defaulted. A missing thread record is created on first save; the identity
  fields themselves are required.
- Working memory (opt-in via schema): a small structured, resource-scoped record, injected as a
  system message, updated by the model through a framework-attached tool.
- Storage goes through the `MemoryStore` port with an in-memory default; `@oribos/sqlite` persists.

### Workflows

```ts
import { createStep, createWorkflow } from '@oribos/core/workflows';

const workflow = createWorkflow({ id: 'expense-approval', inputSchema, outputSchema })
  .foreach(checkItem, { concurrency: 2 })
  .parallel([policyCheck, budgetCheck])
  .branch([
    [(ctx) => ctx.inputData['budget-check'].budget === 'over', routeManager],
    [() => true, routeAuto],
  ])
  .then(draftMemo)      // a step whose execute calls an agent is how agents join a workflow
  .then(approvalGate)   // ctx.suspend() unwinds the run with a JSON snapshot
  .then(finalize)
  .commit();

const run = workflow.createRun({ runId: 'run-1' });
const out = run.start({ inputData: report });
const settled = await out.result; // { status: 'success' | 'suspended', … }

// later — even in another process, with a persistent snapshot store:
const outcome = await workflow
  .createRun({ runId: 'run-1' })
  .resume({ step: 'approval-gate', resumeData: { approved: true } });
```

- **Not a DAG**: the builder compiles to a flat entry list interpreted by a for-loop walker.
  `commit()` freezes the definition; `createRun()` executes it.
- Every boundary (start input, step input, resume data) is validated against its Standard Schema.
- `ctx.suspend()` exists **only inside a step's `execute`** — calling it in a branch or loop
  condition fails the run instead of suspending.
- `run.restart({ step? })` re-enters a snapshotted run: records at and after the chosen step are
  truncated and the walk re-enters in the same trace (time-travel); omitting the step restarts
  the whole run. Same load → re-enter primitive as `resume`, no resume data, no new ports.
- Snapshots are JSON-only, taken at step boundaries, through the `WorkflowSnapshotStore` port
  (in-memory default; `@oribos/sqlite` for cross-process resume).

### Durable agents (approval gate)

```ts
import { createDurableAgent } from '@oribos/core/durable-agent';

const durable = createDurableAgent({ agent, approval: { tools: ['issueRefund'] } });
const out = durable.stream('Please refund order A-4471.');
// out.finishReason === 'suspended' → out.suspendPayload says which tool call was held
await durable.resume(out.runId, { approved: true }); // …or false: the model replans
```

- **A bare agent never suspends** — `finishReason: 'suspended'` exists only through the durable
  wrapper (the stepBoundary seam).
- The approval declaration lives on the wrapper, never on the tool; loop snapshots go through the
  `AgentRunSnapshotStore` port (`load` / `save`, in-memory default).

### Signals

```ts
import { createSignals } from '@oribos/core/signals';

const signals = createSignals({ agent, memory });
```

The thread-directed interaction primitive: `sendMessage` injects user input into an active run or
wakes an idle thread into a new run, `queueMessage` queues in order, `sendSignal` carries typed
payloads, `subscribeToThread` watches a thread. Injected content lands in the message history.
**Single-process semantics** — cross-instance distribution is deliberately absent.

### Schedules (+ croner)

```ts
import { createSchedules } from '@oribos/core/schedules';

const schedules = createSchedules({ agents: { desk: agent }, signals });
await schedules.save({ id: 'morning-sweep', next: (from) => nextDailyAt(9, from), target: { … } });
await schedules.tick(); // list what is due → fire it → advance nextFireAt
```

- `tick` is the whole runtime: **no built-in polling loop** — a platform cron hitting an endpoint
  that calls `tick` is the first-class shape; `startTicker` is only an in-process convenience.
- Records hold no cron expression; the occurrence function `next(from) → Date | null` is injected.
  `@oribos/croner` builds `next` from a cron expression (parsing never enters the core).

### Observability

```ts
import { createApp } from '@oribos/core';
import { consoleExporter, createTracer } from '@oribos/core/observability';

const app = createApp({ tracer: createTracer({ exporters: [consoleExporter()] }) });
const agent = app.agent({ name, instructions, model, tools });
```

Oribos has its own minimal span model (**not OTel**): agent runs, model steps, tool calls, workflow
runs/steps, and memory recall/save are traced; console and memory exporters are built in, OTLP
(GenAI semantic conventions) ships as `@oribos/otlp`. The composition root is optional — a
standalone `new Agent({ … })` with no app and no tracer stays first-class, with zero span overhead.

### MCP

`@oribos/mcp-server` exposes a tool container over MCP (Streamable HTTP fetch handler + stdio);
`@oribos/mcp-client` bridges a remote MCP server's tools back into the same `Tool` shape
(Streamable HTTP + stdio). The same Tool flows both directions, schemas pass through unadapted.
See `examples/mcp-tools` for a full round-trip.

### AI SDK interop

`@oribos/ai-sdk` renders the agent's stream as an AI SDK UI message stream for useChat-compatible
routes. **Conversion happens only in this package** — the core stream speaks Oribos's own chunk
protocol (`text-delta` / `tool-call` / `finish` / `usage` / …). See `examples/ai-chat-route`.

### Multi-agent: as-tool composition

There is **no supervisor protocol and no sub-agent concept**. Wrap one agent into a tool and hang
it on another — delegation is an ordinary tool call:

```ts
import { resolveDynamicArgument, type Agent, type RequestContext } from '@oribos/core/agent';
import { createTool, type Tool } from '@oribos/core/tools';
import { z } from 'zod';

// The canonical wrapper: an agent's `description` + `generate` is already tool-shaped.
function asTool(agent: Agent): (ctx: RequestContext) => Promise<Tool<{ prompt: string }>> {
  return async (ctx) =>
    createTool({
      description: (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name,
      inputSchema: z.object({ prompt: z.string() }),
      execute: (input, { signal, traceId, spanId }) =>
        agent.generate(input.prompt, { signal, traceId, parentSpanId: spanId }),
    });
}

// Hang it in the parent's tools container via dynamic resolution:
// new Agent({ …, tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }) })
```

### Multi-agent: supervisor package

`@oribos/supervisor` packages the as-tool recipe — no supervisor protocol, no sub-agent concept
in the core:

```ts
import { createSupervisor } from '@oribos/supervisor';

const supervisor = createSupervisor({
  name: 'lead',
  instructions: 'Delegate research and drafting.',
  model,
  agents: { researcher, drafter }, // key = delegation tool name
  delegation: { maxSteps: 8 },    // optional: maxSteps / memory per delegation run
});
```

The result is a plain `Agent`. Each `agents` entry becomes a delegation tool (input is fixed
`{ prompt: string }`); a `stop` finish feeds the sub-run's text back bare, any other finish
reason feeds `{ text, finishReason }` so truncation / suspension is visible to the parent model.
Key collisions with the supervisor's own `tools` fail the run at tools resolution.

### Evals: scorers

`@oribos/evals` — a scorer is a plain object `{ name, score(target) }` returning
`{ value: number, reason?: string }`. Two consumption points:

```ts
import { createScorerProcessor, scoreRun } from '@oribos/evals';

const agent = new Agent({ …, processors: [createScorerProcessor({ scorers, onScore })] }); // per-step
const outcomes = await scoreRun(result, runScorers); // after the fact, terminal values only
```

`createScorerProcessor` is observe-only (no rewrite; a scorer failure lands as an `ok: false`
outcome and never voids the run); `scoreRun` scores a settled run through its public terminal
surface — the same entry for `generate` return values and `stream` output objects.

## Deliberately absent — do not scaffold these

Oribos cuts these on purpose (rationale lives in `docs/ROADMAP.md`'s deferred list and each
subsystem spec's cut table). **Do not invent APIs for them:**

- `.network()` and supervisor *protocols* — delegation is as-tool composition, or
  `@oribos/supervisor`'s packaged form (no wire protocol, no sub-agent concept in the core).
- DAG workflow execution — workflows are a flat entry list + for-loop walker.
- Model registries and provider magic strings — model instances come from AI SDK provider packages.
- A built-in polling scheduler — `tick` is the runtime; the platform's cron drives it.
- Resumable streams, crash auto-recovery, per-step checkpointing — time-travel / whole-run
  restart **exists** (`run.restart({ step? })`); reconnectable streams and crash replay do not.
- Vector recall / RAG, background memory compression pipelines — catch-up items not yet landed;
  do not scaffold them as if they existed.
- Evals *in the core* — scorers live in `@oribos/evals`; `processors` is the only core seam.
- OTel-native spans or metrics/logs signals in the core — the span model is Oribos's own; OTel
  mapping lives in `@oribos/otlp`.
- Dependencies added to `@oribos/core` — external dependencies live in capability packages.

## When something looks wrong

1. Read the subsystem spec in `docs/architecture/` (agent / model / tools / memory / workflows /
   observability / storage / harness) — it is the truth source; `CONTEXT.md` defines every domain
   term once.
2. Run the matching example under `examples/` — each is self-asserting and works against any
   OpenAI-compatible endpoint.
3. The docs site mirrors the concepts at `https://docs.oribos.dev` (machine index: `/llms.txt`).
