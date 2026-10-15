# resumable-stream example

A client hangs up mid-stream, reconnects with the run id, and loses nothing — the
`@oribos/resumable-stream` capability package's whole story in one offline script (a scripted
paced model, an in-process HTTP server, no network beyond loopback, no API key).

## What it shows

1. **Stream, then hang up.** `POST /chat` wraps the agent's stream with `withEventCache`, so
   every chunk lands in the event cache as it flows. The client reads two text deltas and
   aborts the connection; the server abandons the response traversal, but the run — and its
   recording — keep going to the end.
2. **Reconnect.** `GET /stream/<runId>` is `observe(cache, runId)` as SSE: the missed deltas
   replay in order, the tail streams live, and the stream ends with the run's finish chunk.
   The reassembled text is the complete answer, nothing lost, nothing doubled.
3. **Replay after the end.** The same GET after the run finished replays the whole run from
   the cache — the durable-replay shape (with `createRedisEventCache`, from any instance
   sharing the database).

## Run it

From the repo root, after `pnpm install && pnpm build`:

```sh
pnpm --filter @oribos/example-resumable-stream start
```

The script self-asserts (`node:assert/strict`) and exits 1 on any lost delta, doubled delta,
or truncated replay. It is wired into the offline examples gate (`pnpm check:examples`).
