/**
 * `@oribos/lease` — the lease leaf package: TTL + token exclusive ownership of a named unit of
 * work, shared by capability packages. This package owns the mechanism only (ADR-0020); the
 * `@oribos/distributed-signals` and `@oribos/background-tasks` capability packages keep their
 * domain roles, TTL formulas and renewal cadence.
 *
 * A mechanism, not a policy: `acquire` gives a contender `null` (it does nothing); a holder
 * renews while it owns the unit; once lost, `renew` returns `false` and the holder stops
 * claiming it. What loss *means* — waking a thread, re-running an orphaned task row — stays
 * with the consumer.
 *
 * Zero external dependencies. [`createInMemoryLeaseStore`] is the offline default (one map,
 * lazy expiry, an injectable clock, zero timers); [`createRedisLease`] adapts any
 * Redis-compatible client through the [`RedisLeaseClient`] structural subset — the dependency
 * stays yours.
 */

// ── The lease port ──────────────────────────────────────────────────────────────────────────────

/** A held lease's handle: the token proves ownership; `renew` refreshes; `release` gives it up. */
export interface LeaseHandle {
  /** The ownership token this holder acquired with (opaque; minted per acquisition). */
  readonly token: string;
  /**
   * Refreshes the lease's TTL, still owned: `true`. Lost (expired and re-acquired elsewhere, or
   * released): `false` — the holder stops claiming the unit after a `false`.
   */
  renew(ttlMs: number): Promise<boolean>;
  /** Gives the lease up. Harmless when already lost: a foreign lease is never deleted. */
  release(): Promise<void>;
}

/**
 * The lease port: exclusive ownership of the keyed unit of work for a TTL. The in-memory
 * default ([`createInMemoryLeaseStore`]) carries no dependency; [`createRedisLease`] adapts any
 * Redis-compatible client. Expiry is the loss domain: a holder that stops renewing (a dead
 * process, work past the expiry window) loses the unit to the next racer.
 */
export interface Lease {
  /** Acquires the key's lease for `ttlMs`, or `null` when someone else holds it. */
  acquire(key: string, ttlMs: number): Promise<LeaseHandle | null>;
}

// ── The in-memory default ──────────────────────────────────────────────────────────────────────

/** One live hold: its ownership token and the clock value at which it expires. */
interface HeldLease {
  token: string;
  expiresAt: number;
}

/**
 * The in-memory [`Lease`] default: one map, lazy expiry, zero timers. Every call observes the
 * injected clock, so expiry is deterministic in tests without sleeping.
 */
export function createInMemoryLeaseStore(config: InMemoryLeaseStoreConfig = {}): Lease {
  const now = config.now ?? (() => Date.now());
  const held = new Map<string, HeldLease>();
  const liveEntry = (key: string): HeldLease | undefined => {
    const entry = held.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      held.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    acquire: async (key, ttlMs) => {
      if (liveEntry(key) !== undefined) return null;
      const token = mintToken();
      held.set(key, { token, expiresAt: now() + ttlMs });
      return {
        token,
        renew: async (renewTtl) => {
          const entry = liveEntry(key);
          if (entry === undefined || entry.token !== token) return false;
          entry.expiresAt = now() + renewTtl;
          return true;
        },
        release: async () => {
          if (liveEntry(key)?.token === token) held.delete(key);
        },
      };
    },
  };
}

/** `createInMemoryLeaseStore` config; every field optional. */
export interface InMemoryLeaseStoreConfig {
  /** The clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

// ── The Redis adapter ──────────────────────────────────────────────────────────────────────────

/**
 * The structural subset of a Redis-compatible client the lease adapter calls: `set(key, value,
 * 'PX', ttlMs, 'NX')` for acquisition and `eval(script, 1, key, …args)` for the token-guarded
 * renew/release. `ioredis` satisfies both shapes as-is; other clients adapt the argument packing.
 */
export interface RedisLeaseClient {
  /** SET with PX + NX — resolves `'OK'` when acquired, `null`/falsy when the key is held. */
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<unknown>;
  /** EVAL the adapter's token-guarded script against one key. */
  eval(script: string, numKeys: number, key: string, ...args: string[]): Promise<unknown>;
}

/** `createRedisLease` config: your client. */
export interface RedisLeaseConfig {
  /** Any Redis-compatible client (the [`RedisLeaseClient`] structural subset). */
  readonly client: RedisLeaseClient;
}

/** Renew: still our token → PEXPIRE the new TTL; otherwise 0. */
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** Release: still our token → DEL; otherwise 0 — a foreign lease is never deleted. */
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** The Redis-backed [`Lease`]: SET(NX/PX) acquisition, token-guarded Lua renew and release. */
export function createRedisLease(config: RedisLeaseConfig): Lease {
  const { client } = config;
  return {
    acquire: async (key, ttlMs) => {
      const token = mintToken();
      const result = await client.set(key, token, 'PX', ttlMs, 'NX');
      if (result !== 'OK') return null;
      return {
        token,
        renew: async (renewTtl) => {
          const renewed = await client.eval(RENEW_SCRIPT, 1, key, token, String(renewTtl));
          return renewed === 1;
        },
        release: async () => {
          await client.eval(RELEASE_SCRIPT, 1, key, token);
        },
      };
    },
  };
}

/** The token minter for both defaults (uniqueness inside one process is all the token needs). */
function mintToken(): string {
  return crypto.randomUUID();
}
