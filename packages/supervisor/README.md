# `@oribos/supervisor`

Supervisor composition for [Oribos](https://github.com/0xnicholas/oribos-framework): one
`createSupervisor()` call turns sub-agents into delegation tools on a parent agent — the
[as-tool composition](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/agent.md)
standardized as a factory. The supervisor it returns is a plain `Agent`; delegation is an ordinary
tool call; the core gains no seam.

```ts
import { Agent } from '@oribos/core/agent';
import { createSupervisor } from '@oribos/supervisor';

const researcher = new Agent({
  name: 'researcher',
  instructions: 'You are a researcher. Answer in one sentence.',
  model: openai.chat('gpt-4o-mini'),
  description: 'Researches questions and returns findings.', // what the parent's model reads
});

const desk = createSupervisor({
  name: 'desk',
  instructions: 'Delegate research to `researcher`, then answer.',
  model: openai.chat('gpt-4o-mini'),
  agents: { researcher }, // record key = the delegation tool's name
});

const result = await desk.generate('What is Oribos?');
```

- Spec: [`docs/architecture/agent.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/agent.md)「多 agent 组合」
- Decisions: [ADR-0012](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0012-multi-agent-collaboration.md) (as-tool as the only canonical form; the evolution gate this package lands from); [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)
- Example: [`examples/agent-supervisor`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/agent-supervisor) — delegation, ordering, one trace, visible truncation

## Install

```bash
npm install @oribos/supervisor @oribos/core
```

The package depends on nothing. `@oribos/core` is a **peer** (`workspace:^`): the supervisor is
built from the core's public surface (`Agent`, `createTool`, `resolveDynamicArgument`), so the core
stays the single instance the host application owns.

## The delegation contract

- **One tool per `agents` entry.** The record key is the tool's name; the description is the
  sub-agent's `description` resolved per parent run (dynamic arguments included), falling back to
  the sub-agent's `name`. The supervisor's own `tools` merge alongside; a key collision fails the
  run at tools resolution, naming the key.
- **Input is `{ prompt: string }`, nothing else.** The wrapper constructs the delegated input
  explicitly — zero parent-context passthrough. The schema is a hand-written Standard Schema dual
  interface, so the package carries no schema-library dependency.
- **Results come back shaped.** A sub-run that finishes `'stop'` feeds back its terminal text as a
  bare string; any other finish (`'tool-calls'` / `'length'` / `'suspended'`) feeds back
  `{ text, finishReason }`, so a truncated or suspended delegation is visible to the parent model
  instead of reading as a complete answer. A *failing* sub-agent throws inside `execute`, which the
  loop frames as an ordinary error tool result (`Tool 'researcher' failed: …`) — the parent run
  continues and its model replans.
- **Cancellation and tracing cross the boundary as one line each.** `signal`, `traceId` and
  `parentSpanId` pass straight from the tool context into the delegated run: aborting the parent
  aborts the child, and the child's `agent-run` span hangs under the parent's `tool-call` span in
  the same trace. A parent without a trace hands empty strings down — not a valid parent — so the
  child starts its own fresh trace instead of producing broken spans.
- **Delegation is stateless by default.** `delegation: { memory: { thread, resource } }` opts every
  delegation run into the sub-agent's `Memory`; the function form —
  `(input, toolCtx) => ({ thread, resource })` — derives the identity per call. The thread policy
  (new thread per delegation, one per caller, …) stays the application's.
- **`delegation: { maxSteps }` caps each delegation run** (absent = the core default 5). The cap
  is validated at the `createSupervisor` call site.
- **The supervisor is a real `Agent`** — it streams, takes run options, composes as a tool itself
  (a supervisor of supervisors), and accepts the durable wrapper like any other agent. Nested
  approval gates stay out of scope per ADR-0012: gates hang on the outermost entry agent only.
