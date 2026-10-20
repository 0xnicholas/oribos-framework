/**
 * `@oribos/observational-memory` — the observational-memory capability package: compaction over
 * message history that stays inside the request that read it (`docs/architecture/memory.md`
 * CUT-MEM2, ADR-0017 追赶面远层;#196).
 *
 * The carrying seam is the store, not the core: `createObservationalMemoryStore` wraps a
 * `MemoryStore` (or stands alone on the core's in-memory default) and is passed to
 * `new Memory({ storage })` — the read path (`Memory.recall → MemoryStore.listMessages`, a
 * cursorless window query) computes the backlog behind the window (messages older than it that no
 * observation covers yet) and, when that backlog's estimated volume exceeds the observation
 * threshold, runs one Observer pass inline: the oldest segment of the backlog is condensed into an
 * observation note by the caller's model. Once the unreflected observations exceed the reflection
 * threshold, a Reflector pass merges them (and the current reflection) into one updated reflection.
 * The read returns one derived system message ahead of the window: reflection block first, then the
 * unreflected observation blocks, then the window as-is.
 *
 * Pins kept (ADR-0007): messages are immutable — observations and reflections are additive derived
 * records, never rewrites of what the store holds; `recall` stays the single query entry — paging
 * (`before`) passes through untouched as the raw read-back path, so the enhancement is exactly what
 * a cursorless window read returns, and nothing else changes. No resident pipeline: no
 * post-response write, no drain, zero timers — compaction happens only inside a cursorless read
 * that the application itself made, and an unwrapped store has zero of it. The observation records
 * are the package's own port: an in-memory default ships here, and persistence is the deployer's
 * `ObservationStore` implementation — the dependency rides this package or the deployer, never the
 * core.
 *
 * Models follow the framework's model contract (ADR-0004): pass the language model produced by any
 * AI SDK provider package — no adapter, no registry. Both models are required by their role
 * (`observer`; `reflector` only when reflections are wanted).
 *
 * Package face: [`createObservationalMemoryStore`], [`ObservationalMemoryConfig`],
 * [`ObservationalMemoryThresholds`], [`ObservationStore`], [`ObservationRecord`],
 * [`TokenCounter`], [`createInMemoryObservationStore`].
 */
import { createInMemoryStore, supportsWorkingMemory } from '@oribos/core/memory';
import type {
  ListMessagesQuery,
  MemoryStore,
  StoredMessage,
  WorkingMemoryStore,
} from '@oribos/core/memory';
import { assertModel } from '@oribos/core/model';
import type {
  Model,
  ModelMessage,
  ModelTextContent,
  ModelToolApprovalResponsePart,
  ModelToolResultOutput,
  ModelToolResultPart,
} from '@oribos/core/model';

/**
 * One derived memory record: an observation (a condensation of a segment of messages) or a
 * reflection (a merge of observations and the prior reflection into one updated record).
 *
 * Records are additive and immutable: the package only appends, and a record's meaning never
 * changes. `sourceIds` is what the record was derived from — message ids for an observation,
 * record ids (observations and the merged prior reflection) for a reflection.
 */
export interface ObservationRecord {
  /** The record's id — the upsert key on the store. */
  readonly id: string;
  /** The thread the record belongs to; compaction is thread-scoped. */
  readonly threadId: string;
  /** The thread's owner resource. */
  readonly resourceId: string;
  /** When the record was produced. */
  readonly createdAt: Date;
  /** What kind of record this is. */
  readonly kind: 'observation' | 'reflection';
  /** What the record was derived from (observation: message ids; reflection: record ids). */
  readonly sourceIds: readonly string[];
  /** The condensed text the model produced. */
  readonly text: string;
}

/**
 * The package's observation-store port: where derived records live. The in-memory default carries
 * no dependency; persistence (a database, a file) is the deployer's implementation of this port —
 * losing it across restarts never costs correctness, just re-paid model cost (the next recall
 * re-observes what it can no longer see as observed).
 */
