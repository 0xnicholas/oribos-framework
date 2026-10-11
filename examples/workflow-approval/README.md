# workflow-approval

Oribos's workflow engine in one scripted session: an **operator-built definition frozen into a flat
entry list**, a **for-loop walker** interpreting it, an **agent wrapped into a step**, and an
**approval gate** where the run suspends into a JSON snapshot and a fresh run object resumes the
walk. Oribos is a TypeScript agent framework — zero runtime dependencies — compose only what you
use, run anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input. It drives
one workflow over a real OpenAI model and walks three acts:

1. **Start — the front runs, the memo is drafted, the gate suspends.** A `foreach` checks the line
   items against the per-item cap through a concurrency gate, a `parallel` runs the policy and
   budget audits at once, a `branch` picks the review lane, and a hand-written one-line agent step
   drafts the approval memo. The gate step then calls `suspend({ question, memo })`: the run unwinds
   at that entry, the envelope lands `suspended`, and the engine writes its snapshot. The act
   consumes the run's lifecycle event stream (`for await`) *and* its settled envelope
   (`await out.result`) from the same execution.
2. **The snapshot — what a resume needs.** A snapshot store is a port: any object with `load` /
   `save`. The example decorates the core's in-memory default with a write log, so the engine's
   fixed persistence moments are visible (one `running` snapshot per completed entry, one
   `suspended` on the signal) next to the persisted `{ runId, status, input, stepResults, position }`
   — the validated start input, the per-entry records, and the position a resume re-enters from.
3. **Resume — a fresh run object continues the walk.** `workflow.createRun({ runId })` over the same
   store loads the snapshot, validates `resumeData` against the gate's `resumeSchema`, and re-enters
   the walk at the recorded position: the gate re-executes with the reviewer's decision, the final
   entry runs, and the workflow returns its receipt. Nothing from the starting run object is needed
   — the store holds the whole state. Swap the in-memory store for a persistent adapter and this is
   the cross-process story.

## Observability

One tracer is assembled in the script: the workflow takes it through `createWorkflow({ tracer })`
and the agent gets the same instance through the composition root. The console exporter prints every
span event, so while it runs expect:

- one `workflow-run` span per segment — the start segment and the resumed one — with attributes
  `workflowId` / `runId`, input = the validated trigger input and output = the outcome envelope. The
  resumed segment opens a **new run span in the same trace**: the snapshot carries the `traceId`, so
  a suspension does not break the observation tree;
- one `workflow-step` span per step *execution*, named by step id and parented under that segment's
  run span — a `foreach` iteration and a `parallel` arm each get their own span, while the run's
  records stay aggregated per entry;
- the `agent-run` / `agent-step` spans of the memo call. The agent call inside a step opens its own
  trace: cross-subsystem trace propagation is not part of the workflow engine.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-workflow-approval start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-workflow-approval start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one.

Expected output: the flat entry list, the console exporter's `[oribos] span_started / …` lines, one
`[event] …` line per lifecycle event, the write log and the loaded snapshot, and finally the
receipt:

```json
{
  "decision": "approved",
  "memo": "…",
  "total": 2150,
  "note": "Approved — the hotel rate is within the offsite allowance."
}
```

## Notes

- The script **asserts its own payoff**: a run that does not suspend at the gate, an empty memo from
  the model, or a resume that does not reach the receipt exits non-zero instead of printing a happy
  face.
- **The agent wrapper is hand-written by design** (the definition surface offers no shorthand): there
  is no `createStep(agent)` overload — a step that calls the agent is a `createStep` whose
  `execute` returns what the model produced.
- **Events are the execution view, records are the entry view**: a `foreach` iteration or a
  `parallel` arm crosses its step's boundary once per execution (`step-start` / `step-end`, one span
  each), while `stepResults` aggregates by entry — a block is one record. See the lifecycle event
  stream.
- **Suspending from inside a block is an explicit v1 cut**: calling `suspend()` in a `parallel` arm,
  a `branch` arm or a `foreach` body fails the run; the gate lives on the top-level `then` axis for
  that reason.
- **`dowhile` / `dountil` / `sleep`** don't appear in this narrative — the example walks `then` /
  `foreach` / `parallel` / `branch`, and the loop and wait operators are exercised by the core's
  test suite. The definition surface's v1 kill-list — the operators deliberately cut, like nested
  workflows or a `state` blackboard — and the seam that carries each cut are design decisions, not
  example choices.
- Like the other examples, the script consumes `@oribos/core` through its built package exports — run
  `pnpm build` before `start`.
