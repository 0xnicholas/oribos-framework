/**
 * `createChatRoute` — the web-standard `useChat()` route.
 *
 * One handler shape — `(request: Request) => Promise<Response>` — for a bare agent or a durable
 * one, on any web-standard host (Next, Hono, plain `node:http` via a thin adapter). POST only.
 * The run's input is **memory-authoritative**: the thread/resource come from `identity(request)`
 * (the thread defaults to the body's `id`), history is thread recall — never a replay of the
 * client's message list — and of the body only the tail user message crosses, as text and file
 * parts. `modelSettings` / `maxSteps` and friends are never read from the body.
 *
 * Suspension is expressed on the terminal `finish` frame (`finishReason: 'other'` +
 * `messageMetadata.suspended`) — never through `tool-approval-*` frames; resuming is the
 * application's orchestration (call `durable.resume(runId, …)`; the example shows the pattern).
 */

import type { Agent, AgentRunOptions, AgentStreamResult } from '@oribos/core/agent';
import type { DurableAgent, DurableStreamResult } from '@oribos/core/durable-agent';
import type { MemoryThreadRef } from '@oribos/core/memory';
import type { Chunk, DeltaEmission, ModelFilePart, ModelTextPart } from '@oribos/core/model';
import type { AISdkFinishReason, AISdkSuspendedMetadata, AISdkStreamChunk } from './chunks.js';
import { UI_MESSAGE_STREAM_HEADERS } from './headers.js';
import { toAISdkStream } from './to-ai-sdk-stream.js';

/** What the route drives: a bare agent or a durable one — the same `stream` call shape. */
export type ChatRouteAgent = Agent | DurableAgent;

/** The per-request identity `identity(request)` returns: the memory thread plus its owner. */
export interface ChatRouteIdentity {
  /**
   * The thread this run's history lives in; defaults to the request body's `id` when absent.
   */
  readonly thread?: MemoryThreadRef;
  /**
   * The thread's owner (`resourceId`) — required. Memory does no access control: authorizing the
   * caller against this resource is the application's job, which is exactly why identity is a
   * function of the request.
   */
  readonly resource: string;
}

/** The `createChatRoute` config. */
export interface ChatRouteConfig {
  /** The agent (or durable agent) whose runs answer the route. Must carry a configured memory. */
  readonly agent: ChatRouteAgent;
  /** Resolves the run's thread/resource identity from the raw request. */
  readonly identity: (request: Request) => ChatRouteIdentity;
  /** Replaces the sanitized error text of 500 bodies and `error` frames. */
  readonly onError?: (error: unknown) => string;
  /**
   * SSE keep-alive comments while the stream idles — off by default; enable explicitly on
   * deployments behind proxy buffering. Must be in `(0, 2147483647]`.
   */
  readonly keepAliveMs?: number;
  /**
   * Opt-in delta emission for every run of this route (`AgentRunOptions.deltas`): reasoning and
   * tool-input deltas stream as their UI frames. Absent = both off and the stream carries exactly
   * the minimal frame set.
   */
  readonly deltas?: DeltaEmission;
}

/** The sanitized default, matching the official server-side default. */
const DEFAULT_ERROR_TEXT = 'An error occurred.';

/**
 * Builds the `useChat()` route handler. Failures before the first frame answer as JSON (`405` /
 * `400` with a specific reason, `500` sanitized); after it, the stream carries an `error` frame
 * and a `finish { finishReason: 'error' }` under HTTP 200. Every response body is `{ error }` on
 * the JSON paths; the streaming response carries the official five headers.
 */
export function createChatRoute(config: ChatRouteConfig): (request: Request) => Promise<Response> {
  const keepAliveMs = config.keepAliveMs;
  if (
    keepAliveMs !== undefined &&
    (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0 || keepAliveMs > 2147483647)
  ) {
    throw new RangeError(`keepAliveMs must be in (0, 2147483647] — got ${String(keepAliveMs)}`);
  }
  return function chatRoute(request: Request): Promise<Response> {
    return handle(config, keepAliveMs, request);
  };
}

