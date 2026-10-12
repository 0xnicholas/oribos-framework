/**
 * Oribos workflow-time-travel example — debug a finished run by restarting it from a step.
 *
 * One script, no external services: a three-step pricing pipeline (fetch → convert → report) runs
 * with a stale exchange rate and produces a wrong report; the run's snapshot is inspected like a
 * debugger's stack, the rate is fixed, and `run.restart({ step })` re-enters the walk at the broken
 * step — the fetch never re-runs, the broken step and everything after it re-execute. A final
 * `run.restart()` re-runs the whole pipeline from the start input.
 *
 * The acts:
 *
 * 1. **Start: a wrong report.** The pipeline runs to `success`; the report carries totals computed
 *    with the stale rate. The store's write log shows the fixed persistence ritual (one `running`
 *    snapshot per completed entry, one terminal).
 * 2. **Inspect the snapshot.** `store.load(runId)` returns the JSON state: `stepResults` shows
 *    `fetch-orders`' recorded output is fine and `convert`'s is wrong — the bug is located from
 *    the records, without re-running anything.
 * 3. **Fix and restart from the step.** The rate table is corrected (stand-in for a code or config
 *    fix), and `run.restart({ step: 'convert' })` truncates the records at and after `convert` and
 *    re-enters the walk there. `fetch-orders`' execute count stays 1 — its side effect is not
 *    repeated (records-first); `convert` and `report` re-run and the report comes out right. The
 *    write log shows the truncation: the first write after the restart holds only `fetch-orders`
 *    and the fresh `convert` record.
 * 4. **Restart from the beginning.** `run.restart()` with no step truncates every record and
 *    re-executes the pipeline over the snapshot's start input — the fetch runs a second time.
 *
 * The restart primitive is the thin variant of the resume machinery: load the snapshot, re-enter
 * the same for-loop. The differences are exactly three — the caller picks the position, the records
 * at and after it are truncated first, and there is no `resumeData` boundary (the target step is
 * re-executed, not answered).
 *
 * The script self-asserts (`node:assert/strict`): a fetch that re-runs across a step restart, a
 * report that stays wrong after the fix, or a write log that does not show the truncation exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-workflow-time-travel start
 */
import assert from 'node:assert/strict';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
} from '@oribos/core/workflows';
import type { WorkflowSnapshotStore } from '@oribos/core/workflows';
import { z } from 'zod';

// ── The pipeline: fetch → convert → report ──────────────────────────────────────────────────────

const orders = z.array(z.object({ sku: z.string(), cents: z.number() }));
const converted = z.array(z.object({ sku: z.string(), cents: z.number(), eurCents: z.number() }));
const report = z.object({ lines: z.array(z.string()), totalEur: z.number() });

/** The orders the (scripted) source holds: three SKUs, USD cents. */
const SOURCE_ROWS = [
  { sku: 'book', cents: 1299 },
  { sku: 'pen', cents: 350 },
  { sku: 'lamp', cents: 4900 },
];

/**
 * The rate table the convert step reads at execution time — the mutable stand-in for whatever a
 * fix edits (a config value, a redeployed function). The pipeline starts with a stale rate; act 3
 * corrects it and restarts from `convert`.
 */
const rates = { usdToEur: 1.25 };

/** How often the source was hit — the side effect a records-first restart must not repeat. */
let fetchCount = 0;

const fetchOrders = createStep({
  id: 'fetch-orders',
  inputSchema: z.object({ trigger: z.literal('go') }),
  outputSchema: orders,
  execute: () => {
    fetchCount += 1;
    return SOURCE_ROWS;
  },
});

const convert = createStep({
  id: 'convert',
  inputSchema: orders,
  outputSchema: converted,
  execute: (ctx) =>
    ctx.inputData.map((row) => ({ ...row, eurCents: Math.round(row.cents * rates.usdToEur) })),
});

const summarize = createStep({
  id: 'report',
  inputSchema: converted,
  outputSchema: report,
  execute: (ctx) => {
    const totalEur = ctx.inputData.reduce((sum, row) => sum + row.eurCents, 0) / 100;
    return {
      lines: ctx.inputData.map((row) => `${row.sku}: €${(row.eurCents / 100).toFixed(2)}`),
      totalEur,
    };
  },
});

/**
 * The store is a port: any object with `load` / `save` (`WorkflowSnapshotStore`, JSON-only). This
 * one decorates the core's in-memory default with a write log so the truncation is visible — a
 * restart does not write a special snapshot; the walk's own fixed points do, over the truncated
 * records. A real deployment swaps the in-memory default for a persistent adapter (e.g.
 * `@oribos/sqlite`), which is what makes a restart a cross-process story.
 */