export interface ObservationStore {
  /** One thread's records, in chronological order (`createdAt` asc, `id` asc as tie-break). */
  list(threadId: string): Promise<ObservationRecord[]>;
  /** Upsert a record by `id` (same id replaces). The package only ever appends new records. */
  save(record: ObservationRecord): Promise<void>;
  /** Drop every record of a thread — the port's `deleteThread` cascade, mirrored on this store. */
  deleteByThread(threadId: string): Promise<void>;
}

/**
 * Estimates the volume of each rendered text, in whatever unit the thresholds are expressed in
 * (token estimates by convention). One count per input text, in order — an array of the wrong
 * length, or of non-finite / negative numbers, is a configuration bug and throws.
 */
export type TokenCounter = (
  texts: readonly string[],
) => number[] | PromiseLike<readonly number[]>;

/** The volume thresholds (estimated tokens): backlog over `observation` observes; unreflected observations over `reflection` reflect. */
export interface ObservationalMemoryThresholds {
  /** Estimated-token volume a backlog must exceed to observe its oldest segment. Absent = 1000. */
  readonly observation?: number | undefined;
  /** Estimated-token volume unreflected observations must exceed to reflect. Absent = 2000. */
  readonly reflection?: number | undefined;
}

/**
 * The observational memory store's config: the observer model and everything else optional. Pass
 * `storage` to wrap an existing store (the SQLite adapter, a `@oribos/rag` store, …); absent = the
 * core's in-memory default, wrapped the same way.
 */
export interface ObservationalMemoryConfig {
  /** The store to wrap; absent = the core's in-memory default. */
  readonly storage?: MemoryStore | undefined;
  /** The model that condenses a backlog segment into an observation note (the model contract). */
  readonly observer: Model;
  /** The model that merges observations into a reflection; absent = no reflections ever. */
  readonly reflector?: Model | undefined;
  /** Volume thresholds; absent fields fall back to their defaults. */
  readonly thresholds?: ObservationalMemoryThresholds | undefined;
  /** The observation-record store; absent = the package's in-memory default. */
  readonly observations?: ObservationStore | undefined;
  /** How text volume is estimated; absent = a characters/4 heuristic per text. */
  readonly countTokens?: TokenCounter | undefined;
}

/** `thresholds.observation` default — estimated tokens of backlog that trigger one Observer pass. */
const DEFAULT_OBSERVATION_THRESHOLD = 1000;

/** `thresholds.reflection` default — estimated tokens of unreflected observations that trigger a Reflector pass. */
const DEFAULT_REFLECTION_THRESHOLD = 2000;

/** How far the backlog scan reads per port call when the read carried no `limit` to mirror. */
const DEFAULT_SCAN_PAGE = 10;

/** The character heuristic's divisor: four characters per estimated token. */
const CHARS_PER_TOKEN = 4;

/** The Observer's instruction (one system message; the backlog transcript rides the user message). */
const OBSERVER_INSTRUCTIONS =
  'You maintain the long-term memory of a conversation. Below is a chronological transcript of ' +
  'earlier messages that just left the conversation window. Write concise observation notes that ' +
  'preserve everything later turns may need: facts, names, numbers, identifiers, decisions, ' +
  'commitments, user preferences, and open threads. Write in the third person, past tense; no ' +
  'meta-commentary; output only the notes as plain text.';

/** The Reflector's instruction (one system message; reflection + observations ride the user message). */
const REFLECTOR_INSTRUCTIONS =
  'You maintain the long-term memory of a conversation. Merge the current reflection (if any) and ' +
  'the newer observation notes into a single updated reflection. Preserve every fact, decision, ' +
  'commitment and open thread; deduplicate and organize; keep it concise. Write in the third ' +
  'person; output only the updated reflection as plain text.';

