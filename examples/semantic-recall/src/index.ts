/**
 * Oribos semantic-recall example — older relevant messages pulled back into a small recall
 * window by the RAG capability package.
 *
 * One script, no external services: the embedding model is a local deterministic stub (keyword
 * → basis vector, the same trick the tests use) and the chat model is a scripted stub — no API
 * key, no network. The story is told by what `recall` returns and what the model actually
 * receives.
 *
 * The seam is the store: `createSemanticMemoryStore` wraps the core's in-memory store, and
 * `new Memory({ storage })` is the only wiring. Nothing else about the agent changes.
 *
 * The acts:
 *
 * 1. **Save indexes.** Seeding the conversation hands every message's text to the embedder and
 *    the vector index — observable right on the teaching stubs.
 * 2. **Recall merges.** With a `lastMessages: 3` window, a follow-up question about the sofa
 *    pulls the long-buried cat fact back into `memory.recall`'s result, in chronological
 *    position; the unrelated dog fact stays out.
 * 3. **The agent sees it.** Two runs on one agent: the second run's model prompt contains the
 *    cat fact ahead of the recent window — semantic recall reached the model through the same
 *    `recall` call the agent always makes.
 *
 * The script self-asserts (`node:assert/strict`): a missing index, an un-merged fact, or a
 * model prompt without the old message exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-semantic-recall start
 */
import assert from 'node:assert/strict';
import { Agent } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { createSemanticMemoryStore } from '@oribos/rag';
import type { Embedder, VectorEntry } from '@oribos/rag';
import type { Model, ModelCallOptions, ModelMessage, ModelStreamPart } from '@oribos/core/model';

// ── Teaching stubs: a deterministic embedder and a scripted model ──────────────────────────────

/**
 * The example's embedding "model": known keywords map to basis vectors (`cat|sofa` → e1,
 * `dog` → e2, `report` → e3), so cosine similarity is exact and readable. A real deployment
 * passes e.g. `openai.textEmbeddingModel('text-embedding-3-small')` — the same contract.
 */
const INDEXED_TEXTS: string[] = [];
const embedder: Embedder = {
  specificationVersion: 'v4',
  provider: 'example',
  modelId: 'keyword-basis',
  doEmbed: async ({ values }) => {
    INDEXED_TEXTS.push(...values);
    return {
      embeddings: values.map((text) => {
        const vector = [0, 0, 0];
        if (/cat|sofa/.test(text)) vector[0] = 1;
        if (/dog/.test(text)) vector[1] = 1;
        if (/report/.test(text)) vector[2] = 1;
        return vector;
      }),
    };
  },
};