function recordingStore(): { readonly store: WorkflowSnapshotStore; readonly writes: string[] } {
  const inner = createInMemorySnapshotStore();
  const writes: string[] = [];
  return {
    writes,
    store: {
      load: (id) => inner.load(id),
      save: (id, snapshot) => {
        writes.push(
          `${snapshot.status.padEnd(8)} position=${snapshot.position}  records=[${Object.keys(snapshot.stepResults).join(', ')}]`,
        );
        return inner.save(id, snapshot);
      },
    },
  };
}

const { store, writes } = recordingStore();

const workflow = createWorkflow({
  id: 'pricing',
  inputSchema: z.object({ trigger: z.literal('go') }),
  outputSchema: report,
  storage: store,
})
  .then(fetchOrders)
  .then(convert)
  .then(summarize)
  .commit();

const runId = 'pricing-2026-0418';
const USD_TOTAL = (1299 + 350 + 4900) / 100;

console.log("workflow-time-travel — debug a finished run by restarting it from a step.");

// ── Act 1 — start: a wrong report ───────────────────────────────────────────────────────────────

console.log('\n──────── Act 1 — start: the pipeline runs with a stale rate ────────');
const run = workflow.createRun({ runId });
const first = await run.start({ inputData: { trigger: 'go' } }).result;
assert.equal(first.status, 'success');
console.log(`Store writes (${writes.length}):`);
for (const write of writes) console.log(`  ${write}`);
console.log(`\nReport (stale rate ${rates.usdToEur}):`);
for (const line of first.output.lines) console.log(`  ${line}`);
console.log(`  total: €${first.output.totalEur.toFixed(2)}  ← wrong: the rate was stale`);
assert.notEqual(first.output.totalEur, Number((USD_TOTAL * 0.9).toFixed(2)));

// ── Act 2 — inspect the snapshot: locate the bug from the records ────────────────────────────────

console.log('\n──────── Act 2 — inspect the snapshot: the records locate the bug ────────');
const snapshot = await store.load(runId);
assert.ok(snapshot !== null && snapshot.status === 'success');
console.log(`store.load('${runId}'):`);
console.log(`  status       ${snapshot.status}`);
console.log(`  position     ${snapshot.position}   (past the end — the run completed)`);
console.log('  stepResults');
for (const [stepId, record] of Object.entries(snapshot.stepResults)) {
  console.log(`    ${stepId.padEnd(13)} ${record.status}  ${JSON.stringify(record.output).slice(0, 72)}`);
}
// The fetch record is fine: the source cents are the ones the source holds. The convert record is
// wrong: its eurCents carry the stale rate. Nothing was re-executed to learn this.
const fetched = z.array(z.object({ sku: z.string(), cents: z.number() })).parse(
  snapshot.stepResults['fetch-orders']?.output,
);
assert.deepEqual(fetched, SOURCE_ROWS);
console.log(`\n  fetch-orders' record holds the source rows — the bug is downstream, in convert.`);

// ── Act 3 — fix and restart from the step ───────────────────────────────────────────────────────

console.log('\n──────── Act 3 — fix the rate, restart from convert ────────');
rates.usdToEur = 0.9;
const writesBeforeRestart = writes.length;
const restarted = await run.restart({ step: 'convert' });
assert.equal(restarted.status, 'success');

// records-first: the fetch was not repeated — its record replayed; convert and report re-ran.
assert.equal(fetchCount, 1);
console.log(`fetch-orders executed ${fetchCount}× in total — the restart did not re-fetch.`);
console.log(`\nStore writes after restart (${writes.length - writesBeforeRestart}):`);
for (const write of writes.slice(writesBeforeRestart)) console.log(`  ${write}`);
// The truncation is visible in the first write after the restart: convert's and report's old
// records are gone; convert's fresh record joins fetch-orders' survivor.
const firstWrite = writes[writesBeforeRestart];
assert.equal(firstWrite, 'running  position=2  records=[fetch-orders, convert]');
console.log(`\nReport (fixed rate ${rates.usdToEur}):`);
for (const line of restarted.output.lines) console.log(`  ${line}`);
console.log(`  total: €${restarted.output.totalEur.toFixed(2)}`);
assert.equal(restarted.output.totalEur, Number((USD_TOTAL * 0.9).toFixed(2)));

// ── Act 4 — restart from the beginning ──────────────────────────────────────────────────────────

console.log('\n──────── Act 4 — restart() with no step: the whole pipeline re-runs ────────');
const again = await run.restart();
assert.equal(again.status, 'success');
assert.equal(fetchCount, 2);
console.log(`fetch-orders executed ${fetchCount}× in total — a full restart re-runs everything,`);
console.log(`over the snapshot's start input (the start boundary does not run again).`);
assert.equal(again.output.totalEur, restarted.output.totalEur);

console.log('\nDone — the run was time-travelled: truncated at convert, re-entered from the records,');
console.log('and later restarted whole. No step re-executed before its truncation point.');
