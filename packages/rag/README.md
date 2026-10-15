# @oribos/rag

Semantic recall over message history — the RAG capability package. It wraps a `MemoryStore` so
that every message `Memory.save` persists is indexed with your embedding model, and the window
`Memory.recall` returns is merged with older, semantically related messages. One seam, no core
changes:

```ts
import { Memory } from '@oribos/core/memory';
import { createSemanticMemoryStore } from '@oribos/rag';
import { openai } from '@ai-sdk/openai';

const memory = new Memory({
  storage: createSemanticMemoryStore({
    embedder: openai.textEmbeddingModel('text-embedding-3-small'),
  }),
  lastMessages: 10,
});
```

## How it works

- **Save indexes.** `createSemanticMemoryStore` wraps any `MemoryStore` (absent = the core's
  in-memory default). Each persisted message's text (system / user / assistant text parts) goes
  to the embedder and into a vector index — inline, within the save call. Messages persist
  first; an embedder failure rejects the save explicitly.
- **Recall merges.** A cursorless window read embeds the window's last user message and merges
  positively-similar older messages back into the result, in chronological position — the
  recall window forgets less. Paging with `before` passes through untouched; an empty or
  textless window spends no embedding. `topK` defaults to 3.
- **Pins kept.** Messages are immutable (the index is a derived cache of full stored messages),
  `recall` stays the single query entry, `deleteThread` cascades to the index, and the
  working-memory capability of the wrapped store passes through.

The embedder follows the framework's model contract pattern: a vendored structural subset of the
AI SDK provider specification's embedding model interface (`v4`). Any embedding model instance
from a provider package satisfies it — no adapter, no registry. The vector index is the package's
own port: `createInMemoryVectorIndex()` ships as the zero-dependency default; an external vector
database rides as your `VectorIndex` implementation, so its dependency travels with this package
(or your adapter), never the core. Unconfigured, nothing exists — opt-in, zero cost, no resident
pipeline.

See `docs/architecture/memory.md` (「语义召回」) and `examples/semantic-recall`.
