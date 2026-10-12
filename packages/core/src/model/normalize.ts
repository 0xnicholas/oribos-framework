import type { Chunk, DeltaEmission, FinishReason, Usage } from './chunks.js';
import type { ModelFinishReason, ModelStreamPart, ModelUsage } from './contract.js';

/**
 * Normalizes a model-native stream into the core's chunk protocol.
 *
 * Thin by design: one chunk (or none) per model part, no buffering, no policy. The core never
 * surfaces the AI SDK stream format to users; this is the only place the two meet.
 *
 * `emission` gates the two opt-in delta families (`DeltaEmission`); absent, the stream carries
 * exactly the minimal protocol.
 *
 * The underlying stream is cancelled when the consumer stops early (e.g. `break` out of a
 * `for await` loop), so providers can release their resources.
 */
export async function* normalizeStream(
  stream: ReadableStream<ModelStreamPart>,
  emission?: DeltaEmission,
): AsyncGenerator<Chunk> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield* normalizePart(value, emission);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The source already failed or was cancelled — nothing left to release.
    }
  }
}

/**
 * Normalizes one model-native stream part into chunks.
 *
 * Returns an empty array for parts outside the minimal protocol (structural markers, sources,
 * files, raw parts, tool approval requests) and for the opt-in delta families whose
 * `DeltaEmission` switch is off. Reasoning boundaries (`reasoning-start` / `reasoning-end`)
 * never enter the protocol: as with text, consecutive deltas form one block and a converter
 * synthesizes the boundary frames. Tool calls and provider-executed tool results are carried:
 * what to execute is the tool loop's decision, not the normalizer's.
 *
 * Throws the reported error for `'error'` parts — a stream that reports failure must fail, not
 * silently end.
 */
export function normalizePart(part: ModelStreamPart, emission?: DeltaEmission): Chunk[] {
  switch (part.type) {
    case 'text-delta':
      return [{ type: 'text-delta', textDelta: part.delta }];

    case 'reasoning-delta':
      return emission?.reasoning === true
        ? [{ type: 'reasoning-delta', reasoningDelta: part.delta }]
        : [];

    case 'tool-input-start':
      return emission?.toolInput === true
        ? [{ type: 'tool-input-start', toolCallId: part.id, toolName: part.toolName }]
        : [];

    case 'tool-input-delta':
      return emission?.toolInput === true
        ? [{ type: 'tool-input-delta', toolCallId: part.id, inputDelta: part.delta }]
        : [];

    case 'tool-input-end':
      return emission?.toolInput === true ? [{ type: 'tool-input-end', toolCallId: part.id }] : [];

    case 'tool-call':
      return [
        {
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: parseToolInput(part.input),
        },
      ];

    case 'tool-result':
      return [
        {
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.result,
          isError: part.isError ?? false,
        },
      ];

    case 'finish':
      return [
        {
          type: 'finish',
          finishReason: toFinishReason(part.finishReason),
          usage: toUsage(part.usage),
        },
      ];

    case 'error':
      throw toError(part.error);

    // Parts the protocol never carries. Enumerated exhaustively so that a new part in
    // the vendor contract breaks the build here and forces a deliberate mapping decision.
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
    case 'tool-approval-request':
    case 'custom':
    case 'file':
    case 'reasoning-file':
    case 'source':
    case 'stream-start':
    case 'response-metadata':
    case 'raw':
      return [];

    default: {
      part satisfies never;
      return [];
    }
  }
}

/**
 * Parses the stringified JSON input of a tool call.
 *
 * Malformed JSON is passed through as the raw string: the tool boundary then fails input
 * validation and feeds the failure back to the model, which stays in the loop instead of the run
 * aborting.
 */
function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

/**
 * Collapses the provider's unified finish reason into the core's vocabulary.
 *
 * `'content-filter'` (the model was stopped by a provider policy) and `'other'` both map to
 * `'stop'`: they are terminal but not failures, and reporting them as `'error'` would invite
 * retries of a request the provider has already refused.
 */
function toFinishReason(finishReason: ModelFinishReason): FinishReason {
  switch (finishReason.unified) {
    case 'stop':
    case 'content-filter':
    case 'other':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool-calls';
    case 'error':
      return 'error';
  }
}

/** Maps the provider's nested usage into the core's flat usage. */
function toUsage(usage: ModelUsage): Usage {
  const inputTokens = usage.inputTokens.total;
  const outputTokens = usage.outputTokens.total;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : inputTokens + outputTokens,
  };
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('The model stream reported an error', { cause: error });
}
