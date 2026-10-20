# @oribos/testing

Private, source-only workspace package: the canonical scripted fake model and the shared
behavioral contracts that workspace test suites consume. It is never published (`private: true`)
and has no build — consumers import its `src` through the workspace alias.

## Consuming it

Add the package as a **devDependency** where the tests live:

```json
{
  "devDependencies": {
    "@oribos/testing": "workspace:*"
  }
}
```

`vitest.config.ts` aliases `@oribos/testing` to `packages/testing/src/index.ts`, so tests need no
build step. The only runtime dependency this package adds for its consumers is `vitest` (a
devDependency here); production code must not import it.

It also exports the shared test helpers `collect` (drain an async iterable into an array) and
`captureRejection` (assert a rejected `Error`), so suites do not carry their own copies.

## `fakeModel(script, options?)`

The repo's one scripted model seam — replaces real LLM calls in tests. It implements the AI SDK
provider contract while satisfying Oribos' vendor `Model` shape, answers each call from the
script in order, and records the call options (`streamCalls` / `generateCalls`) so tests can
assert what the model received. See `src/index.ts` for the script shape (`text`, `toolCalls`,
`fail`, `errorAfter`, `abortAfter`, …).

## Output-object behavior contract

`describeOutputObjectContract` is the parameterized suite that pins the shared pump's semantics:

- **Lazy start** — nothing runs before the first chunk pull or terminal read.
- **Single-iterator identity** — every `Symbol.asyncIterator()` call returns the same iterator.
- **Buffer drain order** — chunks buffered while a terminal is read are delivered in stream order.
- **Failure after the buffer** — a failed run delivers everything it produced, then the iterator
  and terminal promises reject with the same error.
- **Abandon stays local** — leaving the loop early ends that traversal, not the run; later
  iterations see no buffered chunks and the terminals still settle.
- **Terminal laziness** — terminals read after completion resolve normally; reading twice returns
  the same promise.

Call it at suite top level and give it two factories. **Each factory call must build a fresh run**
(the cases consume their own output object), compute the expected chunks/terminal there, and
report whether the source has started:

```ts
import { describeOutputObjectContract, fakeModel } from '@oribos/testing';

describeOutputObjectContract<MyChunk>({
  success: () => {
    const model = fakeModel([{ text: ['a', 'b'] }]);
    const output = myCapability.wrap(model.stream());
    return {
      output,
      readTerminal: () => output.text,
      started: () => model.streamCalls.length > 0,
      chunks: [{ type: 'text-delta', textDelta: 'a' }, /* … */],
      terminal: 'ab',
    };
  },
  failure: () => {
    const boom = new Error('upstream exploded');
    const model = fakeModel([{ text: ['a'], errorAfter: boom }]);
    const output = myCapability.wrap(model.stream());
    return {
      output,
      readTerminal: () => output.text,
      started: () => model.streamCalls.length > 0,
      chunks: [{ type: 'text-delta', textDelta: 'a' }],
      error: boom,
    };
  },
});
```

`OutputObjectScript` / `OutputObjectScripting` are exported for factories that want to name the
shape. Current consumers:

| Suite | Source shape |
| --- | --- |
| `packages/core/test/agent-stream.test.ts` | pull source (agent async generator) |
| `packages/core/test/workflows-events.test.ts` | push source (workflow promise + emit) |
| `packages/resumable-stream/test/output-object-contract.test.ts` | capability wrapper (`withEventCache`) over the shared pump |
