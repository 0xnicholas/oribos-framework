# background-tasks

Background tasks as a recipe, not a subsystem: a tool that **acks now**, an application-owned
worker that finishes the job out-of-band, and **one `sendSignal`** that reports the result back to
the thread the run carried. The run ends on the ack — the core's completion semantics never wait
for the work — and between an ack and its signal the framework holds nothing resident: the
application's own worker is the entire background. Acts 4–5 keep the same shape but let
[`@oribos/background-tasks`](https://www.npmjs.com/package/@oribos/background-tasks) drive it: the
opt-in manager, task rows, a lease — still in a package you install, still never in the core.
Oribos is a TypeScript agent framework with zero runtime dependencies — compose only what you
use, run anywhere.

The example is a single file (`src/index.ts`) with a scripted model stub — **no API key and no
network** (`setTimeout` plays the worker's — and the manager handler's — latency). Five acts:

1. **Ack now, report later.** The desk starts a revenue report; the tool returns
   `{ taskId: 'r-1', status: 'accepted' }` immediately and the run ends while the work is still
   running. When the worker finishes, one `sendSignal` wakes the idle thread with the rendered
   `[signal] {…}` message, and the woken run reports the finished report's URL.
2. **Failure reports through the same door.** A job that fails out-of-band signals
   `{ type: 'report-failed', error }` — the thread wakes the same way and the desk tells the
   customer why, instead of the failure masquerading as success or vanishing.
3. **The framework holds nothing.** The worker is stopped and a third report acks into a job table
   nobody is working: no run wakes, no model call happens. The only things left in the process are
   the application's own job rows (and, normally, their timers).
4. **The manager drives the same recipe.** `runManagedReport` submits through
   `createBackgroundTasks`: the row is written `accepted`, the lease takes it, the handler runs
   in-process, and the settle lands in `onSettle` — which makes the one `sendSignal` that wakes
   the thread. Same three pieces, package-driven instead of hand-wired.
5. **An orphan is adopted.** A churn report's first attempt dies in flight (a promise that never
   settles stands in for the process that died mid-job) — the row stays `running` with its lease
   un-renewed. The script ages the lease past its window and calls `adopt()`: `attempt` becomes 2,
   the handler runs again to completion, and the signal posts the report. At-least-once, by
   design — idempotency is the handler's own business.

## The recipe

Three pieces, all application code:

- **The tool acks, the work is yours.** The tool's `execute` registers the job with your worker
  and returns a task id in the same breath; the loop's next model call composes on that ack and
  the run ends. Whatever "background" means for you — a timer, a queue consumer, another process —
  it is your code, not the framework's. That is what keeps the core free of resident machinery
  (and what the deferred `untilIdle` semantics would have changed; ADR-0011 judged this
  combination equivalent).
- **The thread rides the request context.** A tool's `ctx` does not carry the run's memory
  identity, so the run is started with `replyTo` — the same thread target every signal method
  takes — on its open request-context bag, and the tool reads it back to route the report. The bag
  is per-run, so one tool serves every thread. (Runs the signals facade wakes itself don't carry
  your bag — if a woken run must spawn jobs too, put the target in the signal payload or keep
  chaining on runs you start.)
- **Completion is one `sendSignal`.** Success and failure go through the same door:
  `{ type: 'report-completed', taskId, … }` or `{ type: 'report-failed', taskId, error }`. The
  payload's shape is the receiver's protocol; the idle thread wakes with it in its prompt and in
  message history, like any message.

Hardening a real worker stays in the same shape: idempotency on the tool call (`ctx.toolCallId` is
the idempotency key for retried calls), real job persistence in your own store, retries and
dead-lettering in the worker. The manager covers the coordination acts as an opt-in package —
[`@oribos/background-tasks`](https://www.npmjs.com/package/@oribos/background-tasks): rows, the
lease, `heartbeatMs`, `adopt()`, `untilIdle()` (acts 4–5), never in the core — while retries /
backoff, priorities and cross-process handler execution stay outside even the package (its v1
refusals). The rest of the hardening stays yours.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-background-tasks start
```

Expected output: the ack run ending while the work is still running, both signals with their
rendered payloads and woken-run replies, the stopped worker's job row waking nothing, the
manager's settle landing in `onSettle`, and the adopted orphan re-running to completion
(`attempt 2`). The script **asserts its own payoff** — a run that waited for the work, a signal
that missed the woken run's prompt, a failure that masqueraded as success, a job nobody worked
that woke something, a dead attempt that reported anyway, or an adoption that did not re-run, each
exits non-zero instead of printing a happy face.
