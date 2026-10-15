/**
 * Oribos resumable-stream example — a client hangs up mid-stream, reconnects with the run id,
 * and loses nothing.
 *
 * One script, no external services: the chat model is a scripted stub (paced text deltas, the
 * tests' fake-model trick) and everything — server, client, cache — lives in this process.
 * The story is told by what the reconnected client receives.
 *
 * The seams are the package's whole surface, no core changes:
 *
 * - `withEventCache(output, { runId, cache })` wraps the agent's stream so every chunk lands
 *   in the event cache as it flows. The recording survives the consumer: when the first
 *   client hangs up, the wrapper keeps pumping the run for the cache.
 * - `observe(cache, runId)` is the reconnecting read: replay the cached chunks in order, then
 *   follow the run live until it ends. The GET endpoint that turns it into HTTP is this
 *   application's — the core keeps no resume endpoint.
 *
 * The acts:
 *
 * 1. **Stream, then hang up.** POST /chat starts a paced run; the client reads two deltas and
 *    aborts the connection. The server sees the close and abandons the response iterator —
 *    the run itself keeps going, recording into the cache.
 * 2. **Reconnect.** GET /stream/<runId> observes the run: the deltas the client missed are
 *    replayed, the tail streams live, and the stream ends with the run's finish chunk. The
 *    reassembled text is the complete answer — nothing lost, nothing doubled.
 * 3. **Replay after the end.** The same GET after the run finished replays the whole run from
 *    the cache and ends — the durable-replay shape (with the Redis adapter, from any instance
 *    sharing the database).
 *
 * The script self-asserts (`node:assert/strict`): a lost delta, a doubled delta, or a
 * truncated replay exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-resumable-stream start
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Agent } from '@oribos/core/agent';
import type { Model, ModelStreamPart } from '@oribos/core/model';
import {
  createInMemoryEventCache,
  observe,
  withEventCache,
} from '@oribos/resumable-stream';
import type { EventCache } from '@oribos/resumable-stream';

// ── The scripted model: a paced multi-delta answer worth disconnecting from ─────────────────────

/** The full answer, delivered one text delta per beat — slow enough to hang up mid-way. */
const ANSWER = ['Resumable ', 'streams ', 'record ', 'every ', 'chunk ', 'as ', 'it ', 'flows.'];
const DELTA_MS = 25;

