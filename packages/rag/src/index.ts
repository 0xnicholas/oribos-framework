/**
 * `@oribos/rag` — the RAG capability package: semantic recall over message history
 * (`docs/architecture/memory.md` CUT-MEM1, ADR-0017 追赶面中层;#182).
 *
 * The carrying seam is the store, not the core: `createSemanticMemoryStore` wraps a `MemoryStore`
 * (or stands alone on the core's in-memory default) and is passed to `new Memory({ storage })` —
 * the write path (`Memory.save → MemoryStore.saveMessages`) hands each persisted message's text to
 * the caller's embedding model and records it in a vector index; the read path
 * (`Memory.recall → MemoryStore.listMessages`, a cursorless window query) embeds the window's last
 * user message and merges semantically related older messages back ahead of the recent window.
 *
 * Pins kept (ADR-0007): messages are immutable — the index is a derived cache of full stored
 * messages and never rewrites what the store holds; `recall` stays the single query entry — the
 * enhancement is what the same call returns. Zero cost when unconfigured: without this wrapper the
 * core's memory path is untouched. No resident pipeline: every embedding happens inline in the
 * request that triggered it.
 *
 * The embedder follows the model contract's pattern (ADR-0004): a vendored structural subset of
 * the AI SDK provider specification's embedding model interface (`v4`) — any embedding model
 * instance from a provider package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …) satisfies it
 * structurally, with no adapter and no registration. The vector index is the package's own port:
 * an in-memory cosine default ships here, and an external vector store travels with the caller as
 * a `VectorIndex` implementation — the dependency rides this package, never the core.
 *
 * Package face: [`createSemanticMemoryStore`], [`SemanticMemoryConfig`], [`Embedder`],
 * [`VectorIndex`], [`VectorEntry`], [`ScoredVectorEntry`], [`createInMemoryVectorIndex`].
 */
import {
  createInMemoryStore,
  supportsWorkingMemory,
} from '@oribos/core/memory';
import type {
  ListMessagesQuery,
  MemoryStore,
  StoredMessage,
  WorkingMemoryStore,
} from '@oribos/core/memory';

/**
 * The embedder call the package makes: the texts to embed, nothing else. A structural subset of
 * the provider spec's embedding call options.
 */
export interface EmbedderCallOptions {
  /** The text values to generate embeddings for. */
  readonly values: readonly string[];
  /** Abort signal for cancelling the operation. */
  readonly abortSignal?: AbortSignal | undefined;
}

/** The embedder result the package consumes: one embedding per input value, in order. */
export interface EmbedderResult {
  /** Generated embeddings, in the order of the input values. */
  readonly embeddings: readonly (readonly number[])[];
}

/**
 * The embedder contract — the model contract's pattern applied to embeddings: a vendored minimal
 * structural subset of the AI SDK provider specification (embedding model interface `v4`). A
 * model instance from any provider package satisfies it structurally; no adapter, no registry.
 */
export interface Embedder {
  /** The embedding model interface version this model implements (locked: `'v4'`). */
  readonly specificationVersion: 'v4';
  /** Provider ID, e.g. `'openai'`. */
  readonly provider: string;
  /** Provider-specific model ID, e.g. `'text-embedding-3-small'`. */
  readonly modelId: string;
  /** Generates embeddings for the given text values. */
  doEmbed(options: EmbedderCallOptions): PromiseLike<EmbedderResult>;
}

/** One indexed message: the embedding, the envelope, and the full stored message it derives from. */
export interface VectorEntry {
  /** The indexed message's id — the upsert key (a re-saved message replaces its entry). */
  readonly id: string;
  /** The message's thread; queries are scoped by it. */
  readonly threadId: string;
  /** The message's owner resource. */
  readonly resourceId: string;
  /** The message text's embedding. */
  readonly embedding: readonly number[];
  /** The full stored message, returned whole on a hit — no port extension needed to read it back. */
  readonly message: StoredMessage;
}

/** A query hit: the entry plus its similarity score (cosine, `1` = same direction, `0` = unrelated). */
export interface ScoredVectorEntry {
  readonly entry: VectorEntry;
  readonly score: number;
}

/** A vector index query: how many hits, and which thread's entries. */
export interface VectorIndexQuery {
  /** Maximum number of entries to return, highest score first. */
  readonly topK: number;
  /** Restrict to one thread's entries; absent = the whole index. */
  readonly threadId?: string | undefined;
}

