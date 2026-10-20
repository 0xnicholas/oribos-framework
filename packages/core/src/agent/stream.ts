import type { Chunk } from '../model/chunks.js';
import { ModelContractError } from '../model/resolve.js';
import { createOutputObject } from '../output-object.js';
import type { AgentGenerateResult, AgentStreamResult } from './types.js';

/**
 * The contract violation of a model stream that ends without a `finish` part — `finishReason` and
 * usage are unknown. The run engine raises it when the whole chunk stream ends without one; the
 * loop raises it when a single step's model stream does, so a later step cannot settle the run on
 * a previous step's finish chunk. Internal seam, not part of the entry's public surface.
 */
export function missingFinishError(): ModelContractError {
  return new ModelContractError(
    'The model stream ended without a finish part, so finishReason and usage are unknown. ' +
      'The model does not implement the streaming contract of the AI SDK provider specification.',
  );
}

/**
 * The agent's output object (`output-object.ts` carries the pump; this is its agent source and
 * terminal projection). The run's terminal result is the generator's *return value* — the
 * authoritative record the loop builds from its post-processor step records — so the chunk stream
 * is never re-accumulated here: a processor's `processOutputStep` rewrite is what `steps` /
 * `text` / `usage` report, while the live chunks stay the model's own output. The structured
 * output of a `structuredOutput` run (`object`) comes from that same return value: the completion
 * module validated the terminal text of a completed run, and a suspended run settles it as
 * `undefined` (ADR-0019). A failed run rejects with the error `processError` settled on, when
 * processors replaced it.
 */
export function createAgentStream<TObject = unknown>(
  run: () => AsyncGenerator<Chunk, AgentGenerateResult<TObject>, void>,
): AgentStreamResult<TObject> {
  return createOutputObject<Chunk, AgentGenerateResult<TObject>, AgentGenerateResult<TObject>>(
    {
      // The pull source: the run is an async generator — chunks are its yields, the outcome its
      // return value. Manual iteration rather than `for await`: a loop discards the return value.
      async start(deliver) {
        const iterator = run()[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (next.done) return next.value;
          deliver(next.value);
        }
      },
    },
    {
      text: (outcome) => outcome.text,
      object: (outcome) => outcome.object,
      toolCalls: (outcome) => outcome.toolCalls,
      toolResults: (outcome) => outcome.toolResults,
      usage: (outcome) => outcome.usage,
      finishReason: (outcome) => outcome.finishReason,
      steps: (outcome) => outcome.steps,
    },
  );
}
