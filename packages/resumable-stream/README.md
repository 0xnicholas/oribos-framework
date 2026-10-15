# @oribos/resumable-stream

Reconnectable agent streams — the resumable-stream capability package. It records a run's
chunk stream into an event cache and replays-and-follows it with `observe(runId)`: a client
that disconnects mid-stream reconnects with the run id and loses nothing. One seam, no core
changes — the core keeps no resume endpoint; the GET endpoint that turns `observe` into HTTP
is the application's:

```ts
import { createEventCacheApp } from './app'; // your route layer
import { withEventCache, observe, createInMemoryEventCache } from '@oribos/resumable-stream';

const cache = createInMemoryEventCache();

// POST /chat — record the run as it streams (the run id is your key for it)
const output = withEventCache(agent.stream(input), { runId, cache });
for await (const chunk of output) response.write(sse(chunk));

// GET /stream/<runId> — the reconnect: replay the missed chunks, then follow live
for await (const chunk of observe(cache, runId)) response.write(sse(chunk));
```

## How it works

- **`withEventCache(output, { runId, cache })`** wraps the agent's (or durable agent's) stream
  and appends every chunk to the cache as it flows — the returned object has the same shape
  as the original (chunk stream + terminal promises), so it drops into the streaming path you
  already have. The recording survives the consumer: the wrapper's own pump drives the run to
  completion even after its consumer hangs up, which is exactly the reconnect story's other
  half. A cache that refuses an append fails the run — the recording is part of the run, not a
  best-effort side channel.
- **`observe(cache, runId)`** replays a run's cached chunks in stream order, then follows the
  run live until it ends. A finished run replays from anywhere the cache can be read; a failed
  run replays what it produced and then rejects with the recorded failure. A run that is
  `active` but not being recorded in this process replays and then throws `RunNotLiveError` —
  cross-instance live tails need a PubSub (a different package's seam), and this package does
  not smuggle one in as a polling loop. Unknown runs throw `UnknownRunError`.
- **`closeOnSuspend` needs no mechanism**: a durable run's stream ends with its
  `finish` chunk (`finishReason: 'suspended'`) and the run's cache entry closes with it, so
  observers see the run end exactly when the stream did; resuming is a new run id.

## The cache port

- **`createInMemoryEventCache()`** — the default: a Map of run logs, zero dependencies, zero
  process footprint, no timers. It never evicts on its own; call `drop(runId)` when a run's
  replay window has passed (that knob stays yours).
- **`createRedisEventCache({ client, prefix? })`** — durable replay for production: one JSON
  log per run under `<prefix>oribos:stream:<runId>`, on any Redis-compatible client
  (`get` / `set` / `del` — the structural subset `ioredis` and `node-redis` both satisfy).
  A run's log survives a process restart, and any instance sharing the database can replay
  it. The client is yours; the dependency stays out of this package.

Zero cost when unconfigured: without the wrapper the core's stream path is untouched. No
resident pipeline: everything happens inline in the request that triggered it.

See `examples/resumable-stream` for the disconnect-reconnect story as a runnable script
(wired into the repo's offline examples gate).
