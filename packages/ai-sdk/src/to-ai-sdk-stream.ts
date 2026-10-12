/**
 * `toAISdkStream` — the core's chunk stream as UI message stream body frames.
 *
 * The converter takes any `AsyncIterable<Chunk>` — an agent run, a durable run, a signals
 * subscription, all the same face — and yields this package's closed frame union. It produces
 * **body frames only**: the message-level `start` / `finish` frames belong to the caller, because
 * `finish` needs terminal values (the run's outcome, usage, suspension) the chunk stream cannot
 * see. SSE encoding is equally the caller's (`createChatRoute` or a host composing its own
 * response).
 */

import type { Chunk } from '@oribos/core/model';
import type { AISdkStreamChunk } from './chunks.js';

/** The default sanitized error text, matching the official server-side default. */
const DEFAULT_ERROR_TEXT = 'An error occurred.';

/** Options of `toAISdkStream`. */
export interface ToAISdkStreamOptions {
  /**
   * Replaces the sanitized text of the `error` frame emitted when the source stream fails. The
   * original error still propagates to the consumer after the frame — sanitization is a wire
   * concern, not a swallow.
   */
  readonly onError?: (error: unknown) => string;
}

/**
 * Converts the core's chunk stream into UI message stream frames. Frame discipline (frozen):
 *
 * - `start-step` precedes the stream's first model-output frame, and the next model-output frame
 *   after each `finish-step` (a step's `tool-result`s follow its `finish-step` and never open a
 *   new one — the core emits the step's finish before its framework-executed results).
 * - Consecutive `text-delta`s form one text block with a synthesized id; any non-text chunk
 *   closes it. Block ids count up per converter instance, across text and reasoning blocks.
 * - Consecutive `reasoning-delta`s (opt-in at the source) form one reasoning block the same way;
 *   any non-reasoning chunk closes it.
 * - `tool-input-start` / `tool-input-delta` (opt-in at the source) map to the same-named frames
 *   (`providerExecuted` / `dynamic`, matching `tool-input-available`); `tool-input-end` has no UI
 *   counterpart and only closes the converter's block state.
 * - `tool-call` becomes exactly one `tool-input-available` (`providerExecuted` / `dynamic`).
 * - `tool-result` becomes `tool-output-available` or `tool-output-error` by `isError`.
 * - `finish` becomes `finish-step`, in original order.
 * - A failing source emits `text-end` / `reasoning-end` (if a block is open), then one sanitized
 *   `error` frame — then the original error is rethrown so the caller can finalize.
 */
export function toAISdkStream(
  stream: AsyncIterable<Chunk>,
  options: ToAISdkStreamOptions = {},
): AsyncIterable<AISdkStreamChunk> {
  const onError = options.onError;
  return {
    [Symbol.asyncIterator]() {
      return convert(stream, onError);
    },
  };
}

