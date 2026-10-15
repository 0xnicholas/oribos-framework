/**
 * Oribos observational-memory example — older messages that leave the recall window are condensed
 * into observation notes and reflections, inline in the recall that read them.
 *
 * One script, no external services: the Observer and the Reflector are local scripted stubs that
 * echo which turns they were shown — no API key, no network. The story is told by what `recall`
 * returns, what the model stubs actually received, and how the observation store fills up.
 *
 * The seam is the store: `createObservationalMemoryStore` wraps the core's in-memory store, and
 * `new Memory({ storage })` is the only wiring. Nothing else about the agent changes.
 *
 * The acts:
 *
 * 1. **Over the threshold observes.** A long thread with a `lastMessages: 2` window: the oldest
 *    unobserved stretch behind the window outgrows the tiny teaching threshold, one Observer pass
 *    runs inside the recall, and the result is the window plus one prepended system block.
 * 2. **The cursor advances.** The next recall observes the next segment — never the same turns
 *    twice; the blocks accumulate in chronological order.
 * 3. **Reflection merges.** Once the accumulated observations outgrow the reflection threshold, a
 *    Reflector pass merges them: the block becomes the reflection, the covered notes stop being
 *    listed, and later notes append after it.
 * 4. **Paging passes through.** A `before` read is the raw read-back path: byte-for-byte the bare
 *    store's answer, zero model calls, zero records.
 * 5. **Unwrapped costs nothing.** The same thread on a plain `Memory`: no wrapper, no calls, the
 *    window and nothing else.
 * 6. **It composes with `@oribos/rag`.** RAG inner (its merge pulls an old fact back into the
 *    result), observational memory outer (its block renders ahead of the window) — one seam, both
 *    enhancements, no interference.
 *
 * The script self-asserts (`node:assert/strict`): a missed observation, a repeated segment, a
 * duplicated note after reflection, a paged read that differs from the bare store, or an
 * unwrapped recall with a derived block exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-observational-memory start
 */
import assert from 'node:assert/strict';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { StoredMessage } from '@oribos/core/memory';
import {
  createInMemoryObservationStore,
  createObservationalMemoryStore,
} from '@oribos/observational-memory';
import { createSemanticMemoryStore } from '@oribos/rag';
import type { Embedder } from '@oribos/rag';
import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '@oribos/core/model';

// ── Teaching stubs: a flat "tokenizer" and two scripted models ─────────────────────────────────

/** A flat volume counter: five per text — the threshold arithmetic stays readable in the acts. */
const countEach = (texts: readonly string[]): number[] => texts.map(() => 5);

