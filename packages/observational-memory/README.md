# @oribos/observational-memory

Compaction over message history that stays inside the request that read it — the observational
memory capability package. It wraps a `MemoryStore` so that older messages which have left the
recall window are condensed into observation notes by your model, and accumulated observations
are merged into a reflection, all inline in the `memory.recall` that triggered it. One seam, no
core changes:

```ts
import { Memory } from '@oribos/core/memory';
import { createObservationalMemoryStore } from '@oribos/observational-memory';
import { openai } from '@ai-sdk/openai';

const memory = new Memory({
  storage: createObservationalMemoryStore({
    observer: openai('gpt-4o-mini'),
    reflector: openai('gpt-4o-mini'),
  }),
  lastMessages: 10,
});
```

## How it works

- **Over the threshold observes.** A cursorless window read computes the backlog behind the
  window (messages older than it that no observation covers yet). When its estimated volume
  exceeds the observation threshold, one Observer pass runs inside that read: the oldest segment
  (≈ the threshold in volume) is condensed into an observation note. The next read observes the
  next segment — the cursor advances step by step, oldest first.
- **Over the reflection threshold reflects.** Accumulated unreflected observations that outgrow
  the reflection threshold are merged — with the current reflection — into one updated reflection
  by the `reflector` model. Without a `reflector`, observations simply accumulate.
- **Reads render the derived blocks.** A cursorless read returns one derived system message ahead
  of the window: the reflection, then the unreflected observations, then the window untouched.
  Paging with `before` is the raw read-back path: exact cursor semantics, no compaction, no
  injection, zero model calls.
- **Request-inline, zero-cost when unwrapped.** No post-response write, no drain, zero timers —
  compaction happens only inside a cursorless read the application itself made. Without this
  wrapper the core's memory path is untouched.
- **Pins kept.** Messages are immutable (observations and reflections are additive derived
  records), `recall` stays the single query entry, same-thread concurrent reads share one
  in-flight pass (in-process dedup), `deleteThread` cascades to the records, and the wrapped
  store's working-memory capability passes through.

## The observation store

Observation records are the package's own port — `ObservationStore`: `list(threadId)`,
`save(record)`, `deleteByThread(threadId)` — with
`{ id, threadId, resourceId, createdAt, kind: 'observation' | 'reflection', sourceIds, text }`
records. `createInMemoryObservationStore()` ships as the zero-dependency default; persistence (a
database, a file) is your implementation of the port. Losing records across restarts never costs
correctness — the next recall re-observes what it can no longer see as observed (a re-paid model
call, not a lost fact). Composes with `@oribos/rag` on the same seam: RAG inner, observational
memory outer.

## Thresholds and models

`thresholds: { observation, reflection }` are estimated-token volumes, defaulting to `1000` and
`2000`. Volume is estimated by `countTokens(texts) => counts` when provided (one count per text,
in order); otherwise a characters/4 heuristic applies. Both models follow the framework's model
contract — pass the language model from any AI SDK provider package, no adapter, no registry. A
model error (or empty output) rejects the read explicitly; the known limitation is that the read
path carries no abort signal, so a compaction call is not cancelled with the run.

See `docs/architecture/memory.md` (「观察记忆」) and `examples/observational-memory`.
