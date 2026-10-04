/**
 * The mechanisms the core's in-memory store defaults share (suspend/resume and snapshots,
 * ADR-0010). `copy` is the deep-copy discipline every in-memory default keeps — reads and writes
 * cross the port as deep copies (`structuredClone`), so stored state changes only through the port,
 * exactly like a serializing backend — carried once for the memory, schedules and snapshot
 * defaults. `WorkflowSnapshotStore` and `AgentRunSnapshotStore` stay separate port shapes by
 * design, but their Map-backed defaults are a single mechanism, so it lives here once — each
 * subsystem's public factory (`workflows/in-memory-snapshot-store.ts`,
 * `durable-agent/in-memory-snapshot-store.ts`) is a one-line typed instantiation of it.
 * Root-level internal: no entry exports this module.
 */

/** Reads and writes cross the port as deep copies — stored state changes only through the port. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Creates the Map-backed, zero-runtime-burden store: one entry per run, keyed by run id; later
 * writes replace earlier ones; the snapshots do not outlive the process.
 *
 * It doubles as the reference for adapter authors: reads and writes cross the port as deep copies
 * (`structuredClone`), so stored state changes only through the port, exactly like a serializing
 * backend. What that enforces is isolation, not the JSON-only rule: `structuredClone` rejects
 * functions but happily carries values JSON cannot (Map / Set / Date, cycles), so a snapshot the
 * core accepts here could still fail an adapter with a JSON backend. The JSON-only constraint stays
 * the port's contract, not something this default checks.
 */
export function createMapSnapshotStore<TSnapshot>(): {
  load(runId: string): Promise<TSnapshot | null>;
  save(runId: string, snapshot: TSnapshot): Promise<void>;
} {
  const snapshots = new Map<string, TSnapshot>();

  return {
    load: async (runId) => {
      const snapshot = snapshots.get(runId);
      return snapshot === undefined ? null : copy(snapshot);
    },

    save: async (runId, snapshot) => {
      snapshots.set(runId, copy(snapshot));
    },
  };
}
