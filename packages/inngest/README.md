# `@oribos/inngest`

Durable execution for [Oribos](https://github.com/0xnicholas/oribos-framework) workflows, powered
by [Inngest](https://www.inngest.com/): workflow `start` / `resume` become trigger events, a
process that dies mid-run is continued by the engine's retry, and the run's state stays exactly
where it always was — in your snapshot store.

```ts
import { Inngest } from 'inngest';
import { createWorkflow } from '@oribos/core/workflows';
import { createInngestRunner } from '@oribos/inngest';

const inngest = new Inngest({ id: 'my-app' });
const store = mySnapshotStore; // the same store the workflow attaches

const publish = createWorkflow({ id: 'publish', inputSchema, outputSchema, storage: store })
  .then(draft)
  .then(approve) // suspends here when approval is pending
  .then(polish)
  .commit();

const runner = createInngestRunner({ client: inngest, store });

// Serve the two trigger functions on your endpoint, next to your own functions:
export const functions = [...serve({ client: inngest, functions: runner.functions })];

// Trigger from anywhere (an HTTP handler, a webhook):
const runId = await runner.start(publish, { topic: 'hello' });

// Answer a suspension:
await runner.resume(runId, { approved: true });
```

- Spec: [`docs/architecture/workflows.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/workflows.md) (the CUT-W9 row)
- Decisions: [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging); the design ticket that froze this surface ([oribos-framework#188](https://github.com/0xnicholas/oribos-framework/issues/188))
- Example: [`examples/inngest`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/inngest) — the trigger → suspend → resume → crash-retry chain, offline

## Install

```bash
npm install @oribos/inngest
```

The wrapper depends on `inngest`, pinned exactly (`inngest@4.24.0`, GSL-3.0 — the croner
precedent for an external engine pin), plus a `@oribos/core` peer.

## Trigger-level delegation

The division of labor is deliberate: **the walker and the snapshot store never leave your
process.** You author the workflow exactly as always (`createWorkflow({ storage })` — there is no
second authoring entry), and hand the same snapshot store to the runner. What crosses to Inngest
is only the trigger:

- `start(run, input)` sends a start event; the start function runs the workflow in process and
  its outcome lands in the snapshot store (`success` / `suspended`, or `failed` — the trigger
  surfaces the failure, and the snapshot carries it).
- A suspension writes its snapshot as ever and the function simply ends. `resume(runId, payload?)`
  sends a resume event; the resume function loads the suspended snapshot, validates the payload
  against the suspended step's `resumeSchema`, and re-enters.
- A process that dies mid-run leaves a `running` snapshot. The engine retries the trigger, and the
  retry recognizes the snapshot: completed entries replay from their records, the in-flight entry
  re-executes — the same idempotency-cost stance as `@oribos/checkpoints`, made explicit.
- `recover()` is the boot-time sweep over the same snapshots: re-enter mid-flight runs, leave
  suspended runs to their answers, report what the current process cannot continue.

The snapshot remains the state truth. The runner deliberately does not use Inngest's step
tooling for the run's own state — the framework's snapshots already are that, twice over.

## Registration

Workflow definitions are process-resident code, so a trigger event can only be served where its
workflow was registered: `start(run, input)` registers the definition (idempotently) before
sending the trigger. The run → workflow binding is persisted through the snapshot store (one
reserved record — the port is JSON-only with no listing), so `resume` and `recover()` work across
restarts. A trigger arriving before its definition is registered (a retry racing a cold boot)
fails loudly and rides the engine's retry backoff until the owning process is warm.

The start trigger carries a deterministic event id (`oribos-start-<runId>`), so Inngest's event
idempotency deduplicates a redelivered start of the same run — one run can never start twice.

## Typed rejections

Three things are deliberately not exposed (frozen at the design ticket):

- **No durable sleep** — `.sleep()` stays an in-process wait; durable delays belong to the engine.
- **No workflow cron / scheduling** — `ScheduleStore` only takes agents and signals.
- **No real-time stream following** — that is `@oribos/resumable-stream` /
  `@oribos/distributed-signals` territory.

## Axis notes

Opt-in: install and wire it, or the package is not in your tree and core never mentions it. Zero
cost unconfigured: no core seam, no hook, no ambient behavior. No resident pipeline: the runner
creates no timers and no polls — everything is trigger- or call-driven.