/**
 * Wraps a `MemoryStore` with observational memory (the package's whole surface):
 *
 * ```ts
 * const memory = new Memory({
 *   storage: createObservationalMemoryStore({
 *     observer: openai('gpt-4o-mini'),
 *     reflector: openai('gpt-4o-mini'),
 *   }),
 *   lastMessages: 10,
 * });
 * ```
 *
 * A cursorless window read condenses the oldest unobserved stretch behind the window into
 * observations (one pass per read, oldest segment first — the cursor advances segment by segment),
 * merges accumulated observations into a reflection once they outgrow the reflection threshold, and
 * returns one derived system message ahead of the window: reflection, then unreflected
 * observations, then the window untouched. Paging with `before` is the raw read-back path: exact
 * cursor semantics, no compaction, no injection. Same-thread concurrent reads share one in-flight
 * pass (in-process dedup; cross-process duplication costs re-paid model calls, never correctness).
 * The wrapper forwards the port's full surface, so a working-memory-capable store stays
 * working-memory-capable through it; `deleteThread` cascades to the observation records.
 *
 * Composes with `@oribos/rag` on the same seam: RAG inner, observational memory outer (the read's
 * final rendering). The backlog boundary is the newest `limit` messages of what the wrapped store
 * returned, so messages RAG merged back into the result stay eligible for observation.
 */
