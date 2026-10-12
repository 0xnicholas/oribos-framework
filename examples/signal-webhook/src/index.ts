/**
 * Oribos signal-webhook example — a carrier's webhooks land in the right support thread.
 *
 * Signal providers (webhook / poll entries) are a pattern here, not a package: the whole entry is
 * a thin HTTP endpoint in front of `sendSignal`, plus a subscription registry the application
 * owns. One script, no external services: a `node:http` server plays the endpoint, `fetch` plays
 * the carrier, and a scripted model stub (no API key, no network) plays the shop's support agent.
 * Zero new seams, zero dependencies — everything the endpoint needs is the core's public signals
 * surface.
 *
 * The three pieces the recipe is about:
 *
 * - **The registry is a plain Map** — a carrier account id resolves to the thread that account's
 *   events belong to (the per-call identity every signal method takes). A real deployment persists
 *   this in its own database; the framework deliberately ships no registry.
 * - **Translation happens at the edge** — the endpoint validates the body, drops event types it
 *   never subscribed to, and only then renders a typed signal. Junk never touches the signals
 *   surface: malformed bodies answer 400, unsubscribed events and unknown accounts answer 202 with
 *   `delivered: false`, and no run wakes.
 * - **Delivery is one call** — `signals.sendSignal(target, payload)` renders the payload as one
 *   `[signal] {…}` user message and wakes the idle thread; the endpoint answers 202 once the
 *   message is delivered, while the woken run proceeds on its own.
 *
 * The acts:
 *
 * 1. **A webhook wakes its thread.** A `shipment.status_changed` post for shop-7's account wakes
 *    the order-4471 thread; the woken run's prompt ends with the rendered signal and the reply
 *    lands in history after it.
 * 2. **The registry routes.** The same event on shop-9's account wakes order-5520 only — shop-7's
 *    history is untouched.
 * 3. **The edge keeps junk off the signals surface.** An unsubscribed event type, a malformed body
 *    and an unknown account answer 202 / 400 / 202 — and wake nothing.
 *
 * The script asserts its own payoff (`node:assert/strict`): a signal that never reached the woken
 * run's prompt, a webhook routed to the wrong thread, a junk post that woke a run — each exits
 * non-zero instead of printing a happy face.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-signal-webhook start
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '@oribos/core';
import type { AgentMemoryOptions } from '@oribos/core/agent';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { Model, ModelCallOptions, ModelStreamPart } from '@oribos/core/model';
import { AGENT_RUN_SPAN, AGENT_STEP_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';
import type { SignalPayload, Signals } from '@oribos/core/signals';

// ── A scripted model: the story is what the woken runs see ─────────────────────────────────────

/** One scripted answer per woken run: each model call consumes one entry. */
function scriptedModel(script: readonly string[]): Model & { calls: () => number } {
  let answered = 0;
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'support-desk-model',
    calls: () => answered,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async (_call: ModelCallOptions) => {
      const text = script[answered];
      answered += 1;
      if (text === undefined) {
        throw new Error(`script exhausted after ${script.length} entrie(s) — a junk post woke a run`);
      }
      const parts: ModelStreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: text },
        { type: 'text-end', id: 'text-0' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 30, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 12, text: undefined, reasoning: undefined },
          },
        },
      ];
      return {
        stream: new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

const SCRIPT = [
  'Order 4471 shows delivered — closing the loop with the customer.',
  'Order 5520 is out for delivery — letting the customer know it arrives today.',
] as const;

// ── The endpoint: registry, translation, one sendSignal ────────────────────────────────────────

/** What the carrier posts: one shipment event, stamped with the account it belongs to. */
interface CarrierEvent {
  readonly account: string;
  readonly event: string;
  readonly orderId: string;
  readonly status: string;
  readonly carrier: string;
}

/** Body shape validation at the edge: a body that is not a carrier event is a 400, not a signal. */
function parseCarrierEvent(body: unknown): CarrierEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const fields = ['account', 'event', 'orderId', 'status', 'carrier'] as const;
  if (fields.some((field) => typeof record[field] !== 'string')) return null;
  return {
    account: record['account'] as string,
    event: record['event'] as string,
    orderId: record['orderId'] as string,
    status: record['status'] as string,
    carrier: record['carrier'] as string,
  };
}