async function handle(
  config: ChatRouteConfig,
  keepAliveMs: number | undefined,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, `method ${request.method} is not allowed — the chat route is POST only`, {
      allow: 'POST',
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, 'request body is not valid JSON');
  }
  if (!isObject(body)) {
    return jsonResponse(400, 'request body must be a JSON object');
  }

  // Body whitelist: `id` and `messages` are read; `trigger` and `messageId` ride along unread;
  // nothing else (`modelSettings`, `maxSteps`, …) is ever taken from the body.
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse(400, 'body.messages must be a non-empty array of messages');
  }
  const tail = messages[messages.length - 1]!;
  if (!isObject(tail) || tail.role !== 'user' || !Array.isArray(tail.parts)) {
    return jsonResponse(400, 'the last message must have role "user"');
  }

  let content: (ModelTextPart | ModelFilePart)[];
  try {
    content = toModelContent(tail.parts);
  } catch (error) {
    if (error instanceof UnsupportedPartError) return jsonResponse(400, error.message);
    throw error;
  }

  let identity: ChatRouteIdentity;
  try {
    identity = config.identity(request);
  } catch (error) {
    return jsonResponse(500, sanitize(config.onError, error));
  }
  const resource = isObject(identity) ? identity.resource : undefined;
  if (typeof resource !== 'string' || resource === '') {
    return jsonResponse(500, 'identity(request) must return a non-empty resource');
  }
  const thread =
    (isObject(identity) && identity.thread !== undefined ? identity.thread : undefined) ??
    (typeof (body as { id?: unknown }).id === 'string' && (body as { id: string }).id !== ''
      ? (body as { id: string }).id
      : undefined);
  if (thread === undefined) {
    return jsonResponse(400, 'no thread: identity(request) returned none and the body carries no id');
  }

  const abort = new AbortController();
  if (request.signal.aborted) {
    // An already-aborted signal never fires its listener — propagate the state directly.
    abort.abort(request.signal.reason);
  } else {
    request.signal.addEventListener('abort', () => abort.abort(request.signal.reason));
  }

  const run = config.agent.stream([{ role: 'user', content }], {
    memory: { thread, resource },
    signal: abort.signal,
    ...(config.deltas === undefined ? {} : { deltas: config.deltas }),
  } satisfies AgentRunOptions);

  // Pull the first chunk before committing to a stream response: a run that fails this early
  // (model rejects, memory recall fails, request already aborted) answers as a sanitized 500.
  const iterator = run[Symbol.asyncIterator]();
  let first: IteratorResult<Chunk>;
  try {
    first = await iterator.next();
  } catch (error) {
    return jsonResponse(500, sanitize(config.onError, error));
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const write = (text: string): void => {
        controller.enqueue(encoder.encode(text));
        if (keepAliveMs !== undefined) {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => write(': keep-alive\n\n'), keepAliveMs);
        }
      };

      if (keepAliveMs !== undefined) write(': stream-open\n\n');
      write(sse({ type: 'start' })); // no messageId: the client owns its assistant message id

      let failed = false;
      try {
        for await (const frame of toAISdkStream(continuation(first, iterator), {
          ...(config.onError === undefined ? {} : { onError: config.onError }),
        })) {
          write(sse(frame));
        }
      } catch {
        // The converter already emitted the `error` frame; finalize below.
        failed = true;
      }

      try {
        if (failed) {
          write(sse({ type: 'finish', finishReason: 'error' }));
        } else {
          // The chunk stream is drained: the run's terminal values are settled.
          const finishReason = await run.finishReason;
          const usage = await run.usage;
          const suspended =
            finishReason === 'suspended' && isDurableResult(run) ? await suspensionOf(run) : undefined;
          write(
            sse({
              type: 'finish',
              finishReason: toAISdkFinishReason(finishReason),
              messageMetadata:
                suspended === undefined ? { usage } : { usage, suspended },
            }),
          );
        }
        write('data: [DONE]\n\n');
      } catch {
        // The consumer is gone; nothing left to say.
      }
      if (timer !== undefined) clearTimeout(timer);
      try {
        controller.close();
      } catch {
        // Already closed by a cancel.
      }
    },
    cancel() {
      // Client disconnect: the response stream cancels, which aborts the run's signal.
      abort.abort();
    },
  });

  return new Response(stream, { headers: { ...UI_MESSAGE_STREAM_HEADERS } });
}

