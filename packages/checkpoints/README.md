# @oribos/checkpoints

Crash-safe agent runs — the checkpoints capability package. Every step that continues a run
writes a checkpoint to a store you own, and `recover(runId)` / `recoverAll()` replay runs whose
process died from their last completed step. Completed steps' model calls are never re-sent, and
the replay rides the core's existing resume path — no core changes, no resident loop:

```ts
import { createCheckpointedAgent } from '@oribos/checkpoints';
import { createSqlCheckpointStore } from './store'; // your durable store (the port's four methods)

const cp = createCheckpointedAgent({ agent, storage: createSqlCheckpointStore() });

// Serve a run: the same output object `agent.stream` returns, plus the run id.
const output = cp.stream(input);
for await (const chunk of output) response.write(sse(chunk));

// Boot: every run whose process died is replayed from its last checkpoint.
const results = await cp.recoverAll(memory === undefined ? {} : { memory });
for (const result of results) {
  if (result.ok) console.log(`recovered ${result.runId}: ${result.outcome.finishReason}`);
  else console.error(`recovery failed for ${result.runId}:`, result.error);
}
```

## How it works

- **`createCheckpointedAgent({ agent, storage? })`** wires the core's published step boundary
  (`stepBoundary.beforeToolCalls`): every step that continues a run — the model's calls are known,
  none has executed — writes one checkpoint (the prompt plus that step's assistant message, the
  step count, the held calls, the trace) to the store. The run clears its checkpoint as it settles
  (success, failure or suspension — any settled run is not a crash); a checkpoint that remains is
  the residue of a run whose process died mid-flight.
- **`recover(runId, options?)`** replays that residue through the core's shared continuation seam
  (`@oribos/core/agent-run`): the checkpoint maps onto a `RunContinuation` record, `continueRun`
  builds the resumed input, the `AgentRunResume` seed and the trace continuation, then drains the
  segment. The recorded prompt already ends with the step's own assistant message and the held
  calls ride the seed, so the replayed step makes no model call — its output came from the
  checkpoint — its tool calls execute, and the run continues exactly where it stopped. Recovery
  dedup uses the same seam's `createResumeLock` (one registry for this package). The run's shape
  (`maxSteps`, `memory`, …) is not persisted with the checkpoint: pass it again, like the durable
  wrapper's `resume`.
- **`recoverAll(options?)`** is the boot sweep: every checkpoint the store holds, replayed in list
  order, one entry per run (a failed replay is that entry's `ok: false` — the sweep goes on). Boot
  recovery is a function call, not a daemon.

## Costs (explicit, by spec — `docs/architecture/harness.md` CUT-H1)

- Recovery re-sends the one model call that was in flight at the crash. Every completed step's
  calls are already answered in the checkpoint's message list and are never re-asked.
- The last checkpointed step's tool calls execute again on the replay: **tool side effects must be
  idempotent** — the tool's framework-provided `toolCallId` is the idempotency key. That contract
  is the application's; no package can enforce it.
- The clear is bookkeeping that follows the run's settle: a caller acting on a run's terminal
  values may find its own checkpoint briefly still in the store. A store that refuses the clear
  leaves a stale checkpoint behind (recovery from a finished run duplicates its tail) — the
  store's own failures are the deployment's to observe.

## The store port

- **`createInMemoryAgentRunCheckpointStore()`** — the default: a Map, zero dependencies, deep
  copies in and out, this process only. It cannot survive a real crash; it exists so the shape can
  be tried and tested.
- **`AgentRunCheckpointStore`** — four methods (`save` / `load` / `delete` / `list`) over
  JSON-only records. The deployment's durable store (a SQL table, Redis, object storage) is the
  half that makes crash recovery real, and all four methods are required: the clear keeps finished
  runs out of the next boot's sweep, and `list` is the sweep's discovery.

Zero cost when unconfigured: without the wrapper, the core's run path is untouched. No resident
pipeline: recovery happens inside the call that asks for it.

Cross-process discipline: call `recoverAll` at boot, before new runs start. A store shared by
several processes is swept by each of them unless the deployment gates it (leader election, a
lock) — no CAS ships here (the durable snapshot store's stance), and a run live in another process
looks exactly like a dead one through this store. The boot framing is what makes that benign.

See `examples/crash-replay` for the crash story as a runnable script — a worker process is killed
mid-run, the next process boots, sweeps, and replays it (wired into the repo's offline examples
gate).
