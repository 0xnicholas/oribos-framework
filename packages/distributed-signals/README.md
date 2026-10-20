# @oribos/distributed-signals

Cross-instance signals routing — the distributed-signals capability package. The base
[`createSignals`](https://www.npmjs.com/package/@oribos/core) subsystem is single-process by
design: its registry and queues are process memory. This package wraps a `Signals` instance —
the core is untouched, there is no injection seam — and routes the three send primitives across
instances over two ports you inject: a PubSub that carries one JSON envelope per thread channel,
and a lease that arbitrates the idle-wake race. Both ship zero-dependency in-memory defaults;
any Redis-compatible client rides the structural subset.

```ts
import { createSignals } from '@oribos/core/signals';
import {
  createDistributedSignals,
  createInMemoryPubSub,
  createInMemoryLeaseStore,
} from '@oribos/distributed-signals';

const signals = createSignals({ agent, memory });
const distributed = createDistributedSignals({ signals, pubsub, lease });

distributed.stream(input, { memory: { thread, resource } }); // always local,直达内核
distributed.sendMessage({ thread, resource }, 'hi');         // active here = inject;
                                                             // idle = publish + lease race
```

## How it works

- **Routing.** `sendMessage` / `queueMessage` / `sendSignal` inject locally while a run is live
  on this instance (with a token self-check when the heartbeat is off), otherwise publish to the
  thread's channel (`<prefix>oribos:signals:<threadId>`). A received envelope injects into a
  live local run; otherwise every subscribed instance races the lease and the winner wakes the
  thread — the sender itself included, so "idle = wake" is just the race the sender usually wins.
  `stream` / `generate` always hit the wrapped signals directly; `subscribeToThread` only ever
  sees this instance's runs — cross-instance chunk tails are refused by construction in v1.
- **Lease = thread active-run ownership.** Claimed when a wrapper run starts, released when it
  settles. It is the wake-race arbiter, not a global mutex: broadcast redundancy converges on
  it (only the holder injects; only a race winner wakes), and the documented expiry window can
  let two instances wake one thread. The mechanism — port, in-memory default, Redis adapter —
  lives in the shared leaf package [`@oribos/lease`](https://www.npmjs.com/package/@oribos/lease)
  (ADR-0020); `SignalLease` is its alias, and `createInMemoryLeaseStore` / `createRedisLease`
  are re-exported here unchanged.
- **Delivery is at-most-once**, widened one domain from the core's "process death = loss": an
  envelope in flight when a process dies is dropped. Cross-instance ordering is best-effort FIFO
  (one channel per thread is naturally ordered; no sequence numbers).
- **Heartbeat** (`heartbeatMs`): configured, a renewal interval runs while leases are held, with
  an acquire/renew TTL of `3 × heartbeatMs`. Absent, zero timers — renewal happens at the
  wrapper runs' step boundaries, with a token self-check before every cross-instance injection.
  Unconfigured means zero timers: opt-in background work, no resident pipeline.
- **Trace continuation.** An envelope may carry a W3C `traceparent`; the receiver's wake run
  continues that trace (the sender as remote parent). A value that fails to parse degrades to a
  fresh trace — no added failure surface. v1 senders do not fill the field (the send signatures
  are frozen and the wrapper holds no tracer); the wire format carries it for receivers.
- **Structural-subset Redis adapters.** `createRedisPubSub(client)` calls `subscribe` /
  `unsubscribe` / `publish` (listener receives `(channel, message)` — `ioredis` matches as-is);
  `createRedisLease(client)` calls `set(key, value, 'PX', ttlMs, 'NX')` and `eval` with the
  token-guarded renew/release scripts. Pass your client, keep the dependency yours.

## The documented windows

- A run stalled past the lease's expiry window (heartbeat off: 30 s without a step; heartbeat
  on: two missed beats) can lose its thread to a racer on another instance.
- A queue received while a run is live lands in that run's process queue; the continuation run
  it starts after settle is the core's own — a racer can win the released lease in the gap.

## The two-process example

`examples/distributed-signals` runs two real Node processes sharing nothing but an IPC relay
that implements the same two ports — process A hosts the thread, process B sends across, and
the idle wake runs end to end. It is wired into the repo's example gate.