async function* convert(
  stream: AsyncIterable<Chunk>,
  onError: ((error: unknown) => string) | undefined,
): AsyncGenerator<AISdkStreamChunk> {
  let stepOpen = false; // a `start-step` has been emitted and not yet closed by `finish-step`
  let openTextId: string | undefined; // the open text block's id, if any
  let openReasoningId: string | undefined; // the open reasoning block's id, if any
  let blockCount = 0;
  /** Tool call ids whose `tool-input-start` has been emitted (the UI stream has no end frame; the
   * set tracks which starts have gone out, nothing more). */
  const openToolInputs = new Set<string>();

  /** A model-output frame is coming: open a step if none is open (never for `tool-result`). */
  function ensureStep(): AISdkStreamChunk {
    stepOpen = true;
    return { type: 'start-step' };
  }

  /** Closes the open text block, if one is open. */
  function closeText(): AISdkStreamChunk | undefined {
    if (openTextId === undefined) return undefined;
    const frame: AISdkStreamChunk = { type: 'text-end', id: openTextId };
    openTextId = undefined;
    return frame;
  }

  /** Closes the open reasoning block, if one is open. */
  function closeReasoning(): AISdkStreamChunk | undefined {
    if (openReasoningId === undefined) return undefined;
    const frame: AISdkStreamChunk = { type: 'reasoning-end', id: openReasoningId };
    openReasoningId = undefined;
    return frame;
  }

  try {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta': {
          if (!stepOpen) yield ensureStep();
          const closedReasoning = closeReasoning();
          if (closedReasoning !== undefined) yield closedReasoning;
          if (openTextId === undefined) {
            openTextId = `text-${blockCount++}`;
            yield { type: 'text-start', id: openTextId };
          }
          yield { type: 'text-delta', id: openTextId, delta: chunk.textDelta };
          break;
        }
        case 'reasoning-delta': {
          if (!stepOpen) yield ensureStep();
          const closed = closeText();
          if (closed !== undefined) yield closed;
          if (openReasoningId === undefined) {
            openReasoningId = `reasoning-${blockCount++}`;
            yield { type: 'reasoning-start', id: openReasoningId };
          }
          yield { type: 'reasoning-delta', id: openReasoningId, delta: chunk.reasoningDelta };
          break;
        }
        case 'tool-input-start': {
          const closedText = closeText();
          if (closedText !== undefined) yield closedText;
          const closedReasoning = closeReasoning();
          if (closedReasoning !== undefined) yield closedReasoning;
          if (!stepOpen) yield ensureStep();
          // A call's input streams once; a repeated start for the same id carries nothing new.
          if (!openToolInputs.has(chunk.toolCallId)) {
            openToolInputs.add(chunk.toolCallId);
            yield {
              type: 'tool-input-start',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              providerExecuted: true,
              dynamic: true,
            };
          }
          break;
        }
        case 'tool-input-delta': {
          if (!stepOpen) yield ensureStep();
          yield {
            type: 'tool-input-delta',
            toolCallId: chunk.toolCallId,
            inputTextDelta: chunk.inputDelta,
          };
          break;
        }
        case 'tool-input-end': {
          // No UI-stream counterpart: the chunk only closes the converter's block state.
          openToolInputs.delete(chunk.toolCallId);
          break;
        }
        case 'tool-call': {
          const closed = closeText();
          if (closed !== undefined) yield closed;
          const closedReasoning = closeReasoning();
          if (closedReasoning !== undefined) yield closedReasoning;
          openToolInputs.delete(chunk.toolCallId);
          if (!stepOpen) yield ensureStep();
          yield {
            type: 'tool-input-available',
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            providerExecuted: true,
            dynamic: true,
          };
          break;
        }
        case 'tool-result': {
          // A step's results follow its finish-step: no step opening, no text interaction.
          if (chunk.isError) {
            yield {
              type: 'tool-output-error',
              toolCallId: chunk.toolCallId,
              errorText: errorTextOf(chunk.output),
              providerExecuted: true,
            };
          } else {
            yield {
              type: 'tool-output-available',
              toolCallId: chunk.toolCallId,
              output: chunk.output,
              providerExecuted: true,
            };
          }
          break;
        }
        case 'finish': {
          const closed = closeText();
          if (closed !== undefined) yield closed;
          const closedReasoning = closeReasoning();
          if (closedReasoning !== undefined) yield closedReasoning;
          yield { type: 'finish-step' };
          stepOpen = false;
          break;
        }
      }
    }
    // A source that ends cleanly has no open text block left (a `finish` closed it); nothing to do.
  } catch (error) {
    const closed = closeText();
    if (closed !== undefined) yield closed;
    const closedReasoning = closeReasoning();
    if (closedReasoning !== undefined) yield closedReasoning;
    yield { type: 'error', errorText: onError?.(error) ?? DEFAULT_ERROR_TEXT };
    throw error;
  }
}

/** The `errorText` of an error result: strings verbatim, other values stringified. */
function errorTextOf(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
