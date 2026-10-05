import { Agent } from './agent/agent.js';
import type { AgentConfig } from './agent/types.js';
import { createDurableAgent } from './durable-agent/durable-agent.js';
import type { DurableAgent, DurableAgentConfig } from './durable-agent/durable-agent.js';
import { createInMemoryAgentRunSnapshotStore } from './durable-agent/in-memory-snapshot-store.js';
import type { AgentRunSnapshotStore } from './durable-agent/snapshot.js';
import { createInMemoryStore } from './memory/in-memory-store.js';
import { Memory } from './memory/memory.js';
import type { MemoryStore } from './memory/store.js';
import type { Logger, Tracer } from './observability/index.js';
import { createInMemoryScheduleStore } from './schedules/in-memory-store.js';
import { createSchedules } from './schedules/schedules.js';
import type { Schedules, SchedulesConfig } from './schedules/schedules.js';
import type { ScheduleStore } from './schedules/store.js';
import { createSignals } from './signals/signals.js';
import type { Signals, SignalsConfig } from './signals/signals.js';
import type { StandardSchema } from './standard-schema.js';
import { createInMemorySnapshotStore } from './workflows/in-memory-snapshot-store.js';
import type { WorkflowSnapshotStore } from './workflows/snapshot.js';
import { createWorkflow } from './workflows/workflow.js';
import type { WorkflowBuilder, WorkflowConfig } from './workflows/workflow.js';

/**
 * `@oribos/core` — composition root.
 *
 * `createApp` is the optional thin assembly point of ADR-0002: it hands cross-cutting dependencies
 * — the observability tracer, the logger channel and the four storage ports — to the subsystems
 * attached to it, so they do not each have to be wired by hand.
 *
 * A subsystem built through the app is wired exactly as if it had been passed the dependencies
 * themselves; one built without the app (`new Agent(...)`) stays a first-class usage, and an app
 * without a slot adds nothing to the objects it builds (a missing storage slot means the core's
 * in-memory default, not a wider contract).
 *
 * Decisions: ADR-0002.
 */

/**
 * The storage slots of the composition root: one entry per storage port, each handed to the
 * subsystem that persists through it. A slot left out falls back to the core's in-memory default
 * (this process only); each slot is independent — no composite store, no domain routing.
 */
export interface AppStorageConfig {
  /**
   * The `MemoryStore` this app's agents and signals facades run through. The app builds one shared
   * `Memory` over it and hands the same instance to both, which is what the signals contract wants
   * (`App.signals`); users who need a different instance (working memory, another window size) pass
   * their own `Memory` explicitly.
   */
  readonly memory?: MemoryStore | undefined;
  /** The `WorkflowSnapshotStore` workflow runs snapshot through (`App.workflow`). */
  readonly workflow?: WorkflowSnapshotStore | undefined;
  /** The `AgentRunSnapshotStore` durable agent runs snapshot through (`App.durableAgent`). */
  readonly durableAgent?: AgentRunSnapshotStore | undefined;
  /** The `ScheduleStore` schedule records live in (`App.schedules`). */
  readonly schedules?: ScheduleStore | undefined;
}

/** The `createApp` config — every entry is optional; an app without cross-cutting dependencies is valid. */
export interface AppConfig {
  /**
   * The tracer distributed to the agents, workflows and signals facades built through this app
   * (`App.agent` / `App.workflow` / `App.signals`). Absent = those agents are built exactly as a
   * standalone `new Agent(...)`: no span object is ever created.
   */
  readonly tracer?: Tracer | undefined;
  /**
   * The logger channel distributed to the workflows built through this app (`App.workflow`): the
   * committed definition carries it as `Workflow.logger`. The seam is open on the workflow
   * subsystem only — the agent spec pins its own seam set (tracer/processors), and a channel with
   * no consumer is not welded onto a config. The kernel writes no logs of its own; the channel is
   * the one designated path the observability spec reserves for them.
   */
  readonly logger?: Logger | undefined;
  /** The storage slots, one per port; absent slots fall back to the core's in-memory defaults. */
  readonly storage?: AppStorageConfig | undefined;
}

