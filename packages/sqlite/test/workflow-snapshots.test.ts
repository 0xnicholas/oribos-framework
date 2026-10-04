/**
 * `WorkflowSnapshotStore` and its full extension face: whole-record JSON round-trips, latest-only
 * replacement, `compareAndSave`'s conditional single-statement semantics (including the documented
 * caveat that `expected` must come from this adapter's `load` — the comparison is the serializer's
 * output, so key order matters), `deleteSnapshot`, and `listSnapshots`' storage-side ordering /
 * cursor / `json_extract` status filter. Write times are pinned with fake timers so ordering is
 * deterministic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunSnapshot } from '@oribos/core/workflows';
import type { SqliteStorage } from '@oribos/sqlite';
import { caught, memoryStorage, messageOf } from './helpers.js';

/** A snapshot with the shape's full nesting: `unknown` payloads, iteration site, trace. */
function snapshot(runId: string, status: WorkflowRunSnapshot['status'], marker = 0): WorkflowRunSnapshot {
  return {
    runId,
    status,
    input: { order: { id: runId, lines: [1, 2, { nested: true }] } },
    stepResults: {
      prepare: { status: 'success', output: { marker }, startedAt: 1, endedAt: 2 },
      approve: { status: 'suspended', suspendPayload: { reason: 'human', marker } },
    },
    position: 1,
    iterationSite: { kind: 'foreach', suspendedIndex: 2, collected: { 0: 'done', 2: 'pending' } },
    traceId: 'a'.repeat(32),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('workflow snapshots: save / load / delete', () => {
  it('returns null when absent and round-trips the whole JSON record', async () => {
    const storage = memoryStorage();
    expect(await storage.workflowSnapshots.load('none')).toBeNull();

    const stored = snapshot('run-1', 'suspended');
    await storage.workflowSnapshots.save('run-1', stored);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(stored);
  });

  it('keeps only the latest snapshot per run', async () => {
    const storage = memoryStorage();
    await storage.workflowSnapshots.save('run-1', snapshot('run-1', 'running', 1));
    await storage.workflowSnapshots.save('run-1', snapshot('run-1', 'success', 2));
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(
      snapshot('run-1', 'success', 2),
    );
  });

  it('deletes one snapshot and treats an absent id as a no-op', async () => {
    const storage = memoryStorage();
    await storage.workflowSnapshots.save('run-1', snapshot('run-1', 'suspended'));
    await storage.workflowSnapshots.deleteSnapshot('run-1');
    await storage.workflowSnapshots.deleteSnapshot('run-1');
    expect(await storage.workflowSnapshots.load('run-1')).toBeNull();
  });
});

describe('workflow snapshots: compareAndSave', () => {
  it('inserts against expected null only while the run has no snapshot', async () => {
    const storage = memoryStorage();
    expect(await storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 'running', 1), null)).toBe(true);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(snapshot('run-1', 'running', 1));

    expect(await storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 'failed', 2), null)).toBe(false);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(snapshot('run-1', 'running', 1));
  });

  it('updates only when the stored payload matches the expected snapshot (never exists -> false)', async () => {
    const storage = memoryStorage();
    const first = snapshot('run-1', 'running', 1);
    const second = snapshot('run-1', 'suspended', 2);
    await storage.workflowSnapshots.save('run-1', first);

    const expected = await storage.workflowSnapshots.load('run-1');
    expect(await storage.workflowSnapshots.compareAndSave('run-1', second, expected)).toBe(true);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(second);

    // The stale writer loses: `first` is what it loaded, the store now holds `second`.
    expect(await storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 'success', 3), first)).toBe(false);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(second);

    expect(await storage.workflowSnapshots.compareAndSave('ghost', second, second)).toBe(false);
  });

  it('compares serializer output, so a hand-built record with different key order loses by design', async () => {
    const storage = memoryStorage();
    const stored: WorkflowRunSnapshot = {
      runId: 'run-1',
      status: 'running',
      input: null,
      stepResults: {},
      position: 0,
    };
    await storage.workflowSnapshots.save('run-1', stored);

    const reordered: WorkflowRunSnapshot = {
      position: 0,
      stepResults: {},
      input: null,
      status: 'running',
      runId: 'run-1',
    };
    expect(
      await storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 'success'), reordered),
    ).toBe(false);
    expect(await storage.workflowSnapshots.load('run-1')).toEqual(stored);
  });
});

describe('workflow snapshots: listSnapshots', () => {
  const WRITE_TIMES: ReadonlyArray<readonly [string, WorkflowRunSnapshot['status'], number]> = [
    ['a', 'suspended', 1_000],
    ['b', 'success', 2_000],
    ['c', 'suspended', 3_000],
    ['d', 'failed', 3_000],
  ];

  async function seed(storage: SqliteStorage): Promise<void> {
    vi.useFakeTimers();
    for (const [runId, status, at] of WRITE_TIMES) {
      vi.setSystemTime(at);
      await storage.workflowSnapshots.save(runId, snapshot(runId, status));
    }
    vi.useRealTimers();
  }

  it('lists newest-write-first (run id tie-break), filtered by the payload status', async () => {
    const storage = memoryStorage();
    await seed(storage);

    expect((await storage.workflowSnapshots.listSnapshots()).map((s) => s.runId)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ]);
    expect(
      (await storage.workflowSnapshots.listSnapshots({ status: 'suspended' })).map((s) => s.runId),
    ).toEqual(['c', 'a']);
  });

  it('pages with the run-id cursor and validates limit and cursor', async () => {
    const storage = memoryStorage();
    await seed(storage);

    expect(
      (await storage.workflowSnapshots.listSnapshots({ limit: 2 })).map((s) => s.runId),
    ).toEqual(['d', 'c']);
    expect(
      (await storage.workflowSnapshots.listSnapshots({ before: 'b' })).map((s) => s.runId),
    ).toEqual(['a']);
    expect(
      (await storage.workflowSnapshots.listSnapshots({ status: 'suspended', before: 'c' })).map(
        (s) => s.runId,
      ),
    ).toEqual(['a']);

    expect(
      messageOf(await caught(storage.workflowSnapshots.listSnapshots({ before: 'ghost' }))),
    ).toBe(
      "workflowSnapshots.listSnapshots: before cursor 'ghost' is not a snapshot in this store",
    );
    for (const limit of [0, -3, 1.5]) {
      expect(
        messageOf(await caught(storage.workflowSnapshots.listSnapshots({ limit }))),
        `limit ${limit}`,
      ).toBe(`workflowSnapshots.listSnapshots: limit must be a positive integer, got ${limit}`);
    }
  });
});
