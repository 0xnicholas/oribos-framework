import type { ModelMessage } from '../model/contract.js';

/**
 * Stored record shapes of the memory subsystem.
 *
 * Timestamps are caller-owned: the port persists records exactly as given, so every adapter sees
 * the same contract (`saveThread` / `saveResource` are upserts of full records).
 */

/** A persistent conversation. `resourceId` is the owner; memory does no access control. */
export interface StoredThread {
  id: string;
  resourceId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A stored message: the model contract's prompt message (`ModelMessage`) plus the storage
 * envelope. Internal flow and storage share one format; messages are immutable — a repeated `id`
 * in `saveMessages` replaces, and the memory layer above never does that.
 */
export type StoredMessage = ModelMessage & {
  id: string;
  threadId: string;
  resourceId: string;
  createdAt: Date;
};

/** A resource (user/entity anchor). `workingMemory` is opaque to the store; schema-validated above. */
export interface StoredResource {
  id: string;
  workingMemory?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Thread listing: threads of one resource, most-recently-active first (`updatedAt` desc, `id` as
 * tie-break). `before` is a cursor: only threads strictly older than the referenced thread are
 * returned; `limit` then anchors at the newest end of what remains.
 */
export interface ListThreadsQuery {
  resourceId: string;
  limit?: number;
  before?: string;
}

/**
 * Message listing: messages of one thread. `limit` anchors at the newest end (the recent-window
 * semantic of message history — never the oldest N); `order` flips presentation only and defaults
 * to `'desc'`. `before` is a cursor: only messages strictly older than the referenced message are
 * returned. Ordering key is `createdAt` (`id` as tie-break).
 *
 * `limit` is an exact upper bound for a base adapter: at most `limit` messages, anchored at the
 * newest end (shifted by `before`). A store wrapper — a `MemoryStore` that keeps the port's
 * surface but layers policy on `listMessages` (ADR-0021) — may return a superset of the base
 * window the inner store returns for the same query: policy messages may be merged, prepended, or
 * appended. It must keep every base-window message exactly once and in the same relative order,
 * and must not remove one. For a wrapper, `before` remains exact pass-through (no policy work, no
 * side effects), and `order` never changes which messages belong to the base window.
 */
export interface ListMessagesQuery {
  threadId: string;
  limit?: number;
  before?: string;
  order?: 'asc' | 'desc';
}
