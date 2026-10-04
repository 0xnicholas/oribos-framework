/**
 * `ScheduleStore` behavior, mirroring the in-memory reference (`core/src/schedules/in-memory-store.ts`):
 * soonest-first listing with exhausted records last and the id tie-break, the sentinel cursor that
 * pages through the null tail, `listDue`'s enabled/`<= now` filter, upserts, and the record's
 * optional fields (`timezone` a plain string column, `metadata` JSON, absence = omitted on read).
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleRecord } from '@oribos/core/schedules';
import type { SqliteStorage } from '@oribos/sqlite';
import { caught, memoryStorage, messageOf } from './helpers.js';

function record(
  id: string,
  nextFireAt: number | null,
  options: { enabled?: boolean; timezone?: string; metadata?: Record<string, unknown> } = {},
): ScheduleRecord {
  return {
    id,
    nextFireAt,
    target: { agent: `agent-${id}`, input: `run ${id}` },
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    enabled: options.enabled ?? true,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/** Soonest first; two records share a timestamp, two are exhausted (`null`). */
async function seed(storage: SqliteStorage): Promise<void> {
  await storage.schedules.save(record('s100a', 100));
  await storage.schedules.save(record('s100b', 100));
  await storage.schedules.save(record('s50', 50));
  await storage.schedules.save(record('s300', 300));
  await storage.schedules.save(record('n1', null));
  await storage.schedules.save(record('n2', null));
}

describe('schedules records', () => {
  it('round-trips both target forms, the optional fields and the disabled flag', async () => {
    const storage = memoryStorage();
    expect(await storage.schedules.get('none')).toBeNull();

    const agentRecord: ScheduleRecord = {
      id: 'agent',
      nextFireAt: 1_700_000_000_000,
      target: { agent: 'reporter', input: 'write the daily report' },
      timezone: 'Asia/Shanghai',
      enabled: true,
      metadata: { nested: { attempt: 2 }, tags: ['a', 'b'] },
    };
    const signalRecord: ScheduleRecord = {
      id: 'signal',
      nextFireAt: null,
      target: {
        thread: 'th1',
        resource: 'r1',
        payload: { type: 'reminder', note: 'ping the customer' },
      },
      enabled: false,
    };
    await storage.schedules.save(agentRecord);
    await storage.schedules.save(signalRecord);

    expect(await storage.schedules.get('agent')).toEqual(agentRecord);
    expect(await storage.schedules.get('signal')).toEqual(signalRecord);
  });

  it('omits optional fields that were absent', async () => {
    const storage = memoryStorage();
    await storage.schedules.save(record('bare', 100));
    const loaded = await storage.schedules.get('bare');
    expect(Object.hasOwn(loaded as ScheduleRecord, 'timezone')).toBe(false);
    expect(Object.hasOwn(loaded as ScheduleRecord, 'metadata')).toBe(false);
  });

  it('upserts by id and treats deleting an absent id as a no-op', async () => {
    const storage = memoryStorage();
    await storage.schedules.save(record('s', 100, { enabled: true }));
    await storage.schedules.save(record('s', null, { enabled: false, timezone: 'UTC' }));
    expect(await storage.schedules.get('s')).toEqual(record('s', null, { enabled: false, timezone: 'UTC' }));

    await storage.schedules.delete('s');
    await storage.schedules.delete('s');
    expect(await storage.schedules.get('s')).toBeNull();
  });
});

describe('schedules listing', () => {
  it('orders soonest-first with exhausted records last and the id tie-break', async () => {
    const storage = memoryStorage();
    await seed(storage);
    expect((await storage.schedules.list()).map((s) => s.id)).toEqual([
      's50',
      's100a',
      's100b',
      's300',
      'n1',
      'n2',
    ]);
  });

  it('anchors limit at the head of the order and pages with the cursor into the null tail', async () => {
    const storage = memoryStorage();
    await seed(storage);

    expect((await storage.schedules.list({ limit: 3 })).map((s) => s.id)).toEqual([
      's50',
      's100a',
      's100b',
    ]);
    expect((await storage.schedules.list({ before: 's100a' })).map((s) => s.id)).toEqual([
      's100b',
      's300',
      'n1',
      'n2',
    ]);
    expect((await storage.schedules.list({ before: 'n1' })).map((s) => s.id)).toEqual(['n2']);
    expect((await storage.schedules.list({ before: 's100a', limit: 2 })).map((s) => s.id)).toEqual([
      's100b',
      's300',
    ]);
  });

  it('throws on a dangling cursor and a non-positive or fractional limit', async () => {
    const storage = memoryStorage();
    await seed(storage);
    expect(messageOf(await caught(storage.schedules.list({ before: 'nope' })))).toBe(
      "schedules.list: before cursor 'nope' is not a schedule in this store",
    );
    for (const limit of [0, -1, 2.5]) {
      expect(messageOf(await caught(storage.schedules.list({ limit })))).toBe(
        `schedules.list: limit must be a positive integer, got ${limit}`,
      );
    }
  });

  it('listDue returns enabled, non-exhausted records at or before now, soonest first', async () => {
    const storage = memoryStorage();
    await seed(storage);
    await storage.schedules.save(record('disabled-due', 150, { enabled: false }));
    await storage.schedules.save(record('due-edge', 200));
    await storage.schedules.save(record('future', 201));

    expect((await storage.schedules.listDue(new Date(200))).map((s) => s.id)).toEqual([
      's50',
      's100a',
      's100b',
      'due-edge',
    ]);
    expect((await storage.schedules.listDue(new Date(0))).map((s) => s.id)).toEqual([]);
  });
});
