# workflow-time-travel

Debug a finished workflow run by restarting it from a step: `run.restart({ step })` loads the run's
snapshot, truncates the records at and after the chosen step, and re-enters the walk there — the
steps before it replay from their records (never re-executed, side effects not repeated), the target
re-runs fresh. Oribos is a TypeScript agent framework with zero runtime dependencies — compose only
what you use, run anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input, **no API
key and no network**. A three-step pricing pipeline (fetch → convert → report) runs with a stale
exchange rate; the snapshot's records locate the bug, the rate is fixed, and the run is restarted
from `convert`. Four acts:

1. **Start: a wrong report.** The pipeline runs to `success`; the report carries totals computed
   with the stale rate. The store's write log shows the fixed persistence ritual (one `running`
   snapshot per completed entry, one terminal).
2. **Inspect the snapshot.** `stepResults` shows `fetch-orders`' recorded output is fine and
   `convert`'s is wrong — the bug is located from the records, without re-running anything.
3. **Fix and restart from the step.** `run.restart({ step: 'convert' })` truncates `convert`'s and
   `report`'s records and re-enters at `convert`: the fetch's execute count stays 1, the report
   comes out right, and the write log shows the truncation.
4. **Restart from the beginning.** `run.restart()` with no step truncates every record and
   re-executes the pipeline over the snapshot's start input.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core through its package exports (dist)
pnpm --filter @oribos/example-workflow-time-travel start
```

Expected output: the store's write log for each segment, the snapshot's step records, both reports
(wrong then right), and the restart write log with the truncated record set. The script **asserts
its own payoff** — a fetch that re-runs across a step restart, a report that stays wrong after the
fix, a write log that does not show the truncation — each exits non-zero instead of printing a happy
face.

## Notes

- **The restart primitive is resume's thin variant.** Same load → re-enter machinery; three
  differences: the caller picks the position, the records at and after it are truncated first, and
  there is no `resumeData` boundary — the target step is re-executed, not answered.
- **The grain is the flat entry.** Naming a step inside a `parallel` / `branch` / `foreach` / loop
  block restarts the whole block — there is no path model to address an arm or an iteration.
- **The store is not written at restart time.** A restart only loads; the walk's own fixed
  persistence points overwrite the snapshot as the restarted entries complete, so a rejected
  restart leaves the snapshot untouched.
- **Cross-process debugging** is the same call on a fresh run object over a persistent store:
  `workflow.createRun({ runId }).restart({ step })` against e.g. `@oribos/sqlite`.
- The script consumes `@oribos/core` through its built package exports — run `pnpm build` before
  `start`.
