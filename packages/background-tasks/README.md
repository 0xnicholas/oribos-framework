# @oribos/background-tasks

Application-owned background work, coordinated as task rows — the background-tasks capability
package. Phase one of background tasks is a
[recipe](https://github.com/0xnicholas/oribos-framework/tree/main/examples/background-tasks) and
stays one; this package is the phase-two opt-in manager: you submit a handler, a lease decides who
runs it, and the settle comes back to you. It is not wired into anything unless you wire it — the
core is untouched (there is no core here at all: the types are self-contained, no `@oribos/core`
peer), and with no `heartbeatMs` configured the package holds zero timers.

```ts
import { createBackgroundTasks } from '@oribos/background-tasks';

const tasks = createBackgroundTasks({
  onSettle: (record) => {
    // The settled record is your protocol: route it — e.g. `sendSignal` it to its thread.
  },
});

const record = await tasks.submit({
  payload: { kind: 'revenue' },
  run: async (payload) => ({ url: `https://reports.example/${payload.kind}` }),
});
// record.status === 'accepted' — the handler runs in-process; the row flips running → done.

await tasks.untilIdle(); // resolves when every task this manager holds has settled
await tasks.get(record.id); // the row: status, result, attempt, settledAt
await tasks.adopt(); // the orphan sweep: rows still running whose lease is free
```

## How it works

- **Rows.** `submit` writes a `TaskRecord` — `{ id, status, payload, result?, error?, attempt,
  createdAt, settledAt? }`, JSON-only — through a `TaskStore`. `createInMemoryTaskStore()` is the
  zero-dependency default (deep-copied at the boundary); persistence is the deployment's to write.
- **The lease decides.** A row executes only under its lease: `submit` acquires, the row flips
  `running`, the handler runs, the settle releases. The port is `acquire(key, ttlMs) → LeaseHandle | null`
  with `{ token, renew, release }` — the shared mechanism from the zero-external-dependency
  [`@oribos/lease`](https://www.npmjs.com/package/@oribos/lease) leaf package (ADR-0020),
  re-exported here as `TaskLease`; `@oribos/distributed-signals`' `SignalLease` is the same
  port. `createInMemoryLeaseStore()` is the default; `createRedisLease({ client })` rides the
  `set(NX/PX)` / `eval` structural subset.
- **The settle.** `done` (`result`) or `failed` (`error` message) is written back, the lease is
  released, and `onSettle(record)` is awaited — the join to your own reactions, the phase-one
  recipe in one line: map the record to its thread and `sendSignal`.
- **The orphan sweep.** `adopt()` re-runs rows still `running` whose lease this process can take —
  `attempt` + 1, at-least-once, idempotency the application's (the `@oribos/checkpoints` `recover`
  caliber). A row whose lease is still held, or for which this process holds no handler, is left
  alone: v1 executes handlers in-process, so adopting across a restart is app-level hand-off, not
  this call.
- **`untilIdle()`.** A package-level wait: resolves when every task this manager is holding has
  settled (idle resolves at once). It does not touch the agent's stream.
- **Heartbeat.** Configured `heartbeatMs`: a renewal interval runs while a handler executes, and
  the acquire/renew TTL is `3 × heartbeatMs` (the documented expiry window: two missed beats).
  Absent: zero timers — the TTL is a fixed 30 s, so handlers that may run longer configure it.

## The documented windows and v1 refusals

- A handler that outlives its lease (no heartbeat: past 30 s) can be taken over by an `adopt()`
  racer — at-least-once by design; make handlers idempotent, and use `attempt` to see re-runs.
- v1 refuses: retry / backoff policy (the deployment's), priorities and concurrency control,
  resident workers / cross-process handler execution, structured result storage beyond the JSON
  payload, and any overlap with cron / schedules.

## The example

[`examples/background-tasks`](https://github.com/0xnicholas/oribos-framework/tree/main/examples/background-tasks)
runs five acts offline: the phase-one recipe verbatim (tool acks, own worker reports, framework
holds nothing), then the manager driving the same recipe (`onSettle` → `sendSignal`) and an orphan
adopted and re-run. It is wired into the repo's example gate.
