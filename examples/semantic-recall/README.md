# semantic-recall

Older relevant messages pulled back into a small recall window by the RAG capability of
`@oribos/rag`: `createSemanticMemoryStore` wraps the store, `Memory.save` indexes every
persisted message with the embedding model, and the window `memory.recall` returns is merged
with semantically related older messages — the recall the agent always made, made semantic.
Oribos is a TypeScript agent framework with zero runtime dependencies — compose only what you
use, run anywhere.

The example is a single file (`src/index.ts`) with teaching stubs — a deterministic keyword
embedding "model" and a scripted chat model — **no API key and no network**. Three acts:

1. **Save indexes.** Seeding the conversation hands every message's text to the embedder and
   the vector index — observable right on the stubs.
2. **Recall merges.** With a `lastMessages: 3` window, a follow-up question about the sofa
   pulls the long-buried cat fact back into `memory.recall`'s result in chronological position;
   the unrelated dog fact stays out.
3. **The agent sees it.** Two runs on one agent: the second run's model prompt contains the cat
   fact ahead of the recent window — semantic recall reached the model through the ordinary
   `recall` call.

A real deployment swaps the stub embedder for e.g. `openai.textEmbeddingModel(...)` — the same
contract — and optionally the in-memory vector index for an external vector store's
`VectorIndex` adapter.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-semantic-recall start
```

The script self-asserts; a missing index, an un-merged fact, or a prompt without the old
message exits 1.
