import type { AgentRunSnapshot, AgentRunSnapshotStore } from './snapshot.js';
import { createMapSnapshotStore } from '../map-snapshot-store.js';

/**
 * The core's in-memory default `AgentRunSnapshotStore` (Map-backed, zero runtime burden): a durable
 * agent without attached storage keeps its run snapshots in process memory, so suspend/resume still
 * runs — the snapshot simply does not outlive the process. The mechanism and the adapter-author
 * contract live in `map-snapshot-store.ts`; this factory is its typed instantiation for the
 * durable-agent port.
 */
export function createInMemoryAgentRunSnapshotStore(): AgentRunSnapshotStore {
  return createMapSnapshotStore<AgentRunSnapshot>();
}
