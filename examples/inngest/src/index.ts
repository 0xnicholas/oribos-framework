/**
 * Oribos inngest example — workflow start/resume ride Inngest trigger events; the walker and the
 * snapshot store stay in process, and a run left mid-flight is continued from its snapshot.
 *
 * Everything here runs offline through the **real SDK pathway**: a real `Inngest` client, the
 * runner's real functions behind a real `serve()` endpoint (the code path the Dev Server drives),
 * and a tiny local stand-in for the two network halves —
 *
 * - the **event bus** (`POST /e/<key>`): records what `start()` / `resume()` sent and answers
 *   the Inngest send shape — this is the half the Dev Server usually owns;
 * - the **executor**: delivers each recorded event to the serve endpoint as an execution request
 *   (`?fnId=<appId>-<fnId>`), exactly the request the Dev Server makes.
 *
 * The acts:
 *
 * 1. **Trigger → suspend.** `runner.start(publish, …)` sends the start event; the start function
 *    runs the workflow in process and it suspends at the approval gate — the function ends
 *    normally, the snapshot carries the suspension.
 * 2. **Resume.** `runner.resume(runId, { approved })` sends the resume event; the resume function
 *    re-enters from the suspended snapshot and the run completes. The draft step replays from its
 *    record — never re-executed.
 * 3. **Crash retry → snapshot continuation.** A second workflow dies mid-run (its gate step never
 *    answers the first delivery — from the store's point of view this is a dead process: a
 *    `running` snapshot and nothing else). `runner.recover()` sweeps the persisted registry,
 *    re-enters from the snapshot: the completed entry replays once, the in-flight entry executes
 *    again (the explicit idempotency cost), the run settles — and drops out of the registry.
 *
 * The script self-asserts (`node:assert/strict`). Run it (from the repo root, after
 * `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-inngest start
 *
 * The **real loop** — Dev Server instead of the stand-ins — is the same code with two lines
 * changed; see this example's README for the manual verification.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Inngest } from 'inngest';
import { serve } from 'inngest/node';
import { createInMemorySnapshotStore, createStep, createWorkflow } from '@oribos/core/workflows';
import type { StepContext } from '@oribos/core/workflows';
import { createInngestRunner } from '@oribos/inngest';
import type { InngestFunction } from 'inngest';
import { z } from 'zod';

// Dev mode: the serve endpoint skips signature validation and the client skips cloud checks —
// the stand-ins below play the Dev Server's halves.
process.env.INNGEST_DEV = '1';

/** The two trigger events the runner's functions serve (the package's wire contract). */
const START_EVENT = 'oribos-workflow-start';
const RESUME_EVENT = 'oribos-workflow-resume';

// ── The event bus stand-in: records trigger events, answers the Inngest send shape ────────────

interface RecordedEvent {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

const recorded: RecordedEvent[] = [];

const bus = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    // The Inngest send API: POST /e/<key>, body = a batch array of events; answers `{ status, ids }`.
    const payload = JSON.parse(body) as RecordedEvent[] | { events: RecordedEvent[] };
    const events = Array.isArray(payload) ? payload : payload.events;
    for (const event of events) recorded.push({ name: event.name, data: event.data });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 200, ids: events.map(() => crypto.randomUUID()) }));
  });
});
await new Promise<void>((resolve) => bus.listen(0, '127.0.0.1', resolve));
const busPort = (bus.address() as { port: number }).port;

// ── The workflows: authored exactly as always — `createWorkflow({ storage })` ─────────────────

const store = createInMemorySnapshotStore();
const executed: string[] = [];
const gates: ((value?: unknown) => void)[] = [];

const draft = createStep({
  id: 'draft',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ draft: z.string() }),
  execute: (ctx: StepContext<{ topic: string }>) => {
    executed.push('draft');
    return { draft: ctx.inputData.topic.toUpperCase() };
  },
});
const approve = createStep({
  id: 'approve',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.object({ approved: z.boolean() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: (ctx: StepContext<{ draft: string }, { approved: boolean }>) => {
    if (ctx.resumeData !== undefined) {
      executed.push('approve:resumed');
      return { approved: ctx.resumeData.approved };
    }
    executed.push('approve:suspend');
    ctx.suspend({ reason: 'needs approval' });
  },
});
const polish = createStep({
  id: 'polish',
  inputSchema: z.object({ approved: z.boolean() }),
  outputSchema: z.object({ polished: z.string() }),
  execute: (ctx: StepContext<{ approved: boolean }>) => {
    executed.push('polish');
    return { polished: ctx.inputData.approved ? 'polished' : 'dropped' };
  },
});
const publish = createWorkflow({
  id: 'publish',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ polished: z.string() }),
  storage: store,
})
  .then(draft)
  .then(approve)
  .then(polish)
  .commit();

