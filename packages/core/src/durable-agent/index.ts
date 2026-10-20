/**
 * `@oribos/core/durable-agent` — durable agents (one of the three harness subsystems).
 *
 * `createDurableAgent({ agent, storage?, approval? })`: the agent wrapped so a run may suspend at a
 * tool-calling boundary — the model's calls are known, none has executed yet, and one of them hits
 * the approval list → the run's loop snapshot goes to the `AgentRunSnapshotStore` (2 methods,
 * JSON-only; the in-memory default ships with the core), `finishReason` settles `'suspended'`, the
 * run's `suspendPayload` reports what was held, and `resume(runId, { approved })` continues it:
 * execute the held calls and go on, or answer them with a user-rejected result and let the model
 * replan. Suspension is the wrapper's own behavior; a bare agent run suspends only when it is
 * explicitly handed a `stepBoundary` gate (the wrapper attaches one).
 */
export { createDurableAgent } from './durable-agent.js';
export type {
  ApprovalConfig,
  DurableAgent,
  DurableAgentConfig,
  DurableResumeOptions,
  DurableRunOutcome,
  DurableStreamResult,
} from './durable-agent.js';
export { createInMemoryAgentRunSnapshotStore } from './in-memory-snapshot-store.js';
export type {
  AgentRunSnapshot,
  AgentRunSnapshotStore,
  AgentRunSuspendPayload,
} from './snapshot.js';