/** Message text (for assertions): system content directly, text parts joined otherwise. */
function textOf(message: StoredMessage | ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The user text a stub received (the transcript / merge input the package built). */
function promptUserText(call: ModelCallOptions): string {
  const prompt: ModelPrompt = call.prompt;
  const user = prompt[prompt.length - 1];
  return user === undefined ? '' : textOf(user);
}

/** The turns a transcript mentions, e.g. `01,02` — what the Observer stub echoes back. */
function noteFor(text: string): string {
  const seen = [...text.matchAll(/Turn (\d+)/g)].map((match) => match[1] ?? '');
  if (seen.length > 0) return `NOTE(turns: ${[...new Set(seen)].sort().join(',')})`;
  const first = (text.split('\n')[0] ?? '').replace(/^user: /, '');
  return `NOTE(${first.slice(0, 60)})`;
}

/** A scripted Observer: echoes the turns it was shown, records every input. */
function scriptedObserver(): Model & { readonly inputs: readonly string[] } {
  const inputs: string[] = [];
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'observer-stub',
    inputs,
    doGenerate: async (call) => {
      const input = promptUserText(call);
      inputs.push(input);
      return {
        content: [{ type: 'text', text: noteFor(input) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error('the example observer only generates');
    },
  };
}

/** A scripted Reflector: reports how many notes it merged, records every input. */
function scriptedReflector(): Model & { readonly inputs: readonly string[] } {
  const inputs: string[] = [];
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'reflector-stub',
    inputs,
    doGenerate: async (call) => {
      const input = promptUserText(call);
      inputs.push(input);
      const merged = input.split('\n').filter((line) => line.startsWith('- ')).length;
      return {
        content: [{ type: 'text', text: `REFLECTION(merged ${merged} notes)` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error('the example reflector only generates');
    },
  };
}

/** A deterministic keyword embedder (the same trick the RAG example uses) for the composition act. */
const embedder: Embedder = {
  specificationVersion: 'v4',
  provider: 'example',
  modelId: 'keyword-basis',
  doEmbed: async ({ values }) => ({
    embeddings: values.map((text) => {
      const vector = [0, 0, 0];
      if (/cat|sofa/.test(text)) vector[0] = 1;
      if (/dog/.test(text)) vector[1] = 1;
      if (/report/.test(text)) vector[2] = 1;
      return vector;
    }),
  }),
};

/** Seed `n` turns into a thread; returns the stored messages (ids for paging assertions). */
async function seed(memory: Memory, thread: string, turns: number): Promise<StoredMessage[]> {
  const saved: StoredMessage[] = [];
  for (let index = 1; index <= turns; index += 1) {
    const label = String(index).padStart(2, '0');
    const [message] = await memory.save({
      thread,
      resource: 'user-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: `Turn ${label} matters.` }] }],
    });
    assert.ok(message !== undefined);
    saved.push(message);
  }
  return saved;
}

// ── The wiring under test: the store seam, nothing else ────────────────────────────────────────

const base = createInMemoryStore();
const observations = createInMemoryObservationStore();
const observer = scriptedObserver();
const reflector = scriptedReflector();
const memory = new Memory({
  storage: createObservationalMemoryStore({
    storage: base, // the core's in-memory default; a SQLite adapter would slot in here
    observer,
    reflector,
    observations,
    thresholds: { observation: 10, reflection: 12 }, // teaching thresholds: 2 messages / 3 notes
    countTokens: countEach,
  }),
  lastMessages: 2,
});

console.log('observational-memory — older messages condensed inline, by the recall that read them.');

// ── Act 1 — over the threshold observes: the oldest segment + one prepended block ─────────────

console.log('\n──────── Act 1 — a long thread: the oldest stretch gets observed ────────');
{
  const saved = await seed(memory, 'thread-1', 12);

  const first = await memory.recall({ threadId: 'thread-1' });

  // One Observer pass, inside this recall: the oldest unobserved segment (turns 01–02), not more.
  assert.equal(observer.inputs.length, 1);
  assert.match(observer.inputs[0] ?? '', /Turn 01/);
  assert.match(observer.inputs[0] ?? '', /Turn 02/);
  assert.doesNotMatch(observer.inputs[0] ?? '', /Turn 03/);

  // The result: one derived system block ahead of the window; the window itself untouched.
  assert.equal(first.length, 3);
  assert.equal(first[0]?.role, 'system');
  assert.match(textOf(first[0]!), /NOTE\(turns: 01,02\)/);
  assert.match(textOf(first[0]!), /^Compacted notes from earlier in this conversation:/);
  assert.deepEqual(first.slice(1), [saved[10], saved[11]]);

  const records = await observations.list('thread-1');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, 'observation');
  assert.deepEqual(records[0]?.sourceIds, [saved[0]?.id, saved[1]?.id]);
  console.log(`observer saw turns 01–02; recall returned the block + window (${first.length} messages).`);
}

// ── Act 2 — the cursor advances: the next recall observes the next segment ────────────────────

console.log('\n──────── Act 2 — the cursor walks forward, segment by segment ────────');
{
  const second = await memory.recall({ threadId: 'thread-1' });

  assert.equal(observer.inputs.length, 2);
  assert.match(observer.inputs[1] ?? '', /Turn 03/);
  assert.match(observer.inputs[1] ?? '', /Turn 04/);
  assert.doesNotMatch(observer.inputs[1] ?? '', /Turn 01/); // never observed twice

  const block = textOf(second[0]!);
  assert.match(block, /NOTE\(turns: 01,02\)/);
  assert.match(block, /NOTE\(turns: 03,04\)/);
  // Chronological: the earlier note is listed first.
  assert.ok(block.indexOf('NOTE(turns: 01,02)') < block.indexOf('NOTE(turns: 03,04)'));
  console.log('observer saw turns 03–04; the block now lists both notes, oldest first.');
}

// ── Act 3 — reflection merges: covered notes collapse into one reflection ─────────────────────

console.log('\n──────── Act 3 — three notes: the Reflector merges them ────────');
{
  const third = await memory.recall({ threadId: 'thread-1' });

  assert.equal(observer.inputs.length, 3); // turns 05–06 observed this recall
  assert.equal(reflector.inputs.length, 1); // three accumulated notes crossed the threshold
  assert.match(reflector.inputs[0] ?? '', /- NOTE\(turns: 01,02\)/);
  assert.match(reflector.inputs[0] ?? '', /- NOTE\(turns: 05,06\)/);

  const block = textOf(third[0]!);
  assert.match(block, /\[reflection\] REFLECTION\(merged 3 notes\)/);
  assert.doesNotMatch(block, /NOTE\(turns: 01,02\)/); // covered — no duplicate listing
  assert.doesNotMatch(block, /\[observation\]/);
  console.log('reflection holds turns 01–06; the covered notes are no longer listed separately.');
}

// ── Act 4 — paging passes through: the raw read-back path, zero side effects ──────────────────

console.log('\n──────── Act 4 — a `before` read is the bare store, byte for byte ────────');
{
  const all = await base.listMessages({ threadId: 'thread-1', order: 'asc' });
  const newest = all[all.length - 1]!;
  const callsBefore = observer.inputs.length + reflector.inputs.length;

  const paged = await memory.recall({ threadId: 'thread-1', before: newest.id });
  const expected = await base.listMessages({
    threadId: 'thread-1',
    limit: 2,
    order: 'asc',
    before: newest.id,
  });

  assert.deepEqual(paged, expected); // no derived block, no rewriting
  assert.equal(observer.inputs.length + reflector.inputs.length, callsBefore); // zero model calls
  console.log(`paged back ${paged.length} raw messages — identical to the bare store, no calls.`);
}

// ── Act 5 — unwrapped costs nothing: the same thread on a plain Memory ────────────────────────

console.log('\n──────── Act 5 — without the wrapper, nothing exists ────────');
{
  const plain = new Memory({ lastMessages: 2 });
  await seed(plain, 'thread-plain', 12);
  const callsBefore = observer.inputs.length;

  const recalled = await plain.recall({ threadId: 'thread-plain' });

  assert.equal(recalled.length, 2); // the window, and nothing else
  assert.ok(recalled.every((message) => message.role === 'user'));
  assert.equal(observer.inputs.length, callsBefore); // the observer was never involved
  console.log('plain recall returned the 2-message window; zero model calls, zero records.');
}

// ── Act 6 — it composes with @oribos/rag: RAG inner, observational memory outer ───────────────

console.log('\n──────── Act 6 — composed with @oribos/rag: both enhancements, one seam ────────');
{
  const ragObserver = scriptedObserver();
  const composed = new Memory({
    storage: createObservationalMemoryStore({
      storage: createSemanticMemoryStore({ embedder }),
      observer: ragObserver,
      thresholds: { observation: 10 },
      countTokens: countEach,
    }),
    lastMessages: 1,
  });
  for (const text of [
    'The cat sleeps on the sofa.',
    'File the quarterly report.',
    'Review the quarterly report.',
  ]) {
    await composed.save({
      thread: 'thread-rag',
      resource: 'user-1',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    });
  }
  await composed.save({
    thread: 'thread-rag',
    resource: 'user-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Where does the cat sleep?' }] }],
  });

  const recalled = await composed.recall({ threadId: 'thread-rag' });
  const texts = recalled.map((message) => textOf(message));

  assert.equal(recalled[0]?.role, 'system'); // the observation block renders first (OM outer)
  assert.match(texts[0] ?? '', /^Compacted notes/);
  assert.ok(ragObserver.inputs.length >= 1); // the long backlog was observed on this read
  // RAG's merge pulled the long-buried cat fact back into the same result (inner layer).
  assert.ok(texts.some((text) => text.includes('The cat sleeps on the sofa.')));
  console.log('composed recall:');
  for (const text of texts) console.log(`  · ${JSON.stringify(text)}`);
}

console.log('\nDone — one wrapped store, and the recall the agent always made keeps its own memory.');
