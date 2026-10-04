/**
 * `MemoryStore` over SQLite (the SQL shape of the queries): the core's
 * in-memory store is the semantic reference and these queries are its translation — same ordering,
 * same cursor rules, same `limit` anchoring, same upserts. Both conditional resource methods are
 * implemented, so the object is a `WorkingMemoryStore` and `supportsWorkingMemory` reads true.
 *
 * Two adapter-owned facts the in-memory reference does not have to think about:
 * - records are serialized (JSON text columns), so reads are fresh values that change only through
 *   the port, exactly like the reference's deep copies;
 * - `messages.thread_id` is a real foreign key with `ON DELETE CASCADE`. The memory write path
 *   always creates the thread first, so the happy path never notices; a direct port caller that
 *   skips `saveThread` gets the constraint error where the reference would have accepted the row
 * (the semantic divergences worth knowing).
 */
import type {
  ListMessagesQuery,
  ListThreadsQuery,
  StoredMessage,
  StoredResource,
  StoredThread,
  WorkingMemoryStore,
} from '@oribos/core/memory';
import type { SqliteLifecycle } from './connection.js';
import { assertPageLimit, decodeJson, encodeJson, inTransaction, loadCursorRow } from './connection.js';

interface ThreadRow {
  id: string;
  resource_id: string;
  title: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  resource_id: string;
  created_at: number;
  payload: string;
}

interface ResourceRow {
  id: string;
  working_memory: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

const THREAD_COLUMNS = 'id, resource_id, title, metadata, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, thread_id, resource_id, created_at, payload';
const RESOURCE_COLUMNS = 'id, working_memory, metadata, created_at, updated_at';

/** Optional fields come back **absent** (not `undefined`-valued) when their column is NULL. */
function threadFromRow(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    resourceId: row.resource_id,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.metadata === null
      ? {}
      : { metadata: decodeJson(row.metadata) as Record<string, unknown> }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** The envelope rides in columns; the payload column is the `ModelMessage` body alone. */
function messageFromRow(row: MessageRow): StoredMessage {
  return {
    ...(decodeJson(row.payload) as Record<string, unknown>),
    id: row.id,
    threadId: row.thread_id,
    resourceId: row.resource_id,
    createdAt: new Date(row.created_at),
  } as StoredMessage;
}

function resourceFromRow(row: ResourceRow): StoredResource {
  return {
    id: row.id,
    // NULL (no value) and 'null' (JSON null stored) are strictly distinguished: presence is the
    // column being non-NULL, never what the JSON text parses to.
    ...(row.working_memory === null ? {} : { workingMemory: decodeJson(row.working_memory) }),
    ...(row.metadata === null
      ? {}
      : { metadata: decodeJson(row.metadata) as Record<string, unknown> }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** The payload column: the message minus its four envelope fields, as one JSON text. */
function messagePayload(message: StoredMessage): string {
  const { id: _id, threadId: _threadId, resourceId: _resourceId, createdAt: _createdAt, ...body } =
    message;
  return JSON.stringify(body);
}

export function createMemoryStore(lifecycle: SqliteLifecycle): WorkingMemoryStore {
  return {
    async getThreadById(id) {
      const db = lifecycle.open();
      const row = db
        .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
        .get(id) as ThreadRow | undefined;
      return row === undefined ? null : threadFromRow(row);
    },

    async saveThread(thread) {
      const db = lifecycle.open();
      db.prepare(
        `INSERT INTO threads (${THREAD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           resource_id = excluded.resource_id, title = excluded.title, metadata = excluded.metadata,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
      ).run(
        thread.id,
        thread.resourceId,
        thread.title ?? null,
        encodeJson(thread.metadata),
        thread.createdAt.getTime(),
        thread.updatedAt.getTime(),
      );
    },

    async deleteThread(id) {
      const db = lifecycle.open();
      // The cascade is the foreign key's, not a second DELETE here (`ON DELETE CASCADE`).
      db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    },

    async listThreads(query: ListThreadsQuery) {
      const db = lifecycle.open();
      assertPageLimit('memory.listThreads', query.limit);
      const cursor =
        query.before === undefined
          ? undefined
          : loadCursorRow<ThreadRow>(db, {
              caller: 'memory.listThreads',
              noun: 'thread',
              sql: `SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`,
              before: query.before,
              inScope: (row) => row.resource_id === query.resourceId,
            });
      const cursorClause = cursor === undefined ? '' : ' AND (updated_at, id) < (?, ?)';
      const limitClause = query.limit === undefined ? '' : ' LIMIT ?';
      const rows = db
        .prepare(
          `SELECT ${THREAD_COLUMNS} FROM threads
           WHERE resource_id = ?${cursorClause}
           ORDER BY updated_at DESC, id DESC${limitClause}`,
        )
        .all(
          query.resourceId,
          ...(cursor === undefined ? [] : [cursor.updated_at, cursor.id]),
          ...(query.limit === undefined ? [] : [query.limit]),
        ) as unknown as ThreadRow[];
      return rows.map(threadFromRow);
    },

    async listMessages(query: ListMessagesQuery) {
      const db = lifecycle.open();
      assertPageLimit('memory.listMessages', query.limit);
      const cursor =
        query.before === undefined
          ? undefined
          : loadCursorRow<MessageRow>(db, {
              caller: 'memory.listMessages',
              noun: 'message',
              sql: `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
              before: query.before,
              inScope: (row) => row.thread_id === query.threadId,
            });
      const cursorClause = cursor === undefined ? '' : ' AND (created_at, id) < (?, ?)';
      const limitClause = query.limit === undefined ? '' : ' LIMIT ?';
      const rows = db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE thread_id = ?${cursorClause}
           ORDER BY created_at DESC, id DESC${limitClause}`,
        )
        .all(
          query.threadId,
          ...(cursor === undefined ? [] : [cursor.created_at, cursor.id]),
          ...(query.limit === undefined ? [] : [query.limit]),
        ) as unknown as MessageRow[];
      const page = rows.map(messageFromRow);
      // `limit` anchored at the newest end; `order: 'asc'` flips presentation only.
      return query.order === 'asc' ? page.reverse() : page;
    },

    async saveMessages(batch) {
      const db = lifecycle.open();
      if (batch.length === 0) return;
      inTransaction(db, () => {
        const statement = db.prepare(
          `INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             thread_id = excluded.thread_id, resource_id = excluded.resource_id,
             created_at = excluded.created_at, payload = excluded.payload`,
        );
        for (const message of batch) {
          statement.run(
            message.id,
            message.threadId,
            message.resourceId,
            message.createdAt.getTime(),
            messagePayload(message),
          );
        }
      });
    },

    async getResource(id) {
      const db = lifecycle.open();
      const row = db
        .prepare(`SELECT ${RESOURCE_COLUMNS} FROM resources WHERE id = ?`)
        .get(id) as ResourceRow | undefined;
      return row === undefined ? null : resourceFromRow(row);
    },

    async saveResource(resource) {
      const db = lifecycle.open();
      db.prepare(
        `INSERT INTO resources (${RESOURCE_COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           working_memory = excluded.working_memory, metadata = excluded.metadata,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
      ).run(
        resource.id,
        encodeJson(resource.workingMemory),
        encodeJson(resource.metadata),
        resource.createdAt.getTime(),
        resource.updatedAt.getTime(),
      );
    },
  };
}
