/**
 * `AgentRunSnapshotStore` and its extensions: whole-record JSON round-trips (message lists and
 * suspend payloads included), latest-only replacement, `deleteSnapshot`, and `listSuspended`'s
 * newest-first ordering / cursor / limit. The port has no CAS by design (`harness.md`
 * 「AgentRunSnapshotStore」) — there is nothing to race here, so nothing is tested for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSnapshot } from '@oribos/core/durable-agent';
import { caught, memoryStorage, messageOf } from './helpers.js';

/** A suspended run's snapshot: message list, step count, held calls, trace. */
function snapshot(runId: string, marker = 0): AgentRunSnapshot {
  return {
    runId,
    status: 'suspended',
    messages: [
      { role: 'user', content: [{ type: 'text', text: `refund order ${runId}` }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Issuing the refund.' },
          { type: 'tool-call', toolCallId: `call-${marker}`, toolName: 'issueRefund', input: { amount: 129 } },
        ],
      },
    ],
    stepCount: marker,
    suspendPayload: {
      toolCalls: [
        { type: 'tool-call', toolCallId: `call-${marker}`, toolName: 'issueRefund', input: { amount: 129 } },
      ],
      awaitingApproval: [`call-${marker}`],
    },
    traceId: 'b'.repeat(32),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agent run snapshots', () => {
  it('returns null when absent, round-trips the whole record and replaces it on save', async () => {
    const storage = memoryStorage();
    expect(await storage.agentRunSnapshots.load('none')).toBeNull();

    await storage.agentRunSnapshots.save('run-1', snapshot('run-1', 1));
    expect(await storage.agentRunSnapshots.load('run-1')).toEqual(snapshot('run-1', 1));

    await storage.agentRunSnapshots.save('run-1', snapshot('run-1', 2));
    expect(await storage.agentRunSnapshots.load('run-1')).toEqual(snapshot('run-1', 2));
  });

  it('deletes one snapshot and treats an absent id as a no-op', async () => {
    const storage = memoryStorage();
    await storage.agentRunSnapshots.save('run-1', snapshot('run-1'));
    await storage.agentRunSnapshots.deleteSnapshot('run-1');
    await storage.agentRunSnapshots.deleteSnapshot('run-1');
    expect(await storage.agentRunSnapshots.load('run-1')).toBeNull();
  });

  it('lists suspended runs newest-write-first with a run-id cursor and limit', async () => {
    const storage = memoryStorage();
    const writes: ReadonlyArray<readonly [string, number]> = [
      ['a', 1_000],
      ['b', 2_000],
      ['c', 3_000],
      ['d', 3_000],
    ];
    vi.useFakeTimers();
    for (const [runId, at] of writes) {
      vi.setSystemTime(at);
      await storage.agentRunSnapshots.save(runId, snapshot(runId));
    }
    vi.useRealTimers();

    expect((await storage.agentRunSnapshots.listSuspended()).map((s) => s.runId)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ]);
    expect((await storage.agentRunSnapshots.listSuspended({ limit: 2 })).map((s) => s.runId)).toEqual([
      'd',
      'c',
    ]);
    expect(
      (await storage.agentRunSnapshots.listSuspended({ before: 'c' })).map((s) => s.runId),
    ).toEqual(['b', 'a']);

    expect(
      messageOf(await caught(storage.agentRunSnapshots.listSuspended({ before: 'ghost' }))),
    ).toBe(
      "agentRunSnapshots.listSuspended: before cursor 'ghost' is not a snapshot in this store",
    );
    expect(
      messageOf(await caught(storage.agentRunSnapshots.listSuspended({ limit: 0 }))),
    ).toBe('agentRunSnapshots.listSuspended: limit must be a positive integer, got 0');
  });
});