export function createObservationalMemoryStore(
  config: ObservationalMemoryConfig & { readonly storage: WorkingMemoryStore },
): WorkingMemoryStore;
export function createObservationalMemoryStore(
  config: ObservationalMemoryConfig,
): MemoryStore;
export function createObservationalMemoryStore(
  config: ObservationalMemoryConfig,
): MemoryStore {
  const storage = config.storage ?? createInMemoryStore();
  const observer = assertObservationalModel(config.observer, 'observer');
  const reflector =
    config.reflector === undefined
      ? undefined
      : assertObservationalModel(config.reflector, 'reflector');
  const observationThreshold = assertPositiveInteger(
    config.thresholds?.observation ?? DEFAULT_OBSERVATION_THRESHOLD,
    'createObservationalMemoryStore: thresholds.observation',
  );
  const reflectionThreshold = assertPositiveInteger(
    config.thresholds?.reflection ?? DEFAULT_REFLECTION_THRESHOLD,
    'createObservationalMemoryStore: thresholds.reflection',
  );
  const observations = config.observations ?? createInMemoryObservationStore();
  assertObservationStore(observations);
  const countTokens = config.countTokens;
  if (countTokens !== undefined && typeof countTokens !== 'function') {
    throw new Error(
      'createObservationalMemoryStore: countTokens must be a function (texts) => counts',
    );
  }

  /** One in-flight compaction pass per thread: concurrent same-thread reads join, never double. */
  const inFlight = new Map<string, Promise<void>>();

  /** The last timestamp this wrapper issued — the monotonic clock of `nextTimestamp`. */
  let lastStamp = 0;

  /**
   * Issues a record's `createdAt`: strictly increasing per wrapper instance (never more than a
   * millisecond past the clock), so two records born in one pass — or one millisecond — still read
   * back in write order (`createdAt` asc, `id` asc as the store's tie-break is then never reached
   * within one writer; across writers a same-millisecond tie is best-effort).
   */
  function nextTimestamp(): Date {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp);
  }

  /** The rendered texts' estimated counts, one per text — the injected counter or the heuristic. */
  async function volumeCounts(texts: readonly string[]): Promise<readonly number[]> {
    if (texts.length === 0) return [];
    const counts =
      countTokens === undefined ? texts.map(estimateTokens) : await countTokens(texts);
    if (counts.length !== texts.length) {
      throw new Error(
        `createObservationalMemoryStore: countTokens returned ${counts.length} count(s) for ${texts.length} text(s) — one per text, in order, is the contract`,
      );
    }
    for (const count of counts) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        throw new Error(
          `createObservationalMemoryStore: countTokens must return non-negative finite numbers, got ${String(count)}`,
        );
      }
    }
    return counts;
  }

  /**
   * The backlog scan: pages strictly older than the window's oldest message until the first
   * observed message (the cursor — everything older is treated as already compacted) or the
   * thread's start, returning the collected messages oldest-first.
   */
  async function scanBacklog(
    threadId: string,
    oldestWindowMessageId: string,
    pageSize: number,
    observedMessageIds: ReadonlySet<string>,
  ): Promise<StoredMessage[]> {
    const backlog: StoredMessage[] = [];
    let cursor: string | undefined = oldestWindowMessageId;
    while (cursor !== undefined) {
      const page = await storage.listMessages({
        threadId,
        limit: pageSize,
        before: cursor,
        order: 'desc',
      });
      let boundary = false;
      for (const message of page) {
        if (observedMessageIds.has(message.id)) {
          boundary = true;
          break;
        }
        backlog.push(message);
      }
      if (boundary || page.length < pageSize) break;
      cursor = page[page.length - 1]?.id;
    }
    backlog.reverse();
    return backlog;
  }

  /**
   * One compaction pass for a thread: observe the oldest backlog segment when the backlog outgrows
   * the observation threshold, then reflect when the unreflected observations outgrow the
   * reflection threshold. Everything inline; one Observer / one Reflector call at most per pass.
   */
  async function runCompactionPass(
    threadId: string,
    window: readonly StoredMessage[],
    pageSize: number,
  ): Promise<void> {
    const oldestWindowMessage = window[0];
    if (oldestWindowMessage === undefined) return;
    const records = await observations.list(threadId);
    const observedMessageIds = new Set(
      records
        .filter((record) => record.kind === 'observation')
        .flatMap((record) => record.sourceIds),
    );
    const backlog = await scanBacklog(
      threadId,
      oldestWindowMessage.id,
      pageSize,
      observedMessageIds,
    );
    if (backlog.length > 0) {
      const texts = backlog.map(renderMessage);
      const counts = await volumeCounts(texts);
      const backlogVolume = sum(counts);
      if (backlogVolume > observationThreshold) {
        // "≈ threshold": accumulate the oldest messages until the segment reaches the threshold.
        let chunkLength = 0;
        let chunkVolume = 0;
        for (const count of counts) {
          chunkLength += 1;
          chunkVolume += count;
          if (chunkVolume >= observationThreshold) break;
        }
        const chunk = backlog.slice(0, chunkLength);
        const text = await callModel(
          observer,
          OBSERVER_INSTRUCTIONS,
          texts.slice(0, chunkLength).join('\n'),
          'observer',
        );
        const observation: ObservationRecord = {
          id: crypto.randomUUID(),
          threadId,
          resourceId: oldestWindowMessage.resourceId,
          createdAt: nextTimestamp(),
          kind: 'observation',
          sourceIds: chunk.map((message) => message.id),
          text,
        };
        await observations.save(observation);
        records.push(observation);
      }
    }
    if (reflector === undefined) return;
    const { reflection, unreflected } = splitRecords(records);
    if (unreflected.length === 0) return;
    const reflectedVolume = sum(await volumeCounts(unreflected.map((record) => record.text)));
    if (reflectedVolume <= reflectionThreshold) return;
    const text = await callModel(
      reflector,
      REFLECTOR_INSTRUCTIONS,
      reflectionInput(reflection, unreflected),
      'reflector',
    );
    await observations.save({
      id: crypto.randomUUID(),
      threadId,
      resourceId: oldestWindowMessage.resourceId,
      createdAt: nextTimestamp(),
      kind: 'reflection',
      sourceIds: [
        ...(reflection === undefined ? [] : [reflection.id]),
        ...unreflected.map((record) => record.id),
      ],
      text,
    });
  }

  /** The per-thread compaction gate: join the in-flight pass or run one, then settle. */
  async function compactIfNeeded(
    threadId: string,
    window: readonly StoredMessage[],
    pageSize: number,
  ): Promise<void> {
    const existing = inFlight.get(threadId);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const pass = runCompactionPass(threadId, window, pageSize);
    inFlight.set(threadId, pass);
    try {
      await pass;
    } finally {
      inFlight.delete(threadId);
    }
  }

  async function listMessagesWithObservation(
    query: ListMessagesQuery,
  ): Promise<StoredMessage[]> {
    // Paging (`before`) is the raw read-back path: exact cursor semantics, zero compaction,
    // zero injection — the single query entry's paging side stays side-effect free.
    if (query.before !== undefined) return storage.listMessages(query);
    const recalled = await storage.listMessages(query);
    if (recalled.length === 0) return recalled;
    // The backlog boundary is the newest `limit` messages — the raw window, so messages a lower
    // wrapper (e.g. @oribos/rag) merged back into the result stay eligible for observation.
    const chronological = [...recalled].sort(compareMessagesAsc);
    const window =
      query.limit === undefined ? chronological : chronological.slice(-query.limit);
    await compactIfNeeded(query.threadId, window, query.limit ?? DEFAULT_SCAN_PAGE);
    const blocks = observationBlocks(await observations.list(query.threadId));
    if (blocks.length === 0) return recalled;
    const anchor = chronological[0];
    if (anchor === undefined) return recalled;
    const derived = derivedMessage(query.threadId, blocks, anchor);
    // `order` flips presentation only; absent means the port's default (`'desc'`). The derived
    // block anchors at the chronological first position — leading for `'asc'`, trailing otherwise.
    return query.order === 'asc' ? [derived, ...recalled] : [...recalled, derived];
  }

  /**
   * Compile-time surface guard (ADR-0021): `MemoryStore` evolves additive-only, so a fixed object
   * literal would silently drop a future optional port method. The handled key set is derived from
   * the literal below plus the conditional resource pair — a key cannot be claimed without being
   * implemented. When the port gains a method, `Exclude` is no longer `never` and the package
   * fails to typecheck, naming the unhandled key; the author must forward or override it here.
   * Type-level only: no Proxy, no spread of the inner store.
   */
  const store = {
    getThreadById: (id) => storage.getThreadById(id),
    saveThread: (thread) => storage.saveThread(thread),
    deleteThread: async (id) => {
      await storage.deleteThread(id);
      await observations.deleteByThread(id);
    },
    listThreads: (query) => storage.listThreads(query),
    listMessages: (query) => listMessagesWithObservation(query),
    saveMessages: (messages) => storage.saveMessages(messages),
  } satisfies MemoryStore;

  /** The keys this wrapper handles: everything the literal implements plus the conditional pair. */
  type HandledMemoryStoreKey = keyof typeof store | 'getResource' | 'saveResource';

  /** Constraint carrier: an unhandled port key is a compile error here, named in the message. */
  type AssertNever<T extends never> = T;

  type MemoryStoreSurfaceComplete = AssertNever<
    Exclude<keyof MemoryStore, HandledMemoryStoreKey>
  >;

  /** `Record<never, never>` adds nothing; a new port key becomes a required `never` property. */
  type StoreWithCompleteSurface = typeof store & Record<MemoryStoreSurfaceComplete, never>;

  const guardedStore: StoreWithCompleteSurface = store;

  // Capability passthrough: the conditional resource pair is forwarded when the wrapped store
  // declares it, so working memory works unchanged through the wrapper.
  return supportsWorkingMemory(storage)
    ? {
        ...guardedStore,
        getResource: (id) => storage.getResource(id),
        saveResource: (resource) => storage.saveResource(resource),
      }
    : guardedStore;
}