/**
 * The package's vector-store port: the seam an external vector database rides. The in-memory
 * cosine default ([`createInMemoryVectorIndex`]) carries no dependency; anything heavier
 * (a server, a native binding) is the caller's adapter and the caller's dependency.
 */
export interface VectorIndex {
  /** Upsert entries by `id` (same id replaces). */
  upsert(entries: readonly VectorEntry[]): Promise<void>;
  /** The `topK` highest-scoring entries for the embedding, score-descending. */
  query(embedding: readonly number[], query: VectorIndexQuery): Promise<ScoredVectorEntry[]>;
  /** Drop every entry of a thread — the port's `deleteThread` cascade, mirrored on the index. */
  deleteByThread(threadId: string): Promise<void>;
}

/**
 * The semantic memory store's config: the embedder to index with, and everything else optional.
 * Pass `storage` to wrap an existing store (the SQLite adapter, …); absent = the core's in-memory
 * default, wrapped the same way.
 */
export interface SemanticMemoryConfig {
  /** The store to wrap; absent = the core's in-memory default. */
  readonly storage?: MemoryStore | undefined;
  /** The embedding model messages are indexed with (the model contract's pattern, vendor-supplied). */
  readonly embedder: Embedder;
  /** The vector index; absent = the package's in-memory cosine default. */
  readonly index?: VectorIndex | undefined;
  /**
   * How many semantically related older messages a cursorless recall may merge back. Absent = 3.
   * Only positively-similar hits count — an orthogonal or opposite embedding is not a match.
   */
  readonly topK?: number | undefined;
}

/** `topK` default — how many related older messages a recall window may pull back. */
const DEFAULT_TOP_K = 3;

/**
 * Wraps a `MemoryStore` with semantic recall (the RAG capability package's whole surface):
 *
 * ```ts
 * const memory = new Memory({
 *   storage: createSemanticMemoryStore({ embedder: openai.textEmbeddingModel('text-embedding-3-small') }),
 *   lastMessages: 10,
 * });
 * ```
 *
 * Writes index inline (persist first, then embed — a failing embedder rejects the save call, and
 * the index never holds a message the store refused); cursorless window reads merge related older
 * messages back (paging with `before` passes through untouched, no embedding spent); thread
 * deletion cascades to the index. The wrapper forwards the port's full surface, so a
 * working-memory-capable store stays working-memory-capable through it.
 */
export function createSemanticMemoryStore(
  config: SemanticMemoryConfig & { readonly storage: WorkingMemoryStore },
): WorkingMemoryStore;
export function createSemanticMemoryStore(config: SemanticMemoryConfig): MemoryStore;
export function createSemanticMemoryStore(config: SemanticMemoryConfig): MemoryStore {
  const storage = config.storage ?? createInMemoryStore();
  const embedder = config.embedder;
  const index = config.index ?? createInMemoryVectorIndex();
  const topK = assertPositiveInteger(config.topK ?? DEFAULT_TOP_K, 'createSemanticMemoryStore: topK');

  async function saveMessagesWithIndexing(messages: StoredMessage[]): Promise<void> {
    await storage.saveMessages(messages);
    const embeddable = messages.flatMap((message) => {
      const text = messageText(message);
      return text === undefined ? [] : [{ message, text }];
    });
    if (embeddable.length === 0) return;
    const { embeddings } = await embedder.doEmbed({ values: embeddable.map((item) => item.text) });
    if (embeddings.length !== embeddable.length) {
      throw new Error(
        `createSemanticMemoryStore: the embedder returned ${embeddings.length} embedding(s) for ${embeddable.length} message(s) — one per message, in order, is the contract`,
      );
    }
    await index.upsert(
      embeddable.map((item, position) => ({
        id: item.message.id,
        threadId: item.message.threadId,
        resourceId: item.message.resourceId,
        embedding: embeddings[position] ?? [],
        message: item.message,
      })),
    );
  }

  async function listMessagesWithSemanticRecall(query: ListMessagesQuery): Promise<StoredMessage[]> {
    const window = await storage.listMessages(query);
    // Paging (`before`) is an exact cursor read of the store — pass through, spend no embedding.
    // An empty window (unknown thread, or a fully paged one) has nothing to merge into.
    if (query.before !== undefined || window.length === 0) return window;
    const queryText = recallQueryText(window);
    if (queryText === undefined) return window;
    const { embeddings } = await embedder.doEmbed({ values: [queryText] });
    if (embeddings.length !== 1) {
      throw new Error(
        `createSemanticMemoryStore: the embedder returned ${embeddings.length} embedding(s) for one query text — exactly one is the contract`,
      );
    }
    const scored = await index.query(embeddings[0] ?? [], { topK, threadId: query.threadId });
    const windowIds = new Set(window.map((message) => message.id));
    const retrieved = scored
      .filter((hit) => hit.score > 0 && !windowIds.has(hit.entry.message.id))
      .map((hit) => hit.entry.message);
    if (retrieved.length === 0) return window;
    const merged = [...window, ...retrieved].sort(compareMessagesAsc);
    return query.order === 'desc' ? merged.reverse() : merged;
  }

  const store: MemoryStore = {
    getThreadById: (id) => storage.getThreadById(id),
    saveThread: (thread) => storage.saveThread(thread),
    deleteThread: async (id) => {
      await storage.deleteThread(id);
      await index.deleteByThread(id);
    },
    listThreads: (query) => storage.listThreads(query),
    listMessages: (query) => listMessagesWithSemanticRecall(query),
    saveMessages: (messages) => saveMessagesWithIndexing(messages),
  };

  // Capability passthrough: the conditional resource pair is forwarded when the wrapped store
  // declares it, so working memory works unchanged through the wrapper.
  return supportsWorkingMemory(storage)
    ? {
        ...store,
        getResource: (id) => storage.getResource(id),
        saveResource: (resource) => storage.saveResource(resource),
      }
    : store;
}

