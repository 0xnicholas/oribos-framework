import type { Agent } from '../agent/agent.js';
import { assertMemoryTarget } from '../memory/identity.js';
import type { Signals } from '../signals/index.js';
import { createInMemoryScheduleStore } from './in-memory-store.js';
import type { ScheduleStore } from './store.js';
import type { ScheduleRecord, ScheduleSaveInput, ScheduleTarget } from './types.js';

/**
 * The schedules subsystem: the record CRUD + `tick`
 * primitive. A schedule pairs a JSON-only record — persisted through the `ScheduleStore` port — with
 * the occurrence function that computes its `nextFireAt`; the function is registered in-process by
 * `save` (cron parsing is injected this way, so the core needs no cron dependency).
 *
 * `tick` is the whole runtime: list the due records, fire each target, advance `nextFireAt` from the
 * tick's `now`. Nothing here requires a long-lived process — a platform cron hitting an endpoint
 * that calls `tick` is the first-class shape; `startTicker` is the optional in-process convenience
 * (single-process semantics: one process, no CAS, no lease — multi-instance safety is the
 * deployer's, exactly as the spec rules it).
 */

/** The `createSchedules` config. */
export interface SchedulesConfig {
  /** The records' storage; absent = the core's in-memory default (this process only). */
  readonly storage?: ScheduleStore;
  /**
   * The agents threadless targets may name (`ScheduleAgentTarget.agent`): the target runs
   * `agents[name].generate(input)`. `save` rejects a name that is not registered here.
   */
  readonly agents: Readonly<Record<string, Agent>>;
  /**
   * The signals instance threaded targets ride (`ScheduleSignalTarget`). Required to save a threaded
   * target at all; the trigger then injects exactly as any other signal — wake the idle thread, or
   * inject into the active run (signals).
   */
  readonly signals?: Signals;
}

/** The `tick` options. */
export interface ScheduleTickOptions {
  /** The instant the tick is due-checked and advanced against; absent = `new Date()`. */
  readonly now?: Date;
}

/** The `startTicker` options. */
export interface ScheduleTickerOptions {
  /** Delay between beats, milliseconds (positive; `setInterval` semantics). */
  readonly intervalMs: number;
}

/** A running in-process ticker (see `Schedules.startTicker`); `stop()` is idempotent. */
export interface ScheduleTicker {
  /** Stop the beats. */
  stop(): void;
}

/** The schedules entry object. */
export interface Schedules {
  /**
   * Upserts one schedule: validates the target, mints `id` when absent, computes
   * `nextFireAt = next(now)`, registers `next` in-process under the id (replacing a previous
   * registration), persists the record and returns it. Re-saving an id re-anchors `nextFireAt` at
   * now — the definition just saved is authoritative, which is what re-registering schedules at
   * boot wants.
   */
  save(input: ScheduleSaveInput): Promise<ScheduleRecord>;
  /**
   * One tick: every due record (enabled, next occurrence at or before `now`) fires in order —
   * threadless through `agent.generate`, threaded through `signals.sendSignal` — and its
   * `nextFireAt` advances to `next(now)`. A target failure never rejects the tick: it is caught,
   * and the record advances anyway (the occurrence is spent, exactly as a failed platform-cron
   * invocation is; the run's own trace carries the failure). A due record with no in-process `next`
   * registration is skipped — it cannot be rescheduled, so firing it would repeat on every tick.
   * No catch-up: a late tick fires each due record once and schedules it after `now`; occurrences
   * the delay skipped are not replayed.
   */
  tick(options?: ScheduleTickOptions): Promise<void>;
  /**
   * Starts an in-process ticker: one `tick()` per `intervalMs` (the first beat after one interval,
   * not at start), single-process semantics. A beat whose previous tick is still running is skipped
   * — a slow trigger never stacks. Beat errors are swallowed (call `tick()` directly to observe
   * them): the convenient form exists for hosts that would otherwise forget a `.catch`.
   */
  startTicker(options: ScheduleTickerOptions): ScheduleTicker;
}

/**
 * Creates the schedules entry object. See `Schedules` for the per-method semantics.
 */
export function createSchedules(config: SchedulesConfig): Schedules {
  const { agents, signals } = config;
  const storage = config.storage ?? createInMemoryScheduleStore();
  /** id → the occurrence function registered by `save` (functions never enter the store). */
  const occurrences = new Map<string, ScheduleSaveInput['next']>();

  /** Fail-fast target validation at `save`: the two forms' requirements, before anything is written. */
  function assertTarget(target: ScheduleTarget): void {
    if ('thread' in target) {
      assertMemoryTarget(
        'schedules',
        target,
        'pass { thread, resource, payload } with both fields.',
      );
      if (signals === undefined) {
        throw new Error(
          'schedules: a threaded target requires a signals instance — pass createSchedules({ signals }).',
        );
      }
      return;
    }
    if (typeof target.agent !== 'string' || agents[target.agent] === undefined) {
      throw new Error(
        `schedules: target agent '${target.agent}' is not registered — pass it in createSchedules({ agents }).`,
      );
    }
  }

  /** Fires one target (the two forms of `ScheduleTarget`). */
  async function fire(target: ScheduleTarget): Promise<void> {
    if ('thread' in target) {
      // A record loaded from a foreign store may still carry a threaded target while this instance
      // has no signals; `save` already rejected that combination for records saved here.
      if (signals === undefined) {
        throw new Error('schedules: a threaded target requires a signals instance.');
      }
      await signals.sendSignal({ thread: target.thread, resource: target.resource }, target.payload);
      return;
    }
    const agent = agents[target.agent];
    if (agent === undefined) {
      throw new Error(`schedules: target agent '${target.agent}' is not registered.`);
    }
    await agent.generate(target.input);
  }

  async function tick(options: ScheduleTickOptions = {}): Promise<void> {
    const now = options.now ?? new Date();
    const due = await storage.listDue(now);
    for (const record of due) {
      const occurrence = occurrences.get(record.id);
      if (occurrence === undefined) continue;
      try {
        await fire(record.target);
      } catch {
        // Documented: the occurrence is spent either way; the run's own trace is the failure's
        // visibility, and a broken target must not wedge the schedule (or the rest of the tick).
      }
      const advanced = occurrence(now);
      await storage.save({ ...record, nextFireAt: advanced === null ? null : advanced.getTime() });
    }
  }

  function startTicker({ intervalMs }: ScheduleTickerOptions): ScheduleTicker {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `schedules.startTicker: intervalMs must be a positive number, got ${intervalMs}.`,
      );
    }
    let beating = false;
    const handle = setInterval(() => {
      if (beating) return;
      beating = true;
      void (async () => {
        try {
          await tick();
        } catch {
          // Documented: the convenient form cannot hand its error to anyone (nothing awaits a beat);
          // `tick()` called directly is where a rejected beat is observed.
        } finally {
          beating = false;
        }
      })();
    }, intervalMs);
    return {
      stop: () => {
        clearInterval(handle);
      },
    };
  }

  return {
    async save(input) {
      assertTarget(input.target);
      const id = input.id ?? crypto.randomUUID();
      const occurrence = input.next(new Date());
      if (occurrence !== null && Number.isNaN(occurrence.getTime())) {
        throw new Error(
          'schedules.save: next() returned an invalid Date — return a valid Date or null.',
        );
      }
      occurrences.set(id, input.next);
      const record: ScheduleRecord = {
        id,
        nextFireAt: occurrence === null ? null : occurrence.getTime(),
        target: input.target,
        enabled: input.enabled ?? true,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      await storage.save(record);
      return record;
    },
    tick,
    startTicker,
  };
}