/**
 * The in-memory `ObservationStore` default: a Map of records, zero dependencies and zero process
 * footprint — the whole store lives and dies with the wrapper. Records are treated as immutable
 * once saved (the package never rewrites one; upsert by id is the port's shape, not a pattern it
 * uses). `list` orders chronologically; `deleteByThread` drops a thread's records.
 */
export function createInMemoryObservationStore(): ObservationStore {
  const records = new Map<string, ObservationRecord>();
  return {
    list: async (threadId) => {
      const threadRecords = [...records.values()].filter(
        (record) => record.threadId === threadId,
      );
      threadRecords.sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return threadRecords;
    },
    save: async (record) => {
      records.set(record.id, record);
    },
    deleteByThread: async (threadId) => {
      for (const [id, record] of records) {
        if (record.threadId === threadId) records.delete(id);
      }
    },
  };
}

/** The injectable blocks of one derived message, in presentation order. */
interface ObservationBlock {
  readonly kind: ObservationRecord['kind'];
  readonly text: string;
}

/**
 * The records' injectable view: the latest reflection first (it subsumes every earlier reflection
 * and the observations it covered), then the observations no reflection covers yet — in
 * chronological order. Returns empty when there is nothing to inject.
 */
function observationBlocks(records: readonly ObservationRecord[]): ObservationBlock[] {
  const { reflection, unreflected } = splitRecords(records);
  const blocks: ObservationBlock[] = [];
  if (reflection !== undefined) blocks.push({ kind: 'reflection', text: reflection.text });
  for (const record of unreflected) blocks.push({ kind: 'observation', text: record.text });
  return blocks;
}

