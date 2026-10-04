/**
 * The two snapshot ports and their full extension face (every extension method implemented, its
 * signature frozen): `save` writes the whole snapshot as one JSON payload plus a
 * storage-side `updated_at` (write moment, list ordering / cursors only — never the record shape,
 * never CAS), `load` parses the payload back.
 *
 * `compareAndSave` is the cross-process de-duplication premise: one conditional statement, its
 * `changes()` readback deciding, no explicit transaction. The comparison is string equality against
 * the serializer `save` uses (`JSON.stringify`), so `expected` **must come from this adapter's
 * `load`** — a hand-built equal-shaped object with a different key order compares false by design
 * (documented in the README; no version counters or hash columns exist).
 *
 * `list*` never projects `status`: the workflow snapshot status is read out of the payload with
 * `json_extract` (columns a record already implies are not stored), ordering is
 * newest-suspended-first and the cursor is a
 * run id.
 */
import type { AgentRunSnapshot, AgentRunSnapshotStore } from '@oribos/core/durable-agent';
import type {
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import type { SqliteLifecycle } from './connection.js';
import { assertPageLimit, loadCursorRow } from './connection.js';

/** `WorkflowSnapshotStore` with every declared extension implemented (all of them are frozen). */
export interface SqliteWorkflowSnapshotStore extends WorkflowSnapshotStore {
  /** Conditional write: `expected === null` inserts only if the run has no snapshot; else updates only if the payload matches. */
  compareAndSave(
    runId: string,
    snapshot: WorkflowRunSnapshot,
    expected: WorkflowRunSnapshot | null,
  ): Promise<boolean>;
  /** Retention cleanup: delete one snapshot; absent is a no-op. */
  deleteSnapshot(runId: string): Promise<void>;
  /** Enumerate newest-first (by storage write time, run id as tie-break), optionally by run status. */
  listSnapshots(query?: {
    status?: WorkflowRunStatus;
    limit?: number;
    before?: string;
  }): Promise<WorkflowRunSnapshot[]>;
}

/** `AgentRunSnapshotStore` with every declared extension implemented. */
export interface SqliteAgentRunSnapshotStore extends AgentRunSnapshotStore {
  /** Retention cleanup: delete one snapshot; absent is a no-op. */
  deleteSnapshot(runId: string): Promise<void>;
  /** Enumerate suspended runs, newest-suspended first (by storage write time, run id as tie-break). */
  listSuspended(query?: { limit?: number; before?: string }): Promise<AgentRunSnapshot[]>;
}

interface SnapshotRow {
  run_id: string;
  payload: string;
  updated_at: number;
}

interface CursorRow {
  run_id: string;
  updated_at: number;
}

/** `before` is a run id: the page continues strictly past the referenced snapshot's `(updated_at, run_id)`. */
function cursorClause(hasCursor: boolean): string {
  return hasCursor ? ' AND (updated_at, run_id) < (?, ?)' : '';
}

/** The one serializer both `save` and `compareAndSave` use — the CAS comparison strings must match. */
function serialize(snapshot: { readonly runId: string }): string {
  return JSON.stringify(snapshot);
}

export function createWorkflowSnapshotStore(
  lifecycle: SqliteLifecycle,
): SqliteWorkflowSnapshotStore {
  return {
    async load(runId) {
      const db = lifecycle.open();
      const row = db
        .prepare('SELECT payload FROM workflow_snapshots WHERE run_id = ?')
        .get(runId) as Pick<SnapshotRow, 'payload'> | undefined;
      return row === undefined ? null : (JSON.parse(row.payload) as WorkflowRunSnapshot);
    },

    async save(runId, snapshot) {
      const db = lifecycle.open();
      db.prepare(
        `INSERT INTO workflow_snapshots (run_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           payload = excluded.payload, updated_at = excluded.updated_at`,
      ).run(runId, serialize(snapshot), Date.now());
    },

    async compareAndSave(runId, snapshot, expected) {
      const db = lifecycle.open();
      const payload = serialize(snapshot);
      if (expected === null) {
        const result = db
          .prepare(
            `INSERT INTO workflow_snapshots (run_id, payload, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(run_id) DO NOTHING`,
          )
          .run(runId, payload, Date.now());
        return Number(result.changes) === 1;
      }
      const result = db
        .prepare(
          'UPDATE workflow_snapshots SET payload = ?, updated_at = ? WHERE run_id = ? AND payload = ?',
        )
        .run(payload, Date.now(), runId, serialize(expected));
      return Number(result.changes) === 1;
    },

    async deleteSnapshot(runId) {
      const db = lifecycle.open();
      db.prepare('DELETE FROM workflow_snapshots WHERE run_id = ?').run(runId);
    },

    async listSnapshots(query = {}) {
      const db = lifecycle.open();
      assertPageLimit('workflowSnapshots.listSnapshots', query.limit);
      const cursor =
        query.before === undefined
          ? undefined
          : loadCursorRow<CursorRow>(db, {
              caller: 'workflowSnapshots.listSnapshots',
              noun: 'snapshot',
              sql: 'SELECT run_id, updated_at FROM workflow_snapshots WHERE run_id = ?',
              before: query.before,
            });
      // No `status` column: the record's own JSON answers, exactly as the spec pins it.
      const statusClause =
        query.status === undefined ? '' : " AND json_extract(payload, '$.status') = ?";
      const limitClause = query.limit === undefined ? '' : ' LIMIT ?';
      const rows = db
        .prepare(
          `SELECT payload FROM workflow_snapshots
           WHERE 1 = 1${statusClause}${cursorClause(cursor !== undefined)}
           ORDER BY updated_at DESC, run_id DESC${limitClause}`,
        )
        .all(
          ...(query.status === undefined ? [] : [query.status]),
          ...(cursor === undefined ? [] : [cursor.updated_at, cursor.run_id]),
          ...(query.limit === undefined ? [] : [query.limit]),
        ) as Array<Pick<SnapshotRow, 'payload'>>;
      return rows.map((row) => JSON.parse(row.payload) as WorkflowRunSnapshot);
    },
  };
}

export function createAgentRunSnapshotStore(
  lifecycle: SqliteLifecycle,
): SqliteAgentRunSnapshotStore {
  return {
    async load(runId) {
      const db = lifecycle.open();
      const row = db
        .prepare('SELECT payload FROM agent_run_snapshots WHERE run_id = ?')
        .get(runId) as Pick<SnapshotRow, 'payload'> | undefined;
      return row === undefined ? null : (JSON.parse(row.payload) as AgentRunSnapshot);
    },

    async save(runId, snapshot) {
      const db = lifecycle.open();
      db.prepare(
        `INSERT INTO agent_run_snapshots (run_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           payload = excluded.payload, updated_at = excluded.updated_at`,
      ).run(runId, serialize(snapshot), Date.now());
    },

    async deleteSnapshot(runId) {
      const db = lifecycle.open();
      db.prepare('DELETE FROM agent_run_snapshots WHERE run_id = ?').run(runId);
    },

    async listSuspended(query = {}) {
      const db = lifecycle.open();
      assertPageLimit('agentRunSnapshots.listSuspended', query.limit);
      const cursor =
        query.before === undefined
          ? undefined
          : loadCursorRow<CursorRow>(db, {
              caller: 'agentRunSnapshots.listSuspended',
              noun: 'snapshot',
              sql: 'SELECT run_id, updated_at FROM agent_run_snapshots WHERE run_id = ?',
              before: query.before,
            });
      const limitClause = query.limit === undefined ? '' : ' LIMIT ?';
      const rows = db
        .prepare(
          `SELECT payload FROM agent_run_snapshots
           WHERE 1 = 1${cursorClause(cursor !== undefined)}
           ORDER BY updated_at DESC, run_id DESC${limitClause}`,
        )
        .all(
          ...(cursor === undefined ? [] : [cursor.updated_at, cursor.run_id]),
          ...(query.limit === undefined ? [] : [query.limit]),
        ) as Array<Pick<SnapshotRow, 'payload'>>;
      return rows.map((row) => JSON.parse(row.payload) as AgentRunSnapshot);
    },
  };
}