// The crash story's chain: first → gate, where the gate hangs on a manual latch. The first
// delivery's latch is never opened — the process "dies" holding it.
const first = createStep({
  id: 'first',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ first: z.string() }),
  execute: (ctx: StepContext<{ topic: string }>) => {
    executed.push('first');
    return { first: ctx.inputData.topic };
  },
});
const gate = createStep({
  id: 'gate',
  inputSchema: z.object({ first: z.string() }),
  outputSchema: z.object({ done: z.boolean() }),
  execute: async () => {
    await new Promise((resolve) => gates.push(resolve));
    executed.push('gate');
    return { done: true };
  },
});
const crashy = createWorkflow({
  id: 'crashy',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ done: z.boolean() }),
  storage: store,
})
  .then(first)
  .then(gate)
  .commit();

// ── The runner + the serve endpoint: the real SDK pathway ─────────────────────────────────────

const inngest = new Inngest({
  id: 'example-inngest',
  baseUrl: `http://127.0.0.1:${busPort}`, // the event bus stand-in
  eventKey: 'local-dev-key',
});
const runner = createInngestRunner({ client: inngest, store });

const endpoint = http.createServer(serve({ client: inngest, functions: [...runner.functions] }));
await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
const endpointPort = (endpoint.address() as { port: number }).port;

/** The executor: one execution request for a recorded event, the way the Dev Server sends it. */
async function execute(event: RecordedEvent): Promise<unknown> {
  const trigger: Record<string, InngestFunction.Any> = {
    [START_EVENT]: runner.functions[0]!,
    [RESUME_EVENT]: runner.functions[1]!,
  };
  const fn = trigger[event.name]!;
  const res = await fetch(`http://127.0.0.1:${endpointPort}/?fnId=${encodeURIComponent(fn.id(inngest.id))}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: { name: event.name, data: event.data },
      events: [{ name: event.name, data: event.data }],
      ctx: { fn_id: fn.id(), run_id: crypto.randomUUID(), attempt: 0 },
      steps: {},
      use_api: false,
    }),
  });
  const ops = (await res.json()) as { op: string; data: unknown }[];
  const complete = ops.find((entry) => entry.op === 'RunComplete');
  return complete?.data;
}

/** The Dev Server's other half: deliver the next recorded trigger event to the endpoint. */
async function deliverNext(): Promise<unknown> {
  const event = recorded.at(-1);
  assert.ok(event, 'no recorded event to deliver');
  return await execute(event);
}

const note = (line: string): void => {
  console.log(line);
};

// ── Act 1: trigger → suspend ──────────────────────────────────────────────────────────────────

const publishRunId = await runner.start(publish, { topic: 'hello world' });
note(`start  → event recorded, run ${publishRunId}`);
const suspended = (await deliverNext()) as { status: string; stepId?: string };
assert.equal(suspended.status, 'suspended');
assert.equal(suspended.stepId, 'approve');
assert.deepEqual(executed, ['draft', 'approve:suspend']);
note('deliver → run suspended at approve (function ended normally, snapshot carries it)');

// ── Act 2: resume ─────────────────────────────────────────────────────────────────────────────

await runner.resume(publishRunId, { approved: true });
const done = (await deliverNext()) as { status: string; output?: { polished: string } };
assert.equal(done.status, 'success');
assert.deepEqual(done.output, { polished: 'polished' });
// draft replays from its record (never re-executed); approve re-enters with the answer.
assert.deepEqual(executed, ['draft', 'approve:suspend', 'approve:resumed', 'polish']);
note('resume → event redelivered with the payload, run completed from the snapshot');

// ── Act 3: crash retry → snapshot continuation ────────────────────────────────────────────────

const crashRunId = await runner.start(crashy, { topic: 'hi' });
const crashedDelivery = deliverNext(); // never awaited: the process "dies" mid-run
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal((await store.load(crashRunId))?.status, 'running');
assert.equal(gates.length, 1);
note('crash  → first delivery hung at the gate; the run is a `running` snapshot and nothing else');

// The sweep re-enters from the snapshot: first replays from its record, the gate re-executes.
const sweep = runner.recover();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(gates.length, 2, 'recover re-entered the run; the gate is pending a second time');
gates[1]?.(); // the re-entered walk's gate
const report = await sweep;
assert.equal(report.recovered.length, 1);
assert.equal(report.recovered[0]?.runId, crashRunId);
assert.equal(report.recovered[0]?.outcome.status, 'success');
assert.equal(gates.length, 2); // the dead delivery's gate was never opened
note('recover → re-entered from the snapshot: first replayed once, gate re-executed once, run settled');

// Settled runs leave the registry: their triggers and resumes are no longer the runner's business.
await assert.rejects(runner.resume(crashRunId), /no managed run/);
await assert.rejects(runner.resume(publishRunId), /no managed run/);
note('registry → settled runs dropped; `resume` refuses them client-side');

// ── The bus stand-in goes home; the real loop is the README's Dev Server steps ────────────────

// The dead delivery's handler is still holding its gate (the crash is one-sided: the store saw a
// process death, the old handler lives on). Let it settle, drop its socket (its fetch fails with
// the connection — the same view a real crash leaves), then close both stand-ins for real.
gates[0]?.();
crashedDelivery.catch(() => {}); // the abandoned delivery dies with the connection, like a crash does
bus.closeAllConnections();
endpoint.closeAllConnections();
bus.close();
endpoint.close();
console.log('\nOK — trigger / suspend / resume / crash-retry / snapshot continuation all held.');