/**
 * The text a message is indexed by: the concatenated text parts of a system / user / assistant
 * message; tool traffic carries no prose to embed, so it stays unindexed (`undefined`).
 */
function messageText(message: StoredMessage): string | undefined {
  if (message.role === 'system') return message.content;
  if (message.role === 'tool') return undefined;
  const texts = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return texts.length === 0 ? undefined : texts.join('\n');
}

/**
 * The query text a window read embeds: the window's last user message (the question the window is
 * about to answer), or — when the window holds no user message — every text it has. A window with
 * no text at all skips the semantic merge.
 */
function recallQueryText(window: readonly StoredMessage[]): string | undefined {
  // The derivation is presentation-independent: a `desc` window arrives newest-first, so the
  // copy is put in chronological order before "the last user message" is picked.
  const chronological = [...window].sort(compareMessagesAsc);
  for (let position = chronological.length - 1; position >= 0; position -= 1) {
    const message = chronological[position];
    if (message?.role === 'user') {
      const text = messageText(message);
      if (text !== undefined) return text;
    }
  }
  const texts = chronological.flatMap((message) => {
    const text = messageText(message);
    return text === undefined ? [] : [text];
  });
  return texts.length === 0 ? undefined : texts.join('\n');
}

/**
 * Chronological presentation order, mirroring the port's listing convention (`createdAt` asc,
 * `id` asc as the same-millisecond tie-break) so merged messages land exactly where a longer
 * window would have put them.
 */
function compareMessagesAsc(a: StoredMessage, b: StoredMessage): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A similarity knob is a positive integer or a configuration bug. */
function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * The in-memory `VectorIndex` default: a Map of entries ranked by cosine similarity, zero
 * dependencies and zero process footprint — the whole index lives and dies with the store. Upsert
 * order breaks score ties deterministically; `deleteByThread` drops the thread's entries; a
 * zero-norm embedding scores `0` against everything.
 */
export function createInMemoryVectorIndex(): VectorIndex {
  const entries = new Map<string, VectorEntry>();
  return {
    upsert: async (upserts) => {
      for (const entry of upserts) entries.set(entry.id, entry);
    },
    query: async (embedding, query) => {
      const ranked = [];
      for (const entry of entries.values()) {
        if (query.threadId !== undefined && entry.threadId !== query.threadId) continue;
        ranked.push({ entry, score: cosineSimilarity(embedding, entry.embedding) });
      }
      // Array#sort is stable: equal scores keep upsert order, so ranking is deterministic.
      ranked.sort((a, b) => b.score - a.score);
      return ranked.slice(0, assertPositiveInteger(query.topK, 'VectorIndex.query: topK'));
    },
    deleteByThread: async (threadId) => {
      for (const [id, entry] of entries) {
        if (entry.threadId === threadId) entries.delete(id);
      }
    },
  };
}

/** Cosine similarity; a zero-norm vector is directionless and scores `0`. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let position = 0; position < length; position += 1) {
    const x = a[position] ?? 0;
    const y = b[position] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