/** The composition root (`createApp`): the factories that build subsystems with the distributed dependencies. */
export interface App {
  /**
   * Builds an agent with the app's tracer and shared memory distributed to it — an agent hung on
   * the composition root receives them without the caller passing either per agent.
   *
   * `AgentConfig.tracer` / `AgentConfig.memory` win when the config brings their own: explicit
   * assembly is never taken over. Without an app tracer the agent is built exactly as
   * `new Agent(config)`; nothing is activated by the distributed memory alone (a run with no
   * per-call thread identity performs no memory I/O).
   */
  agent(config: AgentConfig): Agent;
  /**
   * Opens a workflow builder with the app's tracer, logger channel and workflow snapshot store
   * distributed to it — the committed definition exposes the logger as `Workflow.logger` and
   * snapshots through the `storage.workflow` slot without the caller passing either.
   * `WorkflowConfig.tracer` / `WorkflowConfig.logger` / `WorkflowConfig.storage` win when the
   * config brings their own: explicit assembly is never taken over.
   */
  workflow<TInputSchema extends StandardSchema, TOutputSchema extends StandardSchema>(
    config: WorkflowConfig<TInputSchema, TOutputSchema>,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, TInputSchema>;
  /**
   * Wraps an agent with the app's agent run snapshot store distributed to it — a run that hits the
   * approval gate snapshots through the `storage.durableAgent` slot without the caller passing one.
   * `DurableAgentConfig.storage` wins when the config brings its own.
   */
  durableAgent(config: DurableAgentConfig): DurableAgent;
  /**
   * Creates the signals facade with the app's shared memory and tracer distributed to it — for an
   * agent built by this app (`app.agent(...)`) the thread's history lands in the `storage.memory`
   * slot without the caller passing a memory. `SignalsConfig.memory` / `SignalsConfig.tracer` win
   * when the config brings their own; an agent that carries a different memory is left as given.
   */
  signals(config: SignalsConfig): Signals;
  /**
   * Creates the schedules facade with the app's schedule store distributed to it — records persist
   * through the `storage.schedules` slot without the caller passing one. `SchedulesConfig.storage`
   * wins when the config brings its own.
   */
  schedules(config: SchedulesConfig): Schedules;
}

/**
 * Creates the composition root: the optional
 * thin assembly point that distributes cross-cutting dependencies to the subsystems attached to
 * it. Distributing does not replace any subsystem's standalone surface — the same objects remain
 * fully usable via explicit `new` without an app.
 */
export function createApp(config: AppConfig = {}): App {
  const tracer = config.tracer;
  const logger = config.logger;
  const memoryStore = config.storage?.memory ?? createInMemoryStore();
  /**
   * The one `Memory` every agent and signals facade built through this app shares: signals requires
   * the same instance on both sides, and a run's per-call thread identity is what activates it —
   * an app-built agent with no per-call memory stays a stateless run, exactly as a standalone one.
   */
  const memory = new Memory({ storage: memoryStore });
  const workflowStorage = config.storage?.workflow ?? createInMemorySnapshotStore();
  const durableStorage = config.storage?.durableAgent ?? createInMemoryAgentRunSnapshotStore();
  const scheduleStorage = config.storage?.schedules ?? createInMemoryScheduleStore();
  return {
    agent(agentConfig) {
      // Explicit per-instance dependencies win; absent ones are filled from the app's slots. Every
      // other field — and the config object itself when nothing is distributed — passes through
      // untouched, so an app-built agent stays a standalone `new Agent(config)` plus wiring.
      const patch: { memory?: Memory; tracer?: Tracer } = {};
      if (agentConfig.memory === undefined) patch.memory = memory;
      if (agentConfig.tracer === undefined && tracer !== undefined) patch.tracer = tracer;
      return new Agent(Object.keys(patch).length === 0 ? agentConfig : { ...agentConfig, ...patch });
    },
    workflow(workflowConfig) {
      // The same precedence as `agent`: an explicit per-instance dependency wins, absent one the
      // app's slot fills in, and with neither the config passes through untouched.
      return createWorkflow({
        ...workflowConfig,
        tracer: workflowConfig.tracer ?? tracer,
        logger: workflowConfig.logger ?? logger,
        storage: workflowConfig.storage ?? workflowStorage,
      });
    },
    durableAgent(durableConfig) {
      return createDurableAgent({
        ...durableConfig,
        storage: durableConfig.storage ?? durableStorage,
      });
    },
    schedules(schedulesConfig) {
      return createSchedules({
        ...schedulesConfig,
        storage: schedulesConfig.storage ?? scheduleStorage,
      });
    },
    signals(signalsConfig) {
      const { agent, memory: explicitMemory, tracer: explicitTracer } = signalsConfig;
      return createSignals({
        ...signalsConfig,
        // The app's shared Memory fills in only for an agent it built itself (that agent carries
        // exactly this instance). Any other agent keeps the config as given: the signals contract
        // wants one instance on both sides, so a different memory is the caller's to pass along.
        memory: explicitMemory ?? (agent.memory === memory ? memory : undefined),
        tracer: explicitTracer ?? tracer,
      });
    },
  };
}
