# @oribos/lease

TTL + token exclusive ownership of a named unit of work — the leaf package shared by
[`@oribos/distributed-signals`](https://www.npmjs.com/package/@oribos/distributed-signals) and
[`@oribos/background-tasks`](https://www.npmjs.com/package/@oribos/background-tasks).

```ts
import { createInMemoryLeaseStore } from '@oribos/lease';

const leases = createInMemoryLeaseStore();
const handle = await leases.acquire('reports:october', 30_000);
if (handle !== null) {
  try {
    // ... the unit of work ...
    if (!(await handle.renew(30_000))) {
      // lost: stop claiming the unit
    }
  } finally {
    await handle.release();
  }
}
```

## What it is

A mechanism, not a policy. One port — `acquire(key, ttlMs) → LeaseHandle | null` with
`LeaseHandle = { token, renew(ttlMs), release() }` — an in-memory default and a Redis adapter:

- `createInMemoryLeaseStore({ now? })` — the default: one map, lazy expiry, zero timers. `now`
  injects the clock so tests can age a lease without sleeping.
- `createRedisLease({ client })` — opt-in: `set(key, token, 'PX', ttlMs, 'NX')` for acquisition
  and token-guarded Lua for renew / release. The client is a structural subset
  (`set` + `eval`), so `ioredis` matches as-is and the Redis dependency stays yours.

The semantics are small and fixed:

- A contender whose `acquire` returns `null` does nothing.
- `renew` extends the TTL while the token still owns the key; once lost, it returns `false`.
- `release` is harmless on a lost or foreign lease — it never deletes someone else's hold.

TTL formulas, heartbeat / renewal cadence, and what loss means in a domain stay with the
consumers: signals treats loss as losing the thread's active-run ownership (a wake race),
background-tasks treats it as an orphaned task row (`adopt()` re-runs it).

## Shape

Zero external dependencies, no `@oribos/core` peer, no module-level state. A public leaf
package (ADR-0020): capability packages depend on it with `dependencies`; users install the
capability package, never this one directly.

The package face: `Lease`, `LeaseHandle`, `createInMemoryLeaseStore`,
`InMemoryLeaseStoreConfig`, `createRedisLease`, `RedisLeaseConfig`, `RedisLeaseClient`.
