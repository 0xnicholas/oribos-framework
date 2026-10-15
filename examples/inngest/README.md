# Oribos inngest example — trigger-level durable execution

Workflow `start` / `resume` ride [Inngest](https://www.inngest.com/) trigger events while the
walker and the snapshot store stay in process (`@oribos/inngest`). This example runs the whole
chain — **trigger → suspend → resume → crash retry → snapshot continuation** — offline through the
real SDK pathway, then documents the same loop against a real Inngest Dev Server.

## The offline chain (what `start` runs)

The example runs two stand-ins in place of the Dev Server's network halves, keeping the real SDK
everywhere else:

- a **local event bus** (`POST /e/<key>`) that records what `runner.start()` / `runner.resume()`
  send and answers the Inngest send shape — the Inngest client points at it via `baseUrl`;
- an **executor** that delivers each recorded event to a real `serve({ client, functions })`
  endpoint as an execution request (`POST /?fnId=<appId>-<fnId>`) — the exact request the Dev
  Server makes.

Against those, the acts are real end to end: the start function runs the workflow in process and
it suspends at the approval gate (the function ends normally; the snapshot carries the
suspension); `resume` re-enters from the snapshot with the answer (the completed step replays from
its record, never re-executes); a run abandoned mid-flight is a `running` snapshot and nothing
else, and `runner.recover()` sweeps the persisted registry, re-enters from the snapshot (the
completed entry replays once, the in-flight entry re-executes — the explicit idempotency cost),
and settles it out of the registry.

```bash
pnpm install && pnpm build
pnpm --filter @oribos/example-inngest start
```

The script self-asserts (`node:assert/strict`); a replayed step that re-executed, a lost
suspension, or a settled run still held by the registry exits 1.

## The real loop (manual verification against a Dev Server)

Swap the two stand-ins for the real halves — the workflows and the runner are unchanged:

```ts
// 1. A real client, no baseUrl override:
const inngest = new Inngest({ id: 'example-inngest' });

// 2. Serve the runner's functions on your endpoint (here: plain Node):
import { serve } from 'inngest/node';
http.createServer(serve({ client: inngest, functions: [...runner.functions] })).listen(3000);
```

Then, with [Inngest Dev Server](https://www.inngest.com/docs/local-development) running
(`npx inngest-cli@latest dev`):

1. `curl -X POST localhost:3000/start` on any endpoint of yours that calls
   `runner.start(publish, { topic: 'hello world' })` — the run appears in the Dev Server, executes
   to the approval gate, and the function run **completes normally** (the suspension lives in the
   snapshot store, not in Inngest).
2. Call `runner.resume(runId, { approved: true })` — a second function run re-enters and the run
   completes.
3. `Ctrl-C` the serve process while a run is mid-flight (past a completed step), then restart it:
   the engine retries the start trigger, the retry recognizes the `running` snapshot and continues
   it — the completed step replays from its record, the in-flight step executes again. Or call
   `runner.recover()` at boot for the sweep without waiting on retries.

Use a persistent `WorkflowSnapshotStore` (`@oribos/sqlite`, or your own adapter) so the snapshots
survive the restart — that store is the state truth, not the engine.
