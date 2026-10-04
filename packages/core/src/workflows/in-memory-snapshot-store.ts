import type { WorkflowRunSnapshot, WorkflowSnapshotStore } from './snapshot.js';
import { createMapSnapshotStore } from '../map-snapshot-store.js';

/**
 * The core's in-memory default `WorkflowSnapshotStore` (Map-backed, zero runtime burden): a workflow
 * without attached storage keeps its snapshots in process memory, so suspend/resume still runs — the
 * snapshot simply does not outlive the process. The mechanism and the adapter-author contract live
 * in `map-snapshot-store.ts`; this factory is its typed instantiation for the workflow port.
 */
export function createInMemorySnapshotStore(): WorkflowSnapshotStore {
  return createMapSnapshotStore<WorkflowRunSnapshot>();
}
