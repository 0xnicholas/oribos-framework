/**
 * `ScheduleStore` over SQLite (the SQL shape of the queries): the in-memory
 * reference's `nextFireAt ?? Infinity` ordering is translated with a sentinel —
 * `ORDER BY (next_fire_at IS NULL) ASC, next_fire_at ASC, id ASC` for the order and
 * `(COALESCE(next_fire_at, 9223372036854775807), id) > (COALESCE(?, sentinel), ?)` for the cursor,
 * so exhausted schedules sort last and page within their own tail.
 *
 * Records are JSON text: `target` is always JSON; `timezone` is a plain string column; `metadata`
 * absent is SQL NULL and stays an absent field on the way back.
 */
import type { ScheduleListQuery, ScheduleRecord, ScheduleStore } from '@oribos/core/schedules';
import type { SqliteLifecycle } from './connection.js';
import { assertPageLimit, decodeJson, encodeJson, loadCursorRow } from './connection.js';

interface ScheduleRow {
  id: string;
  next_fire_at: number | null;
  enabled: number;
  timezone: string | null;
  target: string;
  metadata: string | null;
}

const SCHEDULE_COLUMNS = 'id, next_fire_at, enabled, timezone, target, metadata';
/** int64 max: the SQL twin of the reference's `?? Infinity`. */
const EXPLICIT_NULL_SENTINEL = '9223372036854775807';

function scheduleFromRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    nextFireAt: row.next_fire_at,
    target: decodeJson(row.target) as ScheduleRecord['target'],
    ...(row.timezone === null ? {} : { timezone: row.timezone }),
    enabled: row.enabled === 1,
    ...(row.metadata === null
      ? {}
      : { metadata: decodeJson(row.metadata) as Record<string, unknown> }),
  };
}

export function createScheduleStore(lifecycle: SqliteLifecycle): ScheduleStore {
  return {
    async save(schedule) {
      const db = lifecycle.open();
      db.prepare(
        `INSERT INTO schedules (${SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           next_fire_at = excluded.next_fire_at, enabled = excluded.enabled,
           timezone = excluded.timezone, target = excluded.target, metadata = excluded.metadata`,
      ).run(
        schedule.id,
        schedule.nextFireAt,
        schedule.enabled ? 1 : 0,
        schedule.timezone ?? null,
        JSON.stringify(schedule.target),
        encodeJson(schedule.metadata),
      );
    },

    async get(id) {
      const db = lifecycle.open();
      const row = db
        .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`)
        .get(id) as ScheduleRow | undefined;
      return row === undefined ? null : scheduleFromRow(row);
    },

    async list(query: ScheduleListQuery = {}) {
      const db = lifecycle.open();
      assertPageLimit('schedules.list', query.limit);
      const cursor =
        query.before === undefined
          ? undefined
          : loadCursorRow<ScheduleRow>(db, {
              caller: 'schedules.list',
              noun: 'schedule',
              sql: `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`,
              before: query.before,
            });
      const cursorClause =
        cursor === undefined
          ? ''
          : ` AND (COALESCE(next_fire_at, ${EXPLICIT_NULL_SENTINEL}), id) > ` +
            `(COALESCE(?, ${EXPLICIT_NULL_SENTINEL}), ?)`;
      const limitClause = query.limit === undefined ? '' : ' LIMIT ?';
      const rows = db
        .prepare(
          `SELECT ${SCHEDULE_COLUMNS} FROM schedules
           WHERE 1 = 1${cursorClause}
           ORDER BY (next_fire_at IS NULL) ASC, next_fire_at ASC, id ASC${limitClause}`,
        )
        .all(
          ...(cursor === undefined ? [] : [cursor.next_fire_at, cursor.id]),
          ...(query.limit === undefined ? [] : [query.limit]),
        ) as unknown as ScheduleRow[];
      return rows.map(scheduleFromRow);
    },

    async delete(id) {
      const db = lifecycle.open();
      db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    },

    async listDue(now) {
      const db = lifecycle.open();
      const rows = db
        .prepare(
          `SELECT ${SCHEDULE_COLUMNS} FROM schedules
           WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
           ORDER BY next_fire_at ASC, id ASC`,
        )
        .all(now.getTime()) as unknown as ScheduleRow[];
      return rows.map(scheduleFromRow);
    },
  };
}
