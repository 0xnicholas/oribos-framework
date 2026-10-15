/**
 * Oribos otel-bridge example — agent runs become real OpenTelemetry spans in the host process's
 * own TracerProvider.
 *
 * One script, no external services: the "host application" is this script — it registers an OTel
 * SDK TracerProvider with an in-memory exporter (the same role a real app's SDK setup plays),
 * a **scripted model** (defined in this file: no API key, no network) drives real agent runs, and
 * `@oribos/otel-bridge` — just one exporter in the tracer's list — opens the run's spans through
 * the `@opentelemetry/api` global tracer.
 *
 * The acts:
 *
 * 1. **Zero cost without opt-in.** Before any provider is registered, a tracer carrying the
 *    bridge runs a full agent run — every event lands on the API's no-op tracer, nothing is
 *    recorded, nothing throws. The bridge is opt-in: it carries no provider and no pipeline.
 * 2. **The host SDK receives real spans.** With the provider registered, the same one-line
 *    exporter choice produces the framework's automatic spans as genuine OTel spans —
 *    `invoke_agent refund-desk` → `chat scripted-mini` (CLIENT kind) → `execute_tool checkOrder`
 *    — mapped by the shared `@oribos/semconv` leaf (`gen_ai.*` request / usage / response,
 *    `oribos.span.type` / `oribos.run_id`), with the oribos tree (run → step → tool) becoming a
 *    real OTel parent chain in the SDK-generated trace.
 * 3. **An external trace is continued.** A run started with `{ traceId, parentSpanId }` (as from
 *    an incoming `traceparent` header) lands under a remote parent SpanContext — the run joins
 *    the caller's trace instead of starting its own.
 *
 * The script self-asserts (`node:assert/strict`); any missing span, broken tree, or unmapped
 * attribute exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-otel-bridge start
 */
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { trace } from '@opentelemetry/api';
import { createApp } from '@oribos/core';
import { createTracer } from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import type { Model, ModelStreamPart } from '@oribos/core/model';
import { createOtelBridge } from '@oribos/otel-bridge';
import { z } from 'zod';

// ── The scripted model: two turns — ask for the tool, then answer ────────────────────────────

const ANSWER = 'Order A-4471 is eligible: the overcharge was refunded.';

