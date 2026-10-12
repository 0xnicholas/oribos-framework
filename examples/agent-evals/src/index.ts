/**
 * Oribos agent-evals example — scorers consuming a run's public result, live and after the fact.
 *
 * One script, no external services: a support-desk agent answers an order-status question with its
 * `lookupOrder` tool, and `@oribos/evals` scores the run at the two points the public surface
 * already offers. The model is a scripted stub (no API key, no network): the story is told by what
 * the scorers actually see.
 *
 * The acts:
 *
 * 1. **Live per-step scoring.** `createScorerProcessor` wires two step scorers into the agent's
 *    `processors` — every completed step is scored as it lands, outcomes stream into the caller's
 *    sink, and the run itself is untouched (the processor observes, it never rewrites).
 * 2. **Whole-run scoring after the fact.** `scoreRun` scores the settled `generate()` result —
 *    final text, per-step records, accumulated usage, finishReason — one outcome per scorer.
 * 3. **A brittle scorer is isolated.** A scorer that throws lands as an `ok: false` outcome
 *    carrying the error: the live run completes untouched, and the rest of the batch still scores.
 * 4. **The stream scores too.** `scoreRun` accepts the `stream()` output object as-is — the output
 *    object's two consumption styles are one code path, so nothing is re-shaped for streaming.
 *
 * The script self-asserts (`node:assert/strict`): a scorer that misses the tool call, an outcome
 * attributed to the wrong step, a run disturbed by its observers, or a brittle scorer taking the
 * batch down with it exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-agent-evals start
 */
import assert from 'node:assert/strict';
import { Agent } from '@oribos/core/agent';
import type { Model, ModelCallOptions, ModelStreamPart } from '@oribos/core/model';
import type { Processor } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import { createScorerProcessor, scoreRun } from '@oribos/evals';
import type { RunScorer, StepScorer, StepScorerOutcome } from '@oribos/evals';
import { z } from 'zod';

// ── A scripted model: the story is what the scorers see ─────────────────────────────────────────

/** One scripted answer: either a text, or tool calls to make (then the next entry answers). */
interface ScriptEntry {
  readonly text?: string;
  readonly toolCalls?: readonly { toolCallId: string; toolName: string; input: unknown }[];
}

