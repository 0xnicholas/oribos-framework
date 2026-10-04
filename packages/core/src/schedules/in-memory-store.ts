import type { ScheduleListQuery, ScheduleRecord } from './types.js';
import type { ScheduleStore } from './store.js';
import { copy } from '../map-snapshot-store.js';

/**
 * The core's in-memory default `ScheduleStore` (Map-backed, zero runtime burden): a schedules
 * instance without attached storage keeps its records for this process only. It doubles as the
 * semantic reference for adapter authors — reads and writes cross the port as deep copies
 * (`structuredClone`), so stored state changes only through the port, exactly like a serializing
 * backend (which also owns the JSON-only rule this default does not check, same as the snapshot
 * stores).
 *
 * Pinned semantics (enforced by `test/schedules.test.ts`):
 * - Listing is soonest-first: `nextFireAt` ascending, `nextFireAt: null` last, `id` as tie-break.
 * - `limit` anchors at the head of that order; `before` is a cursor id — only records strictly
 *   past the referenced one are returned, and a dangling cursor is a caller bug that throws.
 * - `listDue` = enabled records with `nextFireAt !== null && nextFireAt <= now`, same order.
 */

function assertLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`schedules.list: limit must be a positive integer, got ${limit}`);
  }
}

/** Soonest-first total order: `nextFireAt` asc (exhausted records last), `id` asc as tie-break. */
function compareSchedules(a: ScheduleRecord, b: ScheduleRecord): number {
  const byTime = (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createInMemoryScheduleStore(): ScheduleStore {
  const schedules = new Map<string, ScheduleRecord>();

  return {
    save: async (schedule) => {
      schedules.set(schedule.id, copy(schedule));
    },

    get: async (id) => {
      const schedule = schedules.get(id);
      return schedule === undefined ? null : copy(schedule);
    },

    delete: async (id) => {
      schedules.delete(id);
    },

    list: async (query: ScheduleListQuery = {}) => {
      assertLimit(query.limit);
      let pool = [...schedules.values()];
      if (query.before !== undefined) {
        const cursor = schedules.get(query.before);
        if (cursor === undefined) {
          throw new Error(`schedules.list: before cursor '${query.before}' is not a schedule id`);
        }
        pool = pool.filter((schedule) => compareSchedules(schedule, cursor) > 0);
      }
      pool.sort(compareSchedules);
      const page = query.limit === undefined ? pool : pool.slice(0, query.limit);
      return page.map(copy);
    },

    listDue: async (now) => {
      const due = [...schedules.values()].filter(
        (schedule) =>
          schedule.enabled &&
          schedule.nextFireAt !== null &&
          schedule.nextFireAt <= now.getTime(),
      );
      due.sort(compareSchedules);
      return due.map(copy);
    },
  };
}