/** The one event this desk subscribed to; anything else the carrier posts is acknowledged, not signaled. */
function toSignal(event: CarrierEvent): SignalPayload | null {
  if (event.event !== 'shipment.status_changed') return null;
  return { type: 'shipment-status', orderId: event.orderId, status: event.status, carrier: event.carrier };
}

/**
 * The thin entry itself: validate → translate → route → `sendSignal`. The registry is a plain
 * `Map` the application owns — in a deployment it is a table in the application's own database.
 */
function createWebhookHandler(registry: ReadonlyMap<string, AgentMemoryOptions>, signals: Signals) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/webhooks/carrier') {
      return reply(404, { error: 'not found' });
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'malformed JSON' });
    }
    const event = parseCarrierEvent(body);
    if (event === null) return reply(400, { error: 'not a carrier event' });
    const signal = toSignal(event);
    if (signal === null) {
      return reply(202, { delivered: false, reason: `unsubscribed event '${event.event}'` });
    }
    const target = registry.get(event.account);
    if (target === undefined) {
      return reply(202, { delivered: false, reason: `unknown account '${event.account}'` });
    }
    // 202 once the signal is delivered (it is in history); the run it wakes proceeds on its own.
    await signals.sendSignal(target, signal);
    return reply(202, { delivered: true });
  };
}

// ── The composition root and the desk ──────────────────────────────────────────────────────────

// The memory exporter is the assertion surface: a woken run hands out no output object to await,
// so the script watches runs the way a deployment can — a run's `agent-run` span ends when the run
// does, and a step span's `input` is the model call's exact prompt.
const exporter = memoryExporter({ capacity: 1_000 });
const tracer = createTracer({ exporters: [exporter] });
const memoryStore = createInMemoryStore();
const app = createApp({ tracer, storage: { memory: memoryStore } });

const model = scriptedModel(SCRIPT);
const desk = app.agent({
  name: 'desk',
  instructions:
    'You are a support desk for a small shop. Shipment events arrive as [signal] messages — ' +
    'acknowledge each in one short sentence for the customer.',
  model,
});
const signals = app.signals({ agent: desk });

/** The script's read handle on history: a `Memory` over the same store the app distributed. */
const memory = new Memory({ storage: memoryStore });

const registry: ReadonlyMap<string, AgentMemoryOptions> = new Map([
  ['acct-shop-7', { thread: { id: 'order-4471', title: 'Order 4471 — Lisbon delivery' }, resource: 'shop-7' }],
  ['acct-shop-9', { thread: { id: 'order-5520', title: 'Order 5520 — Porto pickup' }, resource: 'shop-9' }],
]);

// ── Script helpers ─────────────────────────────────────────────────────────────────────────────

/** The `agent-run` spans of runs that have *ended* since the last `exporter.clear()`. */
function endedRuns(): readonly ExportedSpan[] {
  return exporter
    .spans()
    .filter((span) => span.type === AGENT_RUN_SPAN && span.endTime !== undefined);
}

/** The `agent-step` spans since the last `exporter.clear()` — one per model call. */
function stepSpans(): readonly ExportedSpan[] {
  return exporter.spans().filter((span) => span.type === AGENT_STEP_SPAN);
}

/** The text of one model message: string content, or its parts rendered. */
function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const content: unknown = (value as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return '';
      const record = part as Record<string, unknown>;
      if (record['type'] === 'text') return String(record['text'] ?? '');
      return `[${String(record['type'])}]`;
    })
    .join(' ');
}

/** The terminal text a run's span reported — the loop writes the run's output onto it. */
function reportedText(span: ExportedSpan | undefined): string {
  return span !== undefined && typeof span.output === 'string' ? span.output.trim() : '';
}

/**
 * Waits until `count` runs have ended since the last `exporter.clear()`. The thread itself is
 * released a few microtasks after its run's span ends, so one macrotask turn lets those drain.
 */
async function waitForRuns(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (endedRuns().length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} run(s), saw ${endedRuns().length} — re-run the example`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The user messages one thread's history carries, rendered. */
async function historyTexts(threadId: string): Promise<string[]> {
  const history = await memory.recall({ threadId });
  return history.filter((message) => message.role === 'user').map((message) => textOf(message));
}

// ── The scripted session ───────────────────────────────────────────────────────────────────────

const server = createServer(createWebhookHandler(registry, signals));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const endpoint = `http://127.0.0.1:${port}/webhooks/carrier`;

/** Plays the carrier: one POST, answered with the status code and the parsed reply body. */
async function postWebhook(body: string): Promise<{ status: number; reply: Record<string, unknown> }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, reply: (await response.json()) as Record<string, unknown> };
}

