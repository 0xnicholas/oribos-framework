# crash-replay example

A process is killed mid-run; the next process boots, sweeps the checkpoint store, and replays the
run from its last completed step — the `@oribos/checkpoints` capability package's whole story in
one offline script (a scripted model, a file-backed store, a real `SIGKILL`, no network, no API
key).

## What it shows

1. **Crash.** A worker process runs an agent whose model stub kills the process on its third call
   — mid-run, no unwind, no settle hook. Two model calls and two `note` tool executions had
   already completed; the last checkpoint (step 1's boundary) is what survives, in the store file.
2. **Boot sweep.** The parent process attaches the same store and calls `recoverAll()`. The
   replayed step makes no model call (its output came from the checkpoint), its `note` call
   executes again — the idempotency cost, visible in the log as a `boot` line — and step 2's
   model call is re-sent: the one in-flight call, and the only model work recovery repeats.
3. **Cleared.** The recovered run settles, consumes its checkpoint, and a second sweep finds
   nothing.

## Run it

From the repo root, after `pnpm install && pnpm build`:

```sh
pnpm --filter @oribos/example-crash-replay start
```

The script self-asserts (`node:assert/strict`) and exits 1 if a completed step is re-sent, the
tool re-execution is missing, or a checkpoint is left behind. It is wired into the offline
examples gate (`pnpm check:examples`).
