# signals-desk

Oribos's signals subsystem in one scripted session: one support **thread** that everything lands in —
a customer message that wakes an idle run, a message **injected** into the run while it is live, two
queued messages that keep their order, a typed **system signal**, and a **scheduled trigger** fired
by the schedules primitive. Oribos is a TypeScript agent framework — zero runtime dependencies —
compose only what you use, run anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input. It drives a
small shop's support desk over a real OpenAI model and walks five acts:

1. **An idle thread: `sendMessage` wakes a run.** The subscription is attached *before* the first run
   exists — `subscribeToThread` has no replay — and every chunk of every run on the thread flows
   through it, the stream a UI would forward.
2. **The run is live: `sendMessage` injects it (effective at the next step).** The desk pages its
   supervisor and waits; the script plays the supervisor, so the run is *parked mid-tool* when the
   message arrives.
   No new run starts: the message lands at the loop's next step boundary — at the tail of the run's
   next model call — and in message history as an ordinary message.
3. **`queueMessage` keeps the order.** Two messages sent during that window wait for the live run to
   end, then land as the input of **one** continuation run, in arrival order.
4. **`sendSignal` injects a typed payload.** Rendered as one `[signal] {…}` user message — the
   receiver's protocol, not the core's — landing in the prompt and in history, waking the idle thread.
5. **Schedules fire into the same thread.** A record pairs a threaded target with an **injected
   `next` occurrence function** (cron parsing never enters the core); `tick` reads what is due, sends
   the signal, and advances `nextFireAt`. A tick before the due instant is a no-op.

## The parked window

"Live = injected into the current run" can only be demonstrated while a run really is live, and a
script cannot race a fast model for that window. So the desk's `pageSupervisor` tool parks on a
promise the script controls: the script holds the page, sends the message, then answers the page. In
a real deployment the same window is a downstream call's latency — the example just makes it a fact
instead of a race.
A page nobody is holding is answered by a standing reply, so a model that pages at an unexpected
moment never wedges the script.

## Observability

One tracer is assembled in the script and distributed by the composition root (`createApp`), so the
agent, the signals facade and the schedule triggers all report to the same exporter. The console
exporter prints every span event, so while it runs expect:

- one `agent-run` span per run — a wake, an injection, a queued continuation and a scheduled trigger
  each end in their own; a woken run has no output object to await, so its span *is* how a script
  watches it (`output` carries the run's terminal text);
- one `agent-step` span per model call, with the **exact prompt** as its `input` — that is where the
  injected message and the rendered `[signal] {…}` are visible, at the tail of the call they land in;
- one `isEvent` span of type `signal` per injection, hung off the live run's `agent-run` span (the
  harness anchor: no new span type constant, no loop change);
- a **scheduled trigger opens no span of its own** — `tick` is an in-process primitive; the run it
  wakes carries its own `agent-run` span.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-signals-desk start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-signals-desk start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one. Expected output: the acts, one
line per chunk the subscription forwarded, the thread's history after the injection, after the queue
and at the end, and the schedule record advancing from one 09:00 UTC to the next.

## Notes

- The script **asserts its own payoff**: a signal that woke a second run instead of injecting, an
  injected message that never reached a model call, queued messages that arrived out of order or in
  two continuations, a tick that fired early or failed to advance its record — each exits non-zero
  instead of printing a happy face.
- **A message's history position is its arrival order, not the conversation's.** An injection is
  saved when it is delivered, while a run's own input messages are saved with its first step's record
  — so a message injected mid-step appears in history *before* the input of the run it was injected
  into. The model's *prompt* is unaffected: the injection is appended at the tail of the next call.
- **Single-process semantics, by design.** The thread → live run registry, the injection buffers and
  the queues live in the process: dying drops them (documented). Cross-instance signals (shared
  PubSub + leases) are a capability package, not core. For schedules, the equivalent story is the
  platform cron: `tick` is the primitive, `startTicker({ intervalMs })` the optional in-process
  convenience this example does not need (it calls `tick({ now })` explicitly, so the demo is
  deterministic on any machine).
- **`memory` is what makes a thread a thread.** Signals needs the same `Memory` instance on both
  sides — the app distributes its shared one to an agent it built itself — and woken runs carry their
  thread identity as the per-call `memory` option, so they recall and save history themselves. With
  no memory, waking starts a history-free run (documented), and injections are not persisted.
- **The script waits on the run spans**, not on timers: a woken run has no handle, so the acts wait
  for `agent-run` spans to end and for the thread to be released before starting the next run. The
  waits are guarded — a model that never calls `pageSupervisor` fails the act loudly instead of
  hanging.
- Like the other examples, the script consumes `@oribos/core` through its built package exports — run
  `pnpm build` before `start`.
