import type {
  ListMessagesQuery,
  ListThreadsQuery,
  StoredMessage,
  StoredResource,
  StoredThread,
} from './types.js';
import type { WorkingMemoryStore } from './store.js';
import { copy } from '../map-snapshot-store.js';

/**
 * The core's in-memory default `MemoryStore` (Map-backed, zero runtime burden): attach no storage
 * and memory is purely in-process. It doubles as the semantic reference for adapter authors —
 * reads return deep copies and writes deep-copy too, so stored state changes only through the
 * port, exactly like a serializing backend.
 *
 * Pinned semantics (enforced by `test/memory-store.test.ts`):
 * - Timestamps are caller-owned; records are persisted exactly as given.
 * - Thread listing is `updatedAt`-descending (`id` tie-break), message listing defaults to
 *   `createdAt`-descending; `order` flips presentation only.
 * - `limit` anchors at the newest end of the pool — never the oldest N.
 * - `before` is a cursor id: only entries strictly older than the referenced one are returned;
 *   a dangling cursor (unknown id, or one owned by another thread/resource) is a caller bug and
 *   throws. `limit` must be a positive integer.
 */

function assertLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`listThreads/listMessages: limit must be a positive integer, got ${limit}`);
  }
}

/** Newest-first total order for threads: `updatedAt` desc, `id` desc as tie-break. */
function compareThreadsDesc(a: StoredThread, b: StoredThread): number {
  const byTime = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Newest-first total order for messages: `createdAt` desc, `id` desc as tie-break. */
function compareMessagesDesc(a: StoredMessage, b: StoredMessage): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function createInMemoryStore(): WorkingMemoryStore {
  const threads = new Map<string, StoredThread>();
  const messages = new Map<string, StoredMessage>();
  const resources = new Map<string, StoredResource>();

  return {
    getThreadById: async (id) => {
      const thread = threads.get(id);
      return thread === undefined ? null : copy(thread);
    },

    saveThread: async (thread) => {
      threads.set(thread.id, copy(thread));
    },

    deleteThread: async (id) => {
      threads.delete(id);
      // Cascade-delete the thread's messages; resource-level data (working memory) is untouched.
      for (const [messageId, message] of messages) {
        if (message.threadId === id) messages.delete(messageId);
      }
    },

    listThreads: async (query: ListThreadsQuery) => {
      assertLimit(query.limit);
      let pool = [...threads.values()].filter(
        (thread) => thread.resourceId === query.resourceId,
      );
      if (query.before !== undefined) {
        const cursor = threads.get(query.before);
        if (cursor === undefined || cursor.resourceId !== query.resourceId) {
          throw new Error(
            `listThreads: before cursor '${query.before}' is not a thread of resource '${query.resourceId}'`,
          );
        }
        pool = pool.filter((thread) => compareThreadsDesc(thread, cursor) > 0);
      }
      pool.sort(compareThreadsDesc);
      const page = query.limit === undefined ? pool : pool.slice(0, query.limit);
      return page.map(copy);
    },

    listMessages: async (query: ListMessagesQuery) => {
      assertLimit(query.limit);
      let pool = [...messages.values()].filter(
        (message) => message.threadId === query.threadId,
      );
      if (query.before !== undefined) {
        const cursor = messages.get(query.before);
        if (cursor === undefined || cursor.threadId !== query.threadId) {
          throw new Error(
            `listMessages: before cursor '${query.before}' is not a message of thread '${query.threadId}'`,
          );
        }
        pool = pool.filter((message) => compareMessagesDesc(message, cursor) > 0);
      }
      pool.sort(compareMessagesDesc);
      // limit anchors the newest end: page the descending pool first; asc only flips presentation order.
      const page = query.limit === undefined ? pool : pool.slice(0, query.limit);
      if (query.order === 'asc') page.reverse();
      return page.map(copy);
    },

    saveMessages: async (batch) => {
      for (const message of batch) messages.set(message.id, copy(message));
    },

    getResource: async (id) => {
      const resource = resources.get(id);
      return resource === undefined ? null : copy(resource);
    },

    saveResource: async (resource) => {
      resources.set(resource.id, copy(resource));
    },
  };
}