/**
 * Splits records into the latest reflection and the observations it does not (transitively)
 * cover — the reflection chain is followed through record-id `sourceIds`, so a reflection that
 * merged a prior reflection covers everything the prior one covered.
 */
function splitRecords(records: readonly ObservationRecord[]): {
  reflection: ObservationRecord | undefined;
  unreflected: ObservationRecord[];
} {
  let reflection: ObservationRecord | undefined;
  for (let position = records.length - 1; position >= 0; position -= 1) {
    const record = records[position];
    if (record !== undefined && record.kind === 'reflection') {
      reflection = record;
      break;
    }
  }
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const covered = new Set<string>();
  if (reflection !== undefined) {
    const stack = [...reflection.sourceIds];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || covered.has(id)) continue;
      covered.add(id);
      const record = byId.get(id);
      if (record !== undefined && record.kind === 'reflection') stack.push(...record.sourceIds);
    }
  }
  const unreflected = records.filter(
    (record) => record.kind === 'observation' && !covered.has(record.id),
  );
  return { reflection, unreflected };
}

/** The one derived system message: reflection block → observation blocks → (the window follows). */
function derivedMessage(
  threadId: string,
  blocks: readonly ObservationBlock[],
  anchor: StoredMessage,
): StoredMessage {
  const content = [
    'Compacted notes from earlier in this conversation:',
    ...blocks.map((block) => `[${block.kind}] ${block.text}`),
  ].join('\n\n');
  return {
    role: 'system',
    content,
    id: crypto.randomUUID(),
    threadId,
    resourceId: anchor.resourceId,
    createdAt: anchor.createdAt,
  };
}

/** The Reflector's user message: the current reflection (if any) and the observations to merge. */
function reflectionInput(
  reflection: ObservationRecord | undefined,
  unreflected: readonly ObservationRecord[],
): string {
  const sections: string[] = [];
  if (reflection !== undefined) sections.push(`Current reflection:\n${reflection.text}`);
  sections.push(
    `New observations:\n${unreflected.map((record) => `- ${record.text}`).join('\n')}`,
  );
  return sections.join('\n\n');
}