const carrierEvent = (account: string, orderId: string, status: string): string =>
  JSON.stringify({ account, event: 'shipment.status_changed', orderId, status, carrier: 'DHL' });

try {
  console.log('signal-webhook — a thin webhook endpoint in front of sendSignal.');
  console.log(`listening on ${endpoint} (registry: ${registry.size} subscription(s))\n`);

  console.log('Act 1 — a webhook wakes its thread');
  const before1 = await historyTexts('order-4471');
  const delivered = await postWebhook(carrierEvent('acct-shop-7', '4471', 'delivered'));
  assert.equal(delivered.status, 202);
  assert.deepEqual(delivered.reply, { delivered: true });
  await waitForRuns(1);

  assert.equal(endedRuns().length, 1);
  const promptTail1 = textOf((stepSpans().at(0)?.input as unknown[] | undefined)?.at(-1));
  assert.ok(
    promptTail1.startsWith('[signal] {"type":"shipment-status","orderId":"4471","status":"delivered"'),
    `the woken run's prompt ends with the rendered signal, got "${promptTail1}"`,
  );
  assert.equal(reportedText(endedRuns().at(0)), SCRIPT[0]);
  const after1 = await historyTexts('order-4471');
  assert.equal(after1.length, before1.length + 1);
  assert.equal(after1.at(-1), promptTail1);
  console.log(`  POST → 202 { delivered: true }  ← the signal is in history, the run proceeds`);
  console.log(`  prompt tail  ${promptTail1}`);
  console.log(`  [woken run → order-4471] ${reportedText(endedRuns().at(0))}\n`);

  console.log('Act 2 — the registry routes: shop-9’s event wakes shop-9’s thread only');
  exporter.clear();
  const shop7Before2 = await historyTexts('order-4471');
  const routed = await postWebhook(carrierEvent('acct-shop-9', '5520', 'out-for-delivery'));
  assert.equal(routed.status, 202);
  assert.deepEqual(routed.reply, { delivered: true });
  await waitForRuns(1);

  assert.equal(endedRuns().length, 1);
  assert.equal(reportedText(endedRuns().at(0)), SCRIPT[1]);
  const shop9History = await historyTexts('order-5520');
  assert.equal(shop9History.length, 1);
  assert.ok(
    (shop9History.at(-1) ?? '').startsWith('[signal] {"type":"shipment-status","orderId":"5520"'),
    `shop-9's thread carries its own signal, got "${shop9History.at(-1)}"`,
  );
  assert.deepEqual(await historyTexts('order-4471'), shop7Before2);
  console.log(`  POST (acct-shop-9) → 202  ← order-5520 woke, order-4471 untouched`);
  console.log(`  [woken run → order-5520] ${reportedText(endedRuns().at(0))}\n`);

  console.log('Act 3 — the edge keeps junk off the signals surface');
  exporter.clear();
  const unsubscribed = await postWebhook(
    JSON.stringify({ account: 'acct-shop-7', event: 'carrier.ping', orderId: '4471', status: 'ok', carrier: 'DHL' }),
  );
  assert.equal(unsubscribed.status, 202);
  assert.equal(unsubscribed.reply['delivered'], false);
  const malformed = await postWebhook('{ not json');
  assert.equal(malformed.status, 400);
  const unknownAccount = await postWebhook(carrierEvent('acct-shop-13', '9000', 'delivered'));
  assert.equal(unknownAccount.status, 202);
  assert.equal(unknownAccount.reply['delivered'], false);

  // A wrongly-woken run would already have opened its span; one settle turn later, none exists.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(endedRuns().length, 0);
  assert.equal(model.calls(), SCRIPT.length);
  console.log(`  unsubscribed event → 202 delivered:false · malformed body → 400 · unknown account → 202`);
  console.log(`  runs woken by junk: 0 (model calls so far: ${model.calls()})\n`);

  console.log(
    'Done — a thin endpoint plus an application-owned registry is the whole pattern: validate and ' +
      'translate at the edge, then one sendSignal. No new seams, no dependencies.',
  );
} finally {
  // Release the keep-alive sockets fetch pooled, or they would hold the process open briefly.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
