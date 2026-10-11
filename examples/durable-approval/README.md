# durable-approval

Oribos's durable agent in one scripted session: a **tool call that needs a human** is held at the
loop's step boundary, the run's **loop snapshot** goes to an `AgentRunSnapshotStore`, the run lands
`finishReason: 'suspended'`, and `resume(runId, { approved })` continues it — executing the held
call, or answering it with a rejection result the model replans from. Oribos is a TypeScript
agent framework with zero runtime dependencies — compose only what you use, run anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input. It drives
one refund desk over a real OpenAI model and walks five acts:

1. **Run A suspends.** The customer asks for a $129 refund; the model calls `issueRefund`, whose name
   is on the wrapper's approval list (`createDurableAgent({ approval: { tools: [...] } })`). The call
   does **not** execute: the run's loop snapshot is written, `finishReason` settles `'suspended'`,
   and `suspendPayload` reports the held calls and the ids the decision governs. The refund ledger is
   still empty — the gate held.
2. **The snapshot.** A snapshot store is a port: any object with `load` / `save`, JSON-only. The
   example decorates the core's in-memory default with a write log, so the durable ritual is visible:
   one `suspended` snapshot per suspension, and nothing else (the shape has no terminal status — a
   consumed snapshot is the application's to drop). The loaded snapshot is the state a resume
   re-enters from: the message list the run stopped at (the prompt plus the model's own tool-calling
   turn), the step count, the held calls, and the `traceId` the run was exported under.
3. **Resume, approved.** `resume(runId, { approved: true })` loads the snapshot and continues the
   run: the held call is replayed as the run's first step — no model round trip re-deriving it — the
   tool executes (the ledger gets its entry) and the run finishes on the model's report. The resumed
   segment opens a fresh `agent-run` span in the *same* trace, so one human interaction stays one
   trace.
4. **Run B suspends.** A second request, same gate, same shape.
5. **Resume, rejected.** `{ approved: false }` executes nothing: the held call is answered with a
   rejection tool result — fed back exactly like a tool failure — and the model replans around it.
   A refusal does not terminate the run, and the ledger is untouched.

## Observability

One tracer is assembled in the script and distributed by the composition root: the agent gets it
through `app.agent({...})`, the durable wrapper's snapshot store through the `storage.durableAgent`
slot. The console exporter prints every span event, so while it runs expect:

- one `agent-run` span per segment — the suspended one and the resumed one. **Suspension is a normal
  end** under an attribute, not an error: `attributes.status = 'suspended'`. The resumed segment
  opens a new `agent-run` span in the **same trace** (the snapshot carries the `traceId`), so a
  suspension does not break the observation tree;
- one `agent-step` span per model call and one `tool-call` span per tool execution. The replayed step
  makes no model call — its output already streamed in the suspended run — and a **rejected call
  produces no tool-call span**: nothing ran;
- the `memory-*` spans do not appear: this example keeps the desk stateless (a durable run's memory
  identity is a run option, not part of the snapshot — see the notes).

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-durable-approval start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-durable-approval start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one. Expected output: the two runs'
chunk lines, the store's write log and the loaded snapshot, the span lines, and finally the desk's
two replies — the approved refund confirmed, the rejected one answered with an alternative.

## Notes

- The script **asserts its own payoff**: a run that does not suspend, money that moves while a run is
  suspended, a resume that does not reach `'stop'`, or a rejection that executes exits non-zero
  instead of printing a happy face.
- **The approval list lives on the wrapper, never on the tool**: a tool's four fields carry no
  permission, and `resume` reads the wrapper's list. A bare
  `agent.generate(...)` — no wrapper — never suspends and keeps no snapshot; the durable semantics
  exist in `createDurableAgent` alone.
- **`resume` re-supplies the run options, not the state.** The message list, the suspension point and
  the trace come from the snapshot; everything else the continued segment should keep — `maxSteps`,
  `memory`, `signal`, `stepBoundary` — is passed again here, because the snapshot is JSON-only run
  *state*, not a run configuration. A suspended run whose `maxSteps` is not re-supplied continues
  under the default.
- **A snapshot is not deleted by resuming.** The port has two methods, no CAS and no lifecycle: the
  application owns whether a consumed snapshot is dropped, and where a durable store is used across
  processes. Listing suspended runs (`listSuspended`) is an optional adapter extension, not core.
- **A second suspension overwrites the same `runId`** — a run that suspends again (another gated
  call) is resumable under the id it always had. This narrative does not stage that; the core's test
  suite does.
- Like the other examples, the script consumes `@oribos/core` through its built package exports — run
  `pnpm build` before `start`.