/** A minimal scripted `Model` (the vendor contract) streaming `answer` one paced delta at a time. */
function pacedModel(answer: readonly string[], delayMs: number): Model {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'chat-stub',
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async () => {
      const parts: ModelStreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-0' },
        ...answer.map<ModelStreamPart>((delta) => ({ type: 'text-delta', id: 'text-0', delta })),
        { type: 'text-end', id: 'text-0' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: undefined, reasoning: undefined },
          },
        },
      ];
      return {
        stream: new ReadableStream<ModelStreamPart>({
          async start(controller) {
            for (const part of parts) {
              await sleep(delayMs); // the pacing: one beat per delta, disconnects fit between
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  };
}

const agent = new Agent({
  name: 'storyteller',
  instructions: 'You tell one specific sentence.',
  model: pacedModel(ANSWER, DELTA_MS),
});

// ── The application: a chat endpoint that records, and a stream endpoint that observes ──────────

const cache: EventCache = createInMemoryEventCache();
/** This process's wrapped outputs, by run id — kept so the script can await a run's terminal. */
const runs = new Map<string, ReturnType<typeof agent.stream>>();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'POST' && url.pathname === '/chat') {
    // The application mints the run id; the recording hangs off the same pass that streams.
    const runId = randomUUID();
    const output = withEventCache(agent.stream('tell me the sentence'), { runId, cache });
    runs.set(runId, output);

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // The run id rides the transport — the cache key is the application's own key.
    response.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);
    void (async () => {
      for await (const chunk of output) {
        if (response.destroyed) return; // the client hung up: abandon this traversal (in-protocol) —
        response.write(`data: ${JSON.stringify(chunk)}\n\n`); // the run and its recording keep going
      }
      response.end();
    })().catch(() => response.destroy());
    return;
  }

  const replay = url.pathname.match(/^\/stream\/([0-9a-f-]+)$/);
  if (request.method === 'GET' && replay?.[1] !== undefined) {
    const runId = replay[1];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    void (async () => {
      for await (const chunk of observe(cache, runId)) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end();
    })().catch((error) => {
      // observe's refusals are the application's to map (a real route: 404 / 409).
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    return;
  }

  response.writeHead(404).end();
});

// ── The client: SSE readers, one of which can hang up ──────────────────────────────────────────

/** One parsed SSE `data:` frame. */
interface SseEvent {
  readonly type: string;
  readonly runId?: string;
  readonly textDelta?: string;
  readonly finishReason?: string;
}

/** Incrementally parses an SSE body, handing each `data:` frame to `onEvent`. */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.replace(/^data: /, '');
      if (data.length > 0) onEvent(JSON.parse(data) as SseEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/** The text a chunk sequence assembles (the client-side projection of the chunk protocol). */
function textOf(events: readonly SseEvent[]): string {
  return events.reduce((text, event) => text + (event.textDelta ?? ''), '');
}

/** The run id and text deltas an event sequence carried. */
function summarize(events: readonly SseEvent[]): { runId: string; deltas: string[] } {
  return {
    runId: events.find((event) => event.type === 'run')?.runId ?? '',
    deltas: events.flatMap((event) =>
      event.type === 'text-delta' && event.textDelta !== undefined ? [event.textDelta] : [],
    ),
  };
}

// ── The three acts ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Act 1: stream, then hang up after the second delta.
  const controller = new AbortController();
  const first = await fetch(`${baseUrl}/chat`, { method: 'POST', signal: controller.signal });
  const seen: SseEvent[] = [];
  const reading = consumeSse(first.body!, (event) => {
    seen.push(event);
    if (seen.filter((item) => item.type === 'text-delta').length >= 2) controller.abort();
  });
  // The abort rejects the body reader — the two deltas read are the whole first window.
  await reading.catch(() => undefined);
  const before = summarize(seen);
  assert.equal(before.deltas.length, 2, `hung up after exactly two deltas (saw ${before.deltas.length})`);
  const runId = before.runId;
  assert.ok(runId !== '', 'the run id arrived before the hang-up');

  // The abandoned run still records to its end (the terminal settles from the same pass).
  await runs.get(runId)?.text;

  // Act 2: reconnect — replay + live tail, complete and undoubled.
  const reconnected = await fetch(`${baseUrl}/stream/${runId}`);
  const rejoined: SseEvent[] = [];
  await consumeSse(reconnected.body!, (event) => rejoined.push(event));
  assert.equal(textOf(rejoined), ANSWER.join(''), 'the reconnected client received the complete answer');
  assert.equal(
    rejoined.filter((event) => event.type === 'text-delta').length,
    ANSWER.length,
    'every delta exactly once — replayed, not doubled',
  );
  assert.equal(rejoined.at(-1)?.type, 'finish', 'the stream ends with the run’s finish chunk');
  assert.equal(rejoined.at(-1)?.finishReason, 'stop');

  // Act 3: the same GET after the run ended replays the whole run and ends.
  const replayResponse = await fetch(`${baseUrl}/stream/${runId}`);
  const afterEnd: SseEvent[] = [];
  await consumeSse(replayResponse.body!, (event) => afterEnd.push(event));
  assert.equal(textOf(afterEnd), ANSWER.join(''), 'replay after the end is still complete');

  console.log('resumable-stream example: all three acts passed');
  console.log(`  hung up after:  "${before.deltas.join('')}"`);
  console.log(`  rejoined with:  "${textOf(rejoined)}"`);
  console.log(`  replayed after: "${textOf(afterEnd)}"`);
  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
