# `@oribos/sqlite`

The first-party SQLite storage adapter for [Oribos](https://github.com/0xnicholas/oribos-framework):
one factory over one embedded file, implementing all four storage ports — memory history, workflow
snapshots, durable-run snapshots and schedules — plus every declared port extension. Zero
dependencies: the driver is Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html),
so it installs nothing and runs no service.

```ts
import { createSqliteStorage } from '@oribos/sqlite';

const storage = createSqliteStorage({ path: 'oribos.db', busyTimeoutMs: 5_000 });

storage.memory              // MemoryStore (with getResource / saveResource -> working memory)
storage.workflowSnapshots   // WorkflowSnapshotStore + compareAndSave / deleteSnapshot / listSnapshots
storage.agentRunSnapshots   // AgentRunSnapshotStore + deleteSnapshot / listSuspended
storage.schedules           // ScheduleStore

storage.init();             // idempotent: open + pragmas (WAL / synchronous NORMAL / FK / busy) + migrations
// … use the ports …
await storage.close();      // idempotent; after it every port method throws
```

- Spec: [`docs/architecture/storage.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/storage.md)
- Driver facts this package builds on: [`docs/research/sqlite-driver-landscape.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/research/sqlite-driver-landscape.md)
- Decisions: [ADR-0010](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0010-storage-port-strategy.md) (storage ports), [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)
- Example: [`examples/sqlite-resume`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/sqlite-resume) — a durable run suspends in one process and a new process resumes it from the file

## Install

```bash
npm install @oribos/sqlite @oribos/core
```

`@oribos/core` is a peer dependency (one core instance by design). `@oribos/sqlite` has no other
runtime dependency. Requires Node **`>=22.13.0`** — the flag-free floor of `node:sqlite`
(experimental, release candidate since Node 25.7; Bun / Deno / Workers stubs are not a promise).

## Lifecycle

`createSqliteStorage()` touches nothing until `init()`. `path` is a file path or `':memory:'`,
handed to `DatabaseSync` as-is; one connection per instance, never a pool, never exposed — for raw
SQL, open your own connection on the same path (WAL makes that safe). `init()` is idempotent
(open + `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, busy timeout + migrations) and
`close()` is idempotent (a no-op before `init()`, refused by `init()` afterwards). The underlying
driver is synchronous, so both are plain `void` methods — `await storage.init()` from older docs
still resolves immediately. Calling any port method before `init()` throws `call init() first`;
after `close()` it throws `storage is closed`. The core never calls the lifecycle for you.

`busyTimeoutMs` (default `5_000`) is how long a locked write waits. It is set with
`PRAGMA busy_timeout` because the `DatabaseSync` constructor's `timeout` option is silently ignored
on Node 22.13 (it landed in 22.16); on newer Nodes both hold the same value.

## Schema and migrations

Six `STRICT` tables, three indexes, nothing else: `threads`, `messages`, `resources`,
`workflow_snapshots`, `agent_run_snapshots`, `schedules`. `Date` values cross as `INTEGER` unix
milliseconds, optional fields absent are SQL `NULL` and come back as omitted keys, and JSON columns
are text — `NULL` (no value) and `'null'` (a stored JSON `null`) are strictly distinct. Snapshots
are payload-only (`status` is read out of the payload with `json_extract`) plus a storage-side
`updated_at` that serves list ordering, cursors and retention only — never the record shape, never
CAS.

Migrations are forward-only and additive-only, an ordered `{ version, up }` list inside the package
— no migration table, `PRAGMA user_version` is the ledger, all applied in one transaction. A
database whose `user_version` is ahead of the package refuses to open (no downgrades).

## Extensions

All four ports' declared extensions are implemented, with the signatures frozen by the storage
spec; the package exports the extended interfaces (`SqliteWorkflowSnapshotStore`,
`SqliteAgentRunSnapshotStore`).

`compareAndSave(runId, snapshot, expected)` is the cross-process resume de-duplication premise —
the caller supplies `expected`, and exactly one racing writer wins:

```ts
const expected = await storage.workflowSnapshots.load(runId);   // what this instance last saw
const won = await storage.workflowSnapshots.compareAndSave(runId, next, expected);
if (!won) { /* another instance moved the run; reload and recompute */ }
```

`expected === null` means "this run has no snapshot yet" (an insert that does nothing on conflict);
otherwise the write happens only when the stored payload matches, as one conditional statement with
its `changes()` readback — no explicit transaction, no version counters, no hash columns. The
comparison is serializer output (`JSON.stringify`, the same function `save` uses), so **`expected`
must come from this adapter's `load`**: a hand-built equal-shaped object with a different key order
compares false by design.

`deleteSnapshot(runId)` is retention cleanup (absent = no-op) on both snapshot ports;
`listSnapshots({ status?, limit?, before? })` and `listSuspended({ limit?, before? })` enumerate
newest-write-first (run id as tie-break) with a run-id cursor — a dangling cursor or a
non-positive / fractional `limit` throws.

## Concurrency and durability

`WAL` + busy timeout is the multi-process story: writers serialize, readers don't block. A single
port call is atomic by itself; multi-statement units (the `saveMessages` batch, migrations) run in
an explicit `BEGIN IMMEDIATE … COMMIT`. There is no lease, claim or retry layer — `SQLITE_BUSY`
surfaces unchanged and retry policy belongs to the deployment. Cross-process resume de-duplication
is only correct when the caller uses `compareAndSave`; `':memory:'` databases are per-connection
(testing and single-process only).

## Install only what you use

- dependencies: none — the driver is built into Node, so there is no `deps-budget.json` to watch
- first-party code: the minified baseline is recorded in `byte-budget.json` and checked on every
  PR — a warning, not a merge gate or a public budget
- `@oribos/core` stays a peer, so there is exactly one core instance

## License

[Apache-2.0](https://github.com/0xnicholas/oribos-framework/blob/main/LICENSE)
