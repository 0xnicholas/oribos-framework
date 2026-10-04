/**
 * The adapter's one connection and the lifecycle around it: open → `journal_mode=WAL` /
 * `synchronous=NORMAL` / `foreign_keys=ON` / busy timeout → migrations. One connection per storage
 * instance, never a pool, never exposed — a host wanting raw SQL opens its own connection on the
 * same path (WAL makes that safe).
 *
 * `init()` is idempotent (open once), `close()` is idempotent (close once, a no-op before init) and
 * the object is dead afterwards: port methods throw until `init()` ran and again after `close()`.
 *
 * This module is also the home of the four ports' shared pagination vocabulary: `assertPageLimit`
 * (the `limit` rule) and `loadCursorRow` (the `before` cursor row, missing or out of scope → the
 * one cursor message). Error wording is the adapter's observable face, so it is built once here —
 * `<port>.<method>: …` — and never per call site. What a page does with the row (tuple direction,
 * sentinels) stays with the port: that is genuinely per-port semantics, not duplication.
 *
 * The busy timeout is set with the `PRAGMA` rather than the constructor's `timeout` option alone:
 * the option only landed in Node 22.16 and is **silently ignored** on the engines floor (22.13,
 * the floor ADR-0002 froze for M5), which would leave cross-process writes with no wait at all. The
 * option is still passed — on newer Nodes it arms the busy handler from the moment the file opens —
 * and the pragma then holds the same value on every supported runtime.
 */
import { DatabaseSync } from 'node:sqlite';
import { LATEST_VERSION, MIGRATIONS } from './schema.js';

/** Default busy timeout (`timeout` / `busyTimeoutMs`), milliseconds: SQLite's own 5s convention. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** The shared seam all four port modules speak to. */
export interface SqliteLifecycle {
  /** The live connection, or a throw: `call init() first` / `storage is closed`. */
  open(): DatabaseSync;
  /** Idempotent: open + pragmas + migrations; a failure closes the half-open handle again. */
  init(): void;
  /** Idempotent: close the handle (no-op before init and after close). */
  close(): void;
}

/** Turns JSON-only values into their text column; absent (`undefined`) is SQL NULL, `null` is `'null'`. */
export function encodeJson(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError('@oribos/sqlite: value is not JSON-serializable');
  }
  return text;
}

/** Reads a JSON text column back; the caller decides what SQL NULL (absent) means. */
export function decodeJson(text: string): unknown {
  return JSON.parse(text);
}

/** `limit` is the port's own rule — a non-positive or fractional value throws, never widens. */
export function assertPageLimit(caller: string, limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`${caller}: limit must be a positive integer, got ${limit}`);
  }
}

/**
 * Loads the row a `before` cursor points at; absent — or outside the query's scope when `inScope`
 * is given — throws the adapter's one cursor message.
 */
export function loadCursorRow<TRow>(
  db: DatabaseSync,
  cursor: {
    /** The error prefix, `<port>.<method>` — the storage object's slot name plus the port method. */
    readonly caller: string;
    /** What the cursor was expected to name (`thread` / `message` / `snapshot` / `schedule`). */
    readonly noun: string;
    /** `SELECT … WHERE <id column> = ?` — the row the cursor names, by its primary key. */
    readonly sql: string;
    readonly before: string;
    /** Absent → existence only; present → the row must also belong to the query's scope. */
    readonly inScope?: (row: TRow) => boolean;
  },
): TRow {
  const row = db.prepare(cursor.sql).get(cursor.before) as TRow | undefined;
  if (row === undefined || cursor.inScope?.(row) === false) {
    throw new Error(
      `${cursor.caller}: before cursor '${cursor.before}' is not a ${cursor.noun} in this store`,
    );
  }
  return row;
}

/** `BEGIN IMMEDIATE` … `COMMIT`, rolling back on any throw — the multi-statement write unit. */
export function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction never started (e.g. BEGIN hit a busy database): nothing to roll back.
    }
    throw error;
  }
}

export function createLifecycle(path: string, busyTimeoutMs: number): SqliteLifecycle {
  let db: DatabaseSync | undefined;
  let closed = false;

  return {
    open(): DatabaseSync {
      if (db === undefined) {
        throw new Error(closed ? 'storage is closed' : 'call init() first');
      }
      return db;
    },

    init(): void {
      if (closed) throw new Error('storage is closed');
      if (db !== undefined) return;
      const opened = new DatabaseSync(path, { timeout: busyTimeoutMs });
      try {
        configure(opened, path, busyTimeoutMs);
        migrate(opened);
      } catch (error) {
        opened.close();
        throw error;
      }
      db = opened;
    },

    close(): void {
      if (closed) return;
      closed = true;
      const opened = db;
      db = undefined;
      opened?.close();
    },
  };
}

/** Open → pragmas → readback guard (the connection lifecycle and concurrency). */
function configure(db: DatabaseSync, path: string, busyTimeoutMs: number): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  const readback = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const mode = readback.journal_mode;
  if (mode !== 'wal' && !(path === ':memory:' && mode === 'memory')) {
    throw new Error(
      `@oribos/sqlite: journal_mode is '${mode}' on '${path}', not 'wal' — ` +
        'WAL is required (network filesystems cannot provide it)',
    );
  }
}

/** Forward-only, additive-only: ordered `{ version, up }`, `PRAGMA user_version` is the ledger. */
function migrate(db: DatabaseSync): void {
  const readback = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = readback.user_version;
  if (current > LATEST_VERSION) {
    throw new Error(
      `@oribos/sqlite: database user_version ${current} is newer than this package supports ` +
        `(${LATEST_VERSION}) — downgrades are not supported`,
    );
  }
  if (current === LATEST_VERSION) return;
  inTransaction(db, () => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  });
}