/** One model call: instruction + input, returning the trimmed text (empty = an explicit error). */
async function callModel(
  model: Model,
  instructions: string,
  input: string,
  role: 'observer' | 'reflector',
): Promise<string> {
  const result = await model.doGenerate({
    prompt: [
      { role: 'system', content: instructions },
      { role: 'user', content: [{ type: 'text', text: input }] },
    ],
  });
  const text = result.content
    .filter((part): part is ModelTextContent => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (text === '') {
    throw new Error(`createObservationalMemoryStore: the ${role} model returned no text`);
  }
  return text;
}

/**
 * A message's transcript rendering — what the Observer reads and what volume is estimated on:
 * the role, then the model-visible content (text parts, file markers, tool calls and their
 * results; reasoning is model-internal and stays out).
 */
function renderMessage(message: StoredMessage): string {
  return `${message.role}: ${messageBody(message)}`;
}

/** The model-visible body of a message, parts joined by newlines. */
function messageBody(message: ModelMessage): string {
  switch (message.role) {
    case 'system':
      return message.content;
    case 'user':
      return joinParts(
        message.content.map((part) =>
          part.type === 'text' ? part.text : `[file: ${part.mediaType}]`,
        ),
      );
    case 'assistant':
      return joinParts(
        message.content.map((part) => {
          switch (part.type) {
            case 'text':
              return part.text;
            case 'file':
              return `[file: ${part.mediaType}]`;
            case 'custom':
              return `[custom: ${part.kind}]`;
            case 'tool-call':
              return `[tool call: ${part.toolName}(${renderJson(part.input)})]`;
            case 'tool-result':
              return `[tool result: ${part.toolName} → ${renderToolOutput(part.output)}]`;
            default:
              return undefined;
          }
        }),
      );
    case 'tool':
      return joinParts(message.content.map((part) => renderToolPart(part)));
  }
}

/** A tool-role part's rendering (tool results and approval decisions). */
function renderToolPart(part: ModelToolResultPart | ModelToolApprovalResponsePart): string | undefined {
  if (part.type === 'tool-result') {
    return `[tool result: ${part.toolName} → ${renderToolOutput(part.output)}]`;
  }
  return `[tool approval: ${part.approved ? 'approved' : 'denied'} (${part.approvalId})]`;
}

/** A tool result's rendering, per output arm of the model contract. */
function renderToolOutput(output: ModelToolResultOutput): string {
  switch (output.type) {
    case 'text':
      return output.value;
    case 'json':
      return renderJson(output.value);
    case 'execution-denied':
      return output.reason === undefined ? 'denied' : `denied: ${output.reason}`;
    case 'error-text':
      return `error: ${output.value}`;
    case 'error-json':
      return `error: ${renderJson(output.value)}`;
    case 'content':
      return output.value
        .map((inner) => {
          if (inner.type === 'text') return inner.text;
          return inner.type === 'file' ? `[file: ${inner.mediaType}]` : '[custom]';
        })
        .join('\n');
  }
}

/** Parts joined by newlines, empty renderings dropped. */
function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n');
}

/** JSON rendering that never throws (a non-serializable input degrades to its string form). */
function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The default volume estimate: four characters per estimated token, at least one. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Chronological order, mirroring the port's listing convention (`createdAt` asc, `id` asc). */
function compareMessagesAsc(a: StoredMessage, b: StoredMessage): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A threshold or knob is a positive integer or a configuration bug. */
function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

/** The model contract's check, with the role named — resolution-time, before any run. */
function assertObservationalModel(value: unknown, role: string): Model {
  try {
    return assertModel(value);
  } catch (error) {
    throw new Error(
      `createObservationalMemoryStore: ${role} — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The observation store's shape check: the port's three methods, all present or a bug. */
function assertObservationStore(store: ObservationStore): void {
  if (
    typeof store.list !== 'function' ||
    typeof store.save !== 'function' ||
    typeof store.deleteByThread !== 'function'
  ) {
    throw new Error(
      'createObservationalMemoryStore: observations must implement list / save / deleteByThread',
    );
  }
}

/** Sum of counts. */
function sum(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) total += count;
  return total;
}