/** The vector index, made observable: the acts assert what actually landed in it. */
const INDEX: VectorEntry[] = [];
const observedIndex = {
  upsert: async (entries: readonly VectorEntry[]) => {
    INDEX.push(...entries);
  },
  query: async (embedding: readonly number[], { topK, threadId }: { topK: number; threadId?: string }) =>
    INDEX.filter((entry) => threadId === undefined || entry.threadId === threadId)
      .map((entry) => ({
        entry,
        score: entry.embedding.reduce(
          (dot, value, position) => dot + value * (embedding[position] ?? 0),
          0,
        ),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
  deleteByThread: async (threadId: string) => {
    for (let position = INDEX.length - 1; position >= 0; position -= 1) {
      if (INDEX[position]?.threadId === threadId) INDEX.splice(position, 1);
    }
  },
};

/** A minimal scripted `Model` (the vendor contract) that records every prompt it receives. */
function scriptedModel(script: readonly string[]) {
  const calls: ModelCallOptions[] = [];
  let answered = 0;
  const model: Model & { readonly calls: ModelCallOptions[] } = {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'chat-stub',
    calls,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async (call) => {
      calls.push({ ...call, prompt: structuredClone(call.prompt) });
      const text = script[answered];
      answered += 1;
      if (text === undefined) {
        throw new Error(`script exhausted after ${script.length} answer(s)`);
      }
      const parts: ModelStreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: text },
        { type: 'text-end', id: 'text-0' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 24, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 12, text: undefined, reasoning: undefined },
          },
        },
      ];
      return {
        stream: new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return model;
}

/** 消息正文(断言打印用):system 直取字符串,其余拼 text 部分。 */
function textOf(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// ── The wiring under test: the store seam, nothing else ────────────────────────────────────────

const memory = new Memory({
  storage: createSemanticMemoryStore({
    storage: undefined, // the core's in-memory default; a SQLite adapter would slot in here
    embedder,
    index: observedIndex,
  }),
  lastMessages: 3,
});

console.log('semantic-recall — @oribos/rag pulling older relevant messages back into the window.');

// ── Act 1 — save indexes: every text reaches the embedder and the vector index ────────────────

console.log('\n──────── Act 1 — saving a conversation indexes it ────────');
{
  const CONVERSATION = [
    'The cat sleeps on the sofa.',
    'The dog barks at the mail carrier.',
    'File the quarterly report.',
    'Review the quarterly report.',
    'Publish the quarterly report.',
  ] as const;
  for (const text of CONVERSATION) {
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    });
  }

  // All five texts went through the embedder; the index holds them keyed by message id.
  assert.deepEqual(INDEXED_TEXTS, [...CONVERSATION]);
  assert.equal(INDEX.length, 5);
  assert.ok(INDEX.every((entry) => entry.threadId === 'thread-1' && entry.resourceId === 'user-1'));
  console.log(`embedder saw ${INDEXED_TEXTS.length} texts; index holds ${INDEX.length} entries.`);
}

// ── Act 2 — recall merges: the buried cat fact returns, the dog fact stays out ────────────────

console.log('\n──────── Act 2 — a follow-up question merges the old fact back ────────');
{
  await memory.save({
    thread: 'thread-1',
    resource: 'user-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Where does the cat sleep?' }] }],
  });

  const recalled = await memory.recall({ threadId: 'thread-1' });
  const texts = recalled.map(textOf);

  // The window alone would be three messages of reports + the question. The cat fact — older
  // than the window — is back, first, in chronological position; the dog fact is not.
  assert.ok(texts.includes('The cat sleeps on the sofa.'), 'the cat fact was merged back');
  assert.ok(!texts.includes('The dog barks at the mail carrier.'), 'the dog fact stayed out');
  assert.equal(texts[0], 'The cat sleeps on the sofa.');
  console.log('recall returned:');
  for (const text of texts) console.log(`  · ${JSON.stringify(text)}`);
}

// ── Act 3 — the agent sees it: the old fact is in the second run's prompt ─────────────────────

console.log('\n──────── Act 3 — the model receives the merged history ────────');
{
  const model = scriptedModel(['on the sofa', 'still on the sofa']);
  const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model, memory });

  // Run 1: the question lands in history (the window at recall time is all reports).
  const first = await agent.generate('Where does the cat sleep?', {
    memory: { thread: 'thread-1', resource: 'user-1' },
  });
  // Run 2: the window is reports + the exchange; the question drives the semantic query.
  const second = await agent.generate('Anything else about naps?', {
    memory: { thread: 'thread-1', resource: 'user-1' },
  });

  const prompt = model.calls[1]?.prompt ?? [];
  const texts = prompt.map(textOf);
  const catFactPosition = texts.indexOf('The cat sleeps on the sofa.');
  assert.ok(catFactPosition > 0 && catFactPosition < texts.length - 1, 'the cat fact is in the second prompt');
  assert.ok(!texts.includes('The dog barks at the mail carrier.'));
  assert.equal(first.text, 'on the sofa');
  assert.equal(second.text, 'still on the sofa');
  console.log('run 2 prompt:');
  for (const text of texts) console.log(`  · ${JSON.stringify(text)}`);
}

console.log('\nDone — one wrapped store, and the recall the agent always made became semantic.');
