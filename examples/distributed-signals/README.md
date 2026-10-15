# @oribos/example-distributed-signals

Two real Node processes, one thread, signals routed across the process boundary — the
`@oribos/distributed-signals` two-port seam, end to end.

The processes share nothing but `src/ipc-transport.ts`: an IPC relay that implements the
package's `SignalPubSub` and `SignalLease` ports over `process.send` / `process.on('message')`
(parent hub fan-out + lease arbitration, child RPC). Production swaps that one file for Redis;
the ports are the whole seam.

The acts:

1. **Cross-instance inject.** Process A streams a run on thread `support`, parked in a gated
   tool. Process B `sendSignal`s: the envelope crosses, A's live run takes it as its next
   step's prompt tail (`[signal] {"type":"nudge","n":1}`), persisted as an ordinary message.
2. **Idle wake.** A's run settles (lease released). B sends again: A wins the lease race and
   wakes a new run — the signal is the wake run's input (the model's third call).

The script self-asserts via `node:assert/strict`; B's model is a stub that throws if ever
called, and B exits clean only at zero model calls.

```bash
pnpm --filter @oribos/example-distributed-signals start
```