/** The already-pulled first chunk plus the rest of the run's stream, as one iterable. */
async function* continuation(
  first: IteratorResult<Chunk>,
  iterator: AsyncIterator<Chunk>,
): AsyncGenerator<Chunk> {
  if (!first.done) yield first.value;
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

function isDurableResult(run: AgentStreamResult | DurableStreamResult): run is DurableStreamResult {
  return 'runId' in run;
}

async function suspensionOf(run: DurableStreamResult): Promise<AISdkSuspendedMetadata> {
  const payload = await run.suspendPayload;
  return {
    runId: run.runId,
    awaitingApproval: payload === undefined ? [] : [...payload.awaitingApproval],
  };
}

/** `stop` / `length` / `tool-calls` / `error` pass through; `'suspended'` has no wire value. */
function toAISdkFinishReason(reason: string): AISdkFinishReason {
  return reason === 'suspended' ? 'other' : (reason as AISdkFinishReason);
}

function sse(frame: AISdkStreamChunk): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function jsonResponse(status: number, message: string, extra?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(extra ?? {}) };
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function sanitize(onError: ((error: unknown) => string) | undefined, error: unknown): string {
  return onError === undefined ? DEFAULT_ERROR_TEXT : onError(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Tail user message → model content ────────────────────────────────────────────────────────────

/** A 400-worthy part of the tail user message. */
class UnsupportedPartError extends Error {}

function toModelContent(parts: readonly unknown[]): (ModelTextPart | ModelFilePart)[] {
  const content: (ModelTextPart | ModelFilePart)[] = [];
  for (const part of parts) {
    if (!isObject(part)) {
      throw new UnsupportedPartError('every part of the last user message must be an object');
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new UnsupportedPartError('text parts of the last user message need a string text');
      }
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'file') {
      content.push(toModelFilePart(part));
    } else {
      throw new UnsupportedPartError(
        `unsupported part type "${String(part.type)}" in the last user message — only text and file parts cross`,
      );
    }
  }
  return content;
}

function toModelFilePart(part: Record<string, unknown>): ModelFilePart {
  if (typeof part.url !== 'string' || part.url === '') {
    throw new UnsupportedPartError('file parts of the last user message need a url');
  }
  const parsed = parseDataUrl(part.url);
  if (parsed === undefined) {
    throw new UnsupportedPartError(
      'file parts must carry data: URLs — the route fetches no remote URLs',
    );
  }
  const mediaType =
    typeof part.mediaType === 'string' && part.mediaType !== ''
      ? part.mediaType
      : (parsed.mediaType ?? 'application/octet-stream');
  return {
    type: 'file',
    data: { type: 'data', data: parsed.bytes },
    mediaType,
    ...(typeof part.filename === 'string' && part.filename !== ''
      ? { filename: part.filename }
      : {}),
  };
}

/** A parsed `data:` URL: its decoded bytes (base64 or percent-encoded) and media type, if given. */
function parseDataUrl(
  url: string,
): { readonly mediaType?: string; readonly bytes: Uint8Array | string } | undefined {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (match === null) return undefined;
  const [, mediaTypeRaw = '', parameters = '', payload = ''] = match;
  const base = parameters.includes(';base64')
    ? { bytes: Buffer.from(payload, 'base64') as Uint8Array }
    : { bytes: decodeText(payload) };
  return mediaTypeRaw === '' ? base : { ...base, mediaType: mediaTypeRaw };
}

function decodeText(payload: string): string {
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}