interface ScriptedTurn {
  readonly text?: string;
  readonly toolCall?: { readonly name: string; readonly input: unknown };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** A minimal scripted `Model` (the vendor contract): streams text and tool calls, no network. */
function scriptedModel(script: readonly ScriptedTurn[]): Model {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'scripted-mini',
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async () => {
      const answer = script[turn];
      if (answer === undefined) {
        throw new Error(`scripted model exhausted after ${turn} turn(s)`);
      }
      turn += 1;
      const parts: ModelStreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (answer.toolCall !== undefined) {
        const id = `call-${turn}`;
        const input = JSON.stringify(answer.toolCall.input ?? {});
        parts.push({ type: 'tool-input-start', id, toolName: answer.toolCall.name });
        parts.push({ type: 'tool-input-delta', id, delta: input });
        parts.push({ type: 'tool-input-end', id });
        parts.push({ type: 'tool-call', toolCallId: id, toolName: answer.toolCall.name, input });
      }
      if (answer.text !== undefined && answer.text !== '') {
        parts.push({ type: 'text-start', id: 'text-0' });
        parts.push({ type: 'text-delta', id: 'text-0', delta: answer.text });
        parts.push({ type: 'text-end', id: 'text-0' });
      }
      parts.push({
        type: 'finish',
        finishReason:
          answer.toolCall === undefined
            ? { unified: 'stop', raw: 'stop' }
            : { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: {
            total: answer.usage?.inputTokens ?? 0,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: answer.usage?.outputTokens ?? 0, text: undefined, reasoning: undefined },
        },
      });
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

/** The tool the first model turn asks for; the second turn reports its result. */
function checkOrderTool(): ReturnType<typeof createTool> {
  return createTool({
    description: 'Checks whether an order is eligible for a refund.',
    inputSchema: z.object({ orderId: z.string() }),
    execute: ({ orderId }) => ({ orderId, eligible: true, reason: 'duplicate charge' }),
  });
}

/** Builds the desk agent on a tracer whose only exporter is the bridge. */
function deskAgent(script: readonly ScriptedTurn[]) {
  const tracer = createTracer({ exporters: [createOtelBridge()] });
  const app = createApp({ tracer });
  const agent = app.agent({
    name: 'refund-desk',
    instructions: 'You are the refund desk. Check the order, then answer in one short sentence.',
    model: scriptedModel(script),
    tools: { checkOrder: checkOrderTool() },
  });
  return { tracer, agent };
}

async function drain(run: AsyncIterable<unknown> & { text: Promise<string> }): Promise<string> {
  for await (const _chunk of run) {
    // Drain the run's own stream; the terminal text below is what this script waits on.
  }
  return run.text;
}

/** Prints one line per finished span, the way a backend's trace view starts. */
function printSpans(spans: readonly { name: string; spanContext(): { traceId: string; spanId: string } }[]): void {
  for (const span of spans) {
    console.log(
      `  ${span.name.padEnd(28)} trace=${span.spanContext().traceId.slice(0, 8)}  span=${span.spanContext().spanId.slice(0, 8)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('otel-bridge — agent runs as real OpenTelemetry spans in the host provider:\n');

  // ── Act 1: zero cost without opt-in — no provider registered yet ────────────────────────────
  console.log('──────── Act 1 — no OTel provider: the bridge is a silent no-op ────────');
  const early = deskAgent([{ text: ANSWER, usage: { inputTokens: 7, outputTokens: 9 } }]);
  const earlyRun = early.agent.stream('Customer asks: is order A-4471 eligible for a refund?');
  assert.equal(await drain(earlyRun), ANSWER, 'the run completes with the bridge and no provider');
  await early.tracer.flush();
  console.log('  ✓ full agent run, bridge attached, no provider registered: nothing recorded, nothing thrown\n');

  // ── The host SDK face: what a real application's OTel setup looks like ─────────────────────
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
  trace.setGlobalTracerProvider(provider);

  // ── Act 2: with the provider up, the run becomes a real OTel span tree ─────────────────────
  console.log('──────── Act 2 — the host provider receives the run as real OTel spans ────────');
  const { tracer, agent } = deskAgent([
    { toolCall: { name: 'checkOrder', input: { orderId: 'A-4471' } }, usage: { inputTokens: 11, outputTokens: 4 } },
    { text: ANSWER, usage: { inputTokens: 23, outputTokens: 9 } },
  ]);
  const run = agent.stream('Customer asks: is order A-4471 eligible for a refund?');
  assert.equal(await drain(run), ANSWER);
  await tracer.flush();

  const spans = memory.getFinishedSpans();
  const root = spans.find((span) => span.name === 'invoke_agent refund-desk');
  assert.ok(root !== undefined, 'the host provider must receive the agent-run span');
  const chats = spans.filter((span) => span.name === 'chat scripted-mini');
  assert.equal(chats.length, 2, 'one chat span per model turn (two turns)');
  const tool = spans.find((span) => span.name === 'execute_tool checkOrder');
  assert.ok(tool !== undefined, 'the host provider must receive the tool-call span');

  console.log('\nWhat the host SDK recorded:\n');
  printSpans(spans);
  console.log('');

  // The oribos tree becomes a real OTel parent chain inside the SDK-generated trace.
  assert.equal(chats[0]!.spanContext().traceId, root!.spanContext().traceId, 'the whole run shares one OTel trace');
  assert.equal(chats[0]!.parentSpanContext?.spanId, root!.spanContext().spanId, 'agent-step hangs under agent-run');
  assert.equal(tool!.parentSpanContext?.spanId, chats[0]!.spanContext().spanId, 'tool-call hangs under the step');

  // The shared semconv leaf's mapping, now on genuine OTel spans.
  assert.equal(root!.attributes['oribos.span.type'], 'agent-run');
  assert.equal(typeof root!.attributes['oribos.run_id'], 'string', 'runId rides the root span');
  const firstChat = chats[0]!;
  assert.equal(firstChat.kind, 2, 'agent-step maps to OTel CLIENT kind');
  assert.equal(firstChat.attributes['gen_ai.operation.name'], 'chat');
  assert.equal(firstChat.attributes['gen_ai.request.model'], 'scripted-mini');
  assert.equal(firstChat.attributes['gen_ai.request.stream'], true, 'the loop always streams');
  assert.equal(firstChat.attributes['gen_ai.usage.input_tokens'], 11);
  const secondChat = chats[1]!;
  assert.equal(secondChat.attributes['gen_ai.usage.output_tokens'], 9);
  assert.deepEqual(JSON.parse(secondChat.attributes['gen_ai.output.messages'] as string), [
    { role: 'assistant', parts: [{ type: 'text', content: ANSWER }] },
  ]);
  assert.equal(tool!.attributes['gen_ai.tool.name'], 'checkOrder');
  assert.deepEqual(tool!.attributes['gen_ai.tool.call.result'], '{"orderId":"A-4471","eligible":true,"reason":"duplicate charge"}');
  assert.equal(root!.instrumentationScope.name, '@oribos/otel-bridge', 'the bridge is the instrumentation scope');
  console.log('  ✓ real span tree, CLIENT kind, gen_ai.* / oribos.* mapping, bridge as scope — all asserted\n');

  // ── Act 3: an external trace is continued, not replaced ────────────────────────────────────
  console.log('──────── Act 3 — a run continued from an external trace ────────');
  const externalTraceId = '1234567890abcdef1234567890abcdef';
  const externalSpanId = 'fedcba9876543210';
  const continued = deskAgent([{ text: ANSWER, usage: { inputTokens: 7, outputTokens: 9 } }]);
  const continuedRun = continued.agent.stream('Customer asks again about order A-4471.', {
    traceId: externalTraceId,
    parentSpanId: externalSpanId,
  });
  assert.equal(await drain(continuedRun), ANSWER);
  await continued.tracer.flush();

  const continuedRoot = memory
    .getFinishedSpans()
    .filter((span) => span.name === 'invoke_agent refund-desk')
    .at(-1);
  assert.ok(continuedRoot !== undefined, 'the continued run lands as its own run span');
  assert.equal(continuedRoot!.spanContext().traceId, externalTraceId, 'the run joins the caller’s trace');
  assert.equal(continuedRoot!.parentSpanContext?.spanId, externalSpanId, 'under the external parent span');
  console.log('  ✓ run span carries the external traceId and hangs under the remote parent\n');

  console.log('otel-bridge — done: opt-in zero cost, real spans in the host provider, external traces continued.');
  await provider.shutdown();
}

await main();
