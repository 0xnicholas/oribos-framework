# @oribos/model-router

Route `'provider/model'` strings to model instances — the model-routing capability package. A
parse, a catalog, and the provider packages you already installed; the core keeps no registry
and no magic strings:

```ts
import { Agent } from '@oribos/core/agent';
import { createModelRouter } from '@oribos/model-router';
import { groq } from '@ai-sdk/groq';

const route = createModelRouter({
  catalog, // a snapshot of https://models.dev/api.json pastes as-is
  providers: { groq: (id) => groq(id) }, // your installed provider packages
});

const agent = new Agent({ name: 'assistant', model: route('groq/llama-3.3-70b-versatile') });
```

## How it works

- **Parse.** `parseModelString` splits on the **first** slash: model ids may themselves contain
  slashes (deepinfra-style ids, and groq-hosted ids like `openai/gpt-oss-120b`), so only the
  first segment is the provider. Anything without that shape is refused — the string stays this
  package's vocabulary, never the core's.
- **Resolve.** `createModelRouter({ catalog, providers })` checks the parsed string against the
  catalog — the provider must be carried, the model id must be listed — then hands the id to your
  factory and validates the result through the core's model contract (`assertModel`). What the
  catalog adds over bare parsing is **existence**: unknown providers, unlisted models, and
  providers whose package you haven't registered are refused at resolution time with actionable
  errors — including the provider's `npm` package from the catalog when a factory is missing.
- **Pins kept.** No registry anywhere — the catalog and the factories are caller-brought data,
  nothing registers and no router exists until you build one. The catalog is a vendored-shape
  type (`ModelCatalog`); a models.dev snapshot pastes as-is, extra fields pass through. Provider
  package dependencies travel with you, never with this package or the core. Unconfigured, the
  package costs nothing and adds nothing to the core.

See `docs/architecture/model.md` (「Provider 生态」) and `examples/model-router` (a committed
catalog snapshot cut, scripted offline provider stubs).
