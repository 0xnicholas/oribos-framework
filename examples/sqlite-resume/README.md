# sqlite-resume

A durable run that outlives the process that made it: the refund desk suspends in a worker process, its
loop snapshot lands in SQLite through [`@oribos/sqlite`](../../packages/sqlite/), the worker exits — and a
brand-new process opens its own connection to the same file and resumes the run. Oribos is a TypeScript
agent framework with zero runtime dependencies — compose only what you use, run anywhere.

One script, two processes (`src/index.ts` re-execs itself as the worker), four acts:

1. **The worker suspends** — the model asks for the approval-gated `issueRefund`, nothing executes, and the
   run's identity goes to stdout as one machine-readable line before the process ends.
2. **A new process sees everything** — `listSuspended()` finds the run the dead process left behind;
   `load()` returns the JSON-only snapshot the resume re-enters from; the message history is still empty
   because a suspended step never completed (memory saves once per completed step).
3. **The parent resumes** — `resume(runId, { approved: true })` replays the held call (the ledger moves in
   *this* process), the run finishes on the model's report, and the completed step now saves its message
   history into the same file.
4. **The negative space is asserted** — resuming a run the store never saw rejects; a second connection's
   `compareAndSave` loses to the winner and writes nothing (the cross-process resume de-duplication
   premise); `listDue()` fires a schedule stored in the same file.

## Run

From the repo root:

```bash
pnpm install
pnpm build
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-sqlite-resume start
```

Any OpenAI-compatible endpoint works too, e.g. a local Ollama:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @oribos/example-sqlite-resume start
```

Without `OPENAI_API_KEY` the script exits immediately, asking for one. The SQLite file defaults to a fresh
temp directory; set `ORIBOS_SQLITE_EXAMPLE_DB` to keep it. The script self-asserts
(`node:assert/strict`): a worker that fails to suspend, a snapshot that is not in the file, a resume that
does not execute the held call — each exits non-zero instead of printing a happy face.

## Notes

- **This is the SQLite adapter's whole point**: `storage.memory`, `storage.agentRunSnapshots` and
  `storage.schedules` are handed to the composition root, so the snapshot, the message history and the
  schedule all land in one file that outlives the process.
- The example consumes `@oribos/core` and `@oribos/sqlite` through their built package exports — run
  `pnpm build` before `start`. Package docs: [`packages/sqlite`](../../packages/sqlite/) — the SQLite
  reference adapter.
