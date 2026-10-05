/**
 * The wiring this package exists for (`docs/architecture/harness.md`「croner 封装能力包」): a
 * `cron()` fragment spreads into `schedules.save()`, `nextFireAt` is computed through croner's
 * `next`, and `tick` fires the target and advances the occurrence. Asserted against `@oribos/core`'s
 * public entries (a devDependency, deliberately not a peer): a drift in `ScheduleSaveInput` /
 * `save` / `tick` — or in `Agent.generate`, which a fired threadless target calls — surfaces here,
 * at typecheck or at runtime.
 */
import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { ModelCallOptions } from '@oribos/core/model';
import { createInMemoryScheduleStore, createSchedules } from '@oribos/core/schedules';
import { cron } from '@oribos/croner';
import { fakeModel } from '@oribos/testing';
import type { FakeModel } from '@oribos/testing';

const REPORT = 'Daily report: 3 orders open.';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The user text a captured model call was handed. */
function userText(call: ModelCallOptions): string {
  return call.prompt
    .filter((message) => message.role === 'user')
    .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

/** A real reporting agent over the canonical scripted model (`@oribos/testing`) — the target `tick` fires. */
function reporter(): { agent: Agent; model: FakeModel } {
  const model = fakeModel([{ text: REPORT, usage: { inputTokens: 8, outputTokens: 6 } }], {
    provider: 'example',
    modelId: 'scripted-mini',
  });
  return {
    agent: new Agent({ name: 'reporter', instructions: 'Report.', model }),
    model,
  };
}

describe('save → tick, with the occurrence function built by croner', () => {
  it('computes nextFireAt through next, then fires at due time and advances', async () => {
    const storage = createInMemoryScheduleStore();
    const { agent, model } = reporter();
    const schedules = createSchedules({ storage, agents: { reporter: agent } });

    const saved = await schedules.save({
      id: 'daily-report',
      ...cron('0 9 * * *', { timezone: 'Asia/Shanghai' }),
      target: { agent: 'reporter', input: 'write the daily report' },
    });

    // 09:00 Asia/Shanghai is 01:00 UTC (Shanghai has no DST) — an independent expectation of the
    // occurrence the fragment computed.
    expect(saved.nextFireAt).not.toBeNull();
    expect(saved.timezone).toBe('Asia/Shanghai');
    const occurrence = new Date(saved.nextFireAt!);
    expect([
      occurrence.getUTCHours(),
      occurrence.getUTCMinutes(),
      occurrence.getUTCSeconds(),
      occurrence.getUTCMilliseconds(),
    ]).toEqual([1, 0, 0, 0]);

    // The record persists exactly the record fields — the expression stays host-side.
    expect(await storage.get('daily-report')).toEqual({
      id: 'daily-report',
      nextFireAt: saved.nextFireAt,
      target: { agent: 'reporter', input: 'write the daily report' },
      timezone: 'Asia/Shanghai',
      enabled: true,
    });

    // One millisecond early: nothing fires, nothing advances.
    await schedules.tick({ now: new Date(saved.nextFireAt! - 1) });
    expect(model.streamCalls).toEqual([]);
    expect((await storage.get('daily-report'))!.nextFireAt).toBe(saved.nextFireAt);

    // At the due instant the target runs the agent — its own `generate(input)`, model call included
    // — and the occurrence re-anchors to the next 09:00: +24h, since Shanghai stays on UTC+8.
    await schedules.tick({ now: new Date(saved.nextFireAt!) });
    expect(model.streamCalls).toHaveLength(1);
    expect(userText(model.streamCalls[0]!)).toContain('write the daily report');
    expect((await storage.get('daily-report'))!.nextFireAt).toBe(saved.nextFireAt! + DAY_MS);
  });

  it('an exhausted fragment stores nextFireAt: null and never fires', async () => {
    const storage = createInMemoryScheduleStore();
    const { agent, model } = reporter();
    const schedules = createSchedules({ storage, agents: { reporter: agent } });

    const saved = await schedules.save({
      id: 'one-shot-past',
      ...cron('0 0 0 1 1 * 2020', { timezone: 'UTC' }),
      target: { agent: 'reporter', input: 'never runs' },
    });

    expect(saved.nextFireAt).toBeNull();

    await schedules.tick({ now: new Date('2030-01-01T00:00:00Z') });
    expect(model.streamCalls).toEqual([]);
  });
});