/** A minimal scripted `Model` (the vendor contract): each call consumes one script entry. */
function scriptedModel(modelId: string, script: readonly ScriptEntry[]): Model {
  let answered = 0;
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async (_call: ModelCallOptions) => {
      const entry = script[answered];
      answered += 1;
      if (entry === undefined) {
        throw new Error(`script for '${modelId}' exhausted after ${script.length} entrie(s)`);
      }
      const parts: ModelStreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (entry.text !== undefined) {
        parts.push({ type: 'text-start', id: 'text-0' });
        parts.push({ type: 'text-delta', id: 'text-0', delta: entry.text });
        parts.push({ type: 'text-end', id: 'text-0' });
      }
      for (const toolCall of entry.toolCalls ?? []) {
        const input = JSON.stringify(toolCall.input);
        parts.push({ type: 'tool-input-start', id: toolCall.toolCallId, toolName: toolCall.toolName });
        parts.push({ type: 'tool-input-delta', id: toolCall.toolCallId, delta: input });
        parts.push({ type: 'tool-input-end', id: toolCall.toolCallId });
        parts.push({
          type: 'tool-call',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input,
        });
      }
      const unified = entry.toolCalls?.length ? 'tool-calls' : 'stop';
      parts.push({
        type: 'finish',
        finishReason: { unified, raw: unified },
        usage: {
          inputTokens: { total: 30, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 12, text: undefined, reasoning: undefined },
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

const SCRIPT: readonly ScriptEntry[] = [
  { toolCalls: [{ toolCallId: 'call-1', toolName: 'lookupOrder', input: { orderId: 'A-1007' } }] },
  { text: 'Order A-1007 shipped on Tuesday and arrives Friday.' },
];

function supportDesk(processors?: readonly Processor[]): Agent {
  return new Agent({
    name: 'support-desk',
    instructions: 'You are a support desk. Look the order up, then answer in one sentence.',
    model: scriptedModel('support-desk-model', SCRIPT),
    tools: {
      lookupOrder: createTool({
        description: 'Looks up an order’s status by id.',
        inputSchema: z.object({ orderId: z.string() }),
        execute: (input) => ({ orderId: input.orderId, status: 'shipped', eta: 'Friday' }),
      }),
    },
    ...(processors === undefined ? {} : { processors }),
  });
}

// ── The scorers: plain objects, a name plus score() ─────────────────────────────────────────────

/** Step scorer: a step stays focused when it asks for at most one tool call. */
const focusedStep: StepScorer = {
  name: 'focused-step',
  score: ({ step }) => ({
    value: step.toolCalls.length <= 1 ? 1 : 0,
    reason: `${step.toolCalls.length} tool call(s) in this step`,
  }),
};

/** Step scorer: a step makes progress when it carries text or a tool call. */
const progressingStep: StepScorer = {
  name: 'progressing-step',
  score: ({ step }) => ({ value: step.text !== '' || step.toolCalls.length > 0 ? 1 : 0 }),
};

/** Run scorer: the answer names the order it was asked about. */
const namesTheOrder: RunScorer = {
  name: 'names-the-order',
  score: ({ text }) => ({
    value: text.includes('A-1007') ? 1 : 0,
    reason: 'the final answer cites the order id',
  }),
};

/** Run scorer: the run ended cleanly — a truncated answer would score 0 here. */
const cleanFinish: RunScorer = {
  name: 'clean-finish',
  score: ({ finishReason }) => ({ value: finishReason === 'stop' ? 1 : 0 }),
};

/** Run scorer: token frugality against a fixed budget. */
const frugal: RunScorer = {
  name: 'frugal',
  score: ({ usage }) => ({
    value: (usage.totalTokens ?? Number.POSITIVE_INFINITY) <= 100 ? 1 : 0,
    reason: `${usage.totalTokens} total token(s) against a budget of 100`,
  }),
};

/** A scorer whose own judge is down — it throws, every time. */
const brittleJudge: RunScorer & StepScorer = {
  name: 'brittle-judge',
  score: () => {
    throw new Error('judge model unavailable');
  },
};

// ── Act 1: live per-step scoring through the Processor seam ─────────────────────────────────────

const liveOutcomes: StepScorerOutcome[] = [];
const desk = supportDesk([
  createScorerProcessor({
    scorers: [focusedStep, progressingStep],
    onScore: (outcome) => {
      liveOutcomes.push(outcome);
      const score = outcome.ok ? `score ${outcome.score.value}` : `FAILED: ${outcome.error}`;
      console.log(`  step ${outcome.stepIndex} · ${outcome.scorer}: ${score}`);
    },
  }),
]);

console.log('Act 1 — live per-step scoring (Processor wiring)');
const result = await desk.generate('Where is order A-1007?');
console.log(`  answer: ${result.text}\n`);

// Two steps (lookup, then the answer) × two scorers, in declaration order per step.
assert.deepEqual(
  liveOutcomes.map((outcome) => [outcome.stepIndex, outcome.scorer, outcome.ok]),
  [
    [0, 'focused-step', true],
    [0, 'progressing-step', true],
    [1, 'focused-step', true],
    [1, 'progressing-step', true],
  ],
);
assert.equal(result.text, 'Order A-1007 shipped on Tuesday and arrives Friday.');
assert.equal(result.finishReason, 'stop');
assert.equal(result.steps.length, 2);

// ── Act 2: whole-run scoring after the fact ─────────────────────────────────────────────────────

console.log('Act 2 — whole-run scoring (scoreRun over the settled result)');
const runOutcomes = await scoreRun(result, [namesTheOrder, cleanFinish, frugal]);
for (const outcome of runOutcomes) {
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const reason = outcome.score.reason === undefined ? '' : ` — ${outcome.score.reason}`;
    console.log(`  ${outcome.scorer}: ${outcome.score.value}${reason}`);
  }
}
assert.deepEqual(
  runOutcomes.map((outcome) => [outcome.scorer, outcome.ok && outcome.score.value]),
  [
    ['names-the-order', 1],
    ['clean-finish', 1],
    ['frugal', 1],
  ],
);

// ── Act 3: a brittle scorer is isolated — the run and the batch carry on ───────────────────────

console.log('Act 3 — a throwing scorer lands as an ok:false outcome, nothing else disturbed');
const isolatedOutcomes: StepScorerOutcome[] = [];
const observedDesk = supportDesk([
  createScorerProcessor({
    scorers: [brittleJudge, focusedStep],
    onScore: (outcome) => {
      isolatedOutcomes.push(outcome);
    },
  }),
]);
const observedResult = await observedDesk.generate('Where is order A-1007?');
assert.equal(observedResult.text, 'Order A-1007 shipped on Tuesday and arrives Friday.');
assert.deepEqual(
  isolatedOutcomes.map((outcome) => [outcome.stepIndex, outcome.scorer, outcome.ok]),
  [
    [0, 'brittle-judge', false],
    [0, 'focused-step', true],
    [1, 'brittle-judge', false],
    [1, 'focused-step', true],
  ],
);
const isolated = isolatedOutcomes[0];
assert.equal(isolated?.ok, false);
if (isolated !== undefined && !isolated.ok) {
  assert.match(String(isolated.error), /judge model unavailable/);
  console.log(`  live: brittle-judge isolated (${(isolated.error as Error).message}), run finished 'stop'`);
}

const batchOutcomes = await scoreRun(observedResult, [brittleJudge, namesTheOrder]);
assert.deepEqual(
  batchOutcomes.map((outcome) => [outcome.scorer, outcome.ok]),
  [
    ['brittle-judge', false],
    ['names-the-order', true],
  ],
);
console.log('  post-hoc: the batch kept its healthy score alongside the failure\n');

// ── Act 4: the stream output object scores as-is (dual consumption, one code path) ─────────────

console.log('Act 4 — scoreRun over the stream() output object');
const streamDesk = supportDesk();
const stream = streamDesk.stream('Where is order A-1007?');
let streamed = '';
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') streamed += chunk.textDelta;
}
const streamOutcomes = await scoreRun(stream, [namesTheOrder, cleanFinish]);
assert.equal(streamed, 'Order A-1007 shipped on Tuesday and arrives Friday.');
assert.deepEqual(
  streamOutcomes.map((outcome) => [outcome.scorer, outcome.ok && outcome.score.value]),
  [
    ['names-the-order', 1],
    ['clean-finish', 1],
  ],
);
for (const outcome of streamOutcomes) {
  if (outcome.ok) console.log(`  ${outcome.scorer}: ${outcome.score.value}`);
}

console.log('\nAll four acts asserted — live wiring, post-hoc scoring, failure isolation, the stream.');
