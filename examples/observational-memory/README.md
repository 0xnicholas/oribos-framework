# observational-memory

Older messages that leave the recall window, condensed by the model into observation notes —
and observations merged into a reflection once they accumulate — by the observational-memory
capability of `@oribos/observational-memory`: `createObservationalMemoryStore` wraps the store, and
the compaction happens inline, inside the `memory.recall` call that read the thread. The recall
the agent always made keeps its own memory. Oribos is a TypeScript agent framework with zero
runtime dependencies — compose only what you use, run anywhere.

The example is a single file (`src/index.ts`) with teaching stubs — a flat volume "tokenizer" and
scripted Observer / Reflector models that echo what they were shown — **no API key and no
network**. Six acts:

1. **Over the threshold observes.** A 12-turn thread, a `lastMessages: 2` window: the backlog
   behind the window outgrows the tiny teaching threshold, one Observer pass runs inside the
   recall, and the result is one prepended system block plus the untouched window.
2. **The cursor advances.** The next recall observes the next segment — never the same turns
   twice; the block lists notes oldest-first.
3. **Reflection merges.** Three accumulated notes cross the reflection threshold; one Reflector
   pass collapses them into a reflection, the covered notes stop being listed separately.
4. **Paging passes through.** A `before` read equals the bare store's answer byte for byte: zero
   model calls, zero records.
5. **Unwrapped costs nothing.** The same thread on a plain `Memory`: the window and nothing else.
6. **It composes with `@oribos/rag`.** RAG inner (its semantic merge pulls a long-buried fact back
   into the result), observational memory outer (its block renders ahead of the window) — one
   store seam, both enhancements.

A real deployment swaps the stubs for provider models — e.g. `openai('gpt-4o-mini')` for both the
Observer and the Reflector — the same model contract — and brings an `ObservationStore`
implementation (a database) when records should survive restarts.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-observational-memory start
```

The script self-asserts; a missed observation, a repeated segment, a duplicated note after
reflection, a paged read that differs from the bare store, or an unwrapped recall with a derived
block exits 1.
