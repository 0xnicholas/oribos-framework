import type { MemoryThreadRef } from './memory.js';

/**
 * The memory identity rule's one home (CONTEXT.md「记忆身份 (Memory identity)」): the per-call
 * identity pair `{ thread, resource }` is explicit, never defaulted — a target missing either
 * field fails before the subsystem acts on it. The agent's run memory, the signals target and the
 * schedules threaded target all delegate here; the `label` names the subsystem in the error, so
 * the one template (`<label>: the memory target is missing its … — <hint>`) still locates both
 * the surface and the fix.
 *
 * Internal to the package: not part of any entry's export surface.
 */

/**
 * The identity core the three subsystems share, taken structurally — declared here rather than
 * imported from the agent/schedules surfaces, so this module stays inside the memory subsystem
 * and cycle-free.
 */
export interface MemoryIdentity {
  readonly thread?: MemoryThreadRef | undefined;
  readonly resource?: unknown;
}

/**
 * Validates a full memory identity and returns its thread id: both fields present and non-empty,
 * or the throw carries the subsystem's label and fix. Error timing stays the caller's (agent:
 * before any model call; signals: before delivery; schedules: at save).
 */
export function assertMemoryTarget(label: string, target: MemoryIdentity, hint: string): string {
  const threadId = resolveThreadId(label, target.thread, hint);
  if (typeof target.resource !== 'string' || target.resource === '') {
    throw new Error(`${label}: the memory target is missing its resource — ${hint}`);
  }
  return threadId;
}

/** The thread id of a memory identity — the string form, or the `id` of the ref object. */
export function resolveThreadId(
  label: string,
  thread: MemoryThreadRef | undefined,
  hint: string,
): string {
  const id = typeof thread === 'string' ? thread : thread?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${label}: the memory target is missing its thread — ${hint}`);
  }
  return id;
}
