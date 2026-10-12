/**
 * Oribos agent-supervisor example — one parent agent delegating to sub-agents wrapped as tools.
 *
 * One script, no external services: a research desk (`desk`, built with `createSupervisor` from
 * `@oribos/supervisor`) coordinates two specialists — a `researcher` with its own `lookup` tool
 * and a `writer`. The models are scripted stubs (no API key, no network): the story is told by
 * what each model actually receives.
 *
 * The acts:
 *
 * 1. **One delegation.** The desk delegates a research question; the researcher runs its own full
 *    agent loop (its `lookup` tool call included) and the desk is fed back the sub-run's terminal
 *    text — bare, not the whole run-result object. The researcher's recorded prompt shows the
 *    delegation contract: its own instructions plus exactly one constructed user message — nothing
 *    of the parent's context crosses over.
 * 2. **Two delegations in one step.** The desk calls `researcher` and `writer` in a single step;
 *    the calls execute in call order (the default serial mode), and the desk composes both answers.
 * 3. **One trace.** With a tracer on every agent, the delegated run's `agent-run` span hangs under
 *    the parent's `tool-call` span in the same trace — the observability tree does not break at a
 *    delegation boundary.
 * 4. **A truncated delegation is visible.** With `delegation: { maxSteps: 1 }`, a researcher that
 *    wants a second step finishes `'tool-calls'`; the desk is fed `{ text, finishReason }` — it can
 *    tell the answer is partial instead of reading it as complete.
 *
 * The script self-asserts (`node:assert/strict`): a researcher that sees parent context, a
 * delegation result that is not bare text, a broken span tree, or an invisible truncation exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-agent-supervisor start
 */
import assert from 'node:assert/strict';
import { createSupervisor } from '@oribos/supervisor';
import { Agent } from '@oribos/core/agent';
import type { Model, ModelCallOptions, ModelStreamPart } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import { z } from 'zod';

// ── Scripted models: the story is what each model receives ──────────────────────────────────────

/** One scripted answer: either a text, or tool calls to make (then the next entry answers). */
interface ScriptEntry {
  readonly text?: string;
  readonly toolCalls?: readonly { toolCallId: string; toolName: string; input: unknown }[];
}

/**
 * A minimal scripted `Model` (the vendor contract): each call consumes one script entry and
 * records what it was called with, so the acts can assert exactly what a sub-agent was handed.
 * (The offline examples keep their own teaching stubs instead of importing the repo's test fake.)
 */
function scriptedModel(modelId: string, script: readonly ScriptEntry[]) {
  const calls: ModelCallOptions[] = [];
  let answered = 0;
  const model: Model & { readonly calls: ModelCallOptions[] } = {
    specificationVersion: 'v4',
    provider: 'example',
    modelId,
    calls,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async (call) => {
      // Record by value: the loop grows the same prompt array across steps, so a reference would
      // show later messages in an early call's record.
      calls.push({ ...call, prompt: structuredClone(call.prompt) });
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
          inputTokens: { total: 24, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
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
  return model;
}

// ── The desk: a supervisor over two specialists ─────────────────────────────────────────────────

const RESEARCHER_INSTRUCTIONS = 'You are a researcher. Answer from the almanac, in one sentence.';
const WRITER_INSTRUCTIONS = 'You are a writer. Turn notes into one crisp headline.';
const DESK_INSTRUCTIONS =
  'You are the research desk. Delegate research to `researcher` and drafting to `writer`.';

/** The almanac the researcher's own tool reads — the sub-agent keeps its own tools. */
const ORIBOS_FACT =
  'Oribos is a TypeScript agent framework whose core carries zero runtime dependencies.';
const ALMANAC: Record<string, string> = {
  oribos: ORIBOS_FACT,
};

/** A researcher over a fresh scripted model, with its own `lookup` tool. */
function makeResearcher(script: readonly ScriptEntry[]) {
  const model = scriptedModel('researcher-model', script);
  const agent = new Agent({
    name: 'researcher',
    instructions: RESEARCHER_INSTRUCTIONS,
    model,
    description: 'Researches questions against the almanac.',
    tools: {
      lookup: createTool({
        description: 'Reads one almanac entry by topic.',
        inputSchema: z.object({ topic: z.string() }),
        execute: ({ topic }) => ALMANAC[topic] ?? 'no entry',
      }),
    },
  });
  return { agent, model };
}

/** A writer over a fresh scripted model (no tools of its own). */
function makeWriter(script: readonly ScriptEntry[]) {
  const model = scriptedModel('writer-model', script);
  const agent = new Agent({
    name: 'writer',
    instructions: WRITER_INSTRUCTIONS,
    model,
    description: 'Drafts a headline from research notes.',
  });
  return { agent, model };
}

console.log('agent-supervisor — one parent agent, sub-agents as delegation tools.');

// ── Act 1 — one delegation: a full sub-run, bare text back ──────────────────────────────────────

console.log('\n──────── Act 1 — one delegation: the researcher runs its own loop ────────');
{
  const researcher = makeResearcher([
    { toolCalls: [{ toolCallId: 'lookup-1', toolName: 'lookup', input: { topic: 'oribos' } }] },
    { text: ORIBOS_FACT },
  ]);
  const deskModel = scriptedModel('desk-model', [
    {
      toolCalls: [
        { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is Oribos?' } },
      ],
    },
    { text: 'Oribos: a zero-dependency TypeScript agent framework.' },
  ]);
  const desk = createSupervisor({
    name: 'desk',
    instructions: DESK_INSTRUCTIONS,
    model: deskModel,
    agents: { researcher: researcher.agent },
  });

  const result = await desk.generate('Tell me about Oribos.');

  // The delegation was one ordinary tool call; the researcher ran its own loop (lookup included).
  assert.equal(researcher.model.calls.length, 2);
  // The delegation contract: the sub-agent's own instructions plus exactly one constructed
  // message — nothing of the parent's prompt crosses over.
  assert.deepEqual(researcher.model.calls[0]?.prompt, [
    { role: 'system', content: RESEARCHER_INSTRUCTIONS },
    { role: 'user', content: [{ type: 'text', text: 'What is Oribos?' }] },
  ]);
  // A 'stop'-finished delegation feeds back its terminal text, bare.
  assert.deepEqual(result.toolResults, [
    {
      type: 'tool-result',
      toolCallId: 'delegate-1',
      toolName: 'researcher',
      output: ORIBOS_FACT,
      isError: false,
    },
  ]);
  console.log(`researcher <- ${JSON.stringify('What is Oribos?')}`);
  console.log(`researcher -> ${JSON.stringify(result.toolResults[0]?.output)}`);
  console.log(`desk: ${result.text}`);
}

// ── Act 2 — two delegations in one step ─────────────────────────────────────────────────────────

console.log('\n──────── Act 2 — two delegations in one step, in call order ────────');
{
  const researcher = makeResearcher([{ text: ORIBOS_FACT }]);
  const writer = makeWriter([{ text: '"Zero-dependency agents, in TypeScript."' }]);
  const deskModel = scriptedModel('desk-model', [
    {
      toolCalls: [
        { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is Oribos?' } },
        {
          toolCallId: 'delegate-2',
          toolName: 'writer',
          input: { prompt: 'Headline for: zero runtime dependencies.' },
        },
      ],
    },
    { text: 'Research in, headline out.' },
  ]);
  const desk = createSupervisor({
    name: 'desk',
    instructions: DESK_INSTRUCTIONS,
    model: deskModel,
    agents: { researcher: researcher.agent, writer: writer.agent },
  });

  const result = await desk.generate('Research Oribos, then headline it.');

  // The default serial mode runs a step's calls one at a time, in call order.
  assert.deepEqual(
    result.toolResults.map((toolResult) => toolResult.toolName),
    ['researcher', 'writer'],
  );
  assert.equal(researcher.model.calls.length, 1);
  assert.equal(writer.model.calls.length, 1);
  console.log(`step 1 -> researcher, writer (in call order)`);
  console.log(`writer -> ${JSON.stringify(result.toolResults[1]?.output)}`);
  console.log(`desk: ${result.text}`);
}

// ── Act 3 — one trace: the delegated run hangs under the tool-call span ─────────────────────────

console.log('\n──────── Act 3 — one trace across the delegation boundary ────────');
{
  const memory = memoryExporter();
  const tracer = createTracer({ exporters: [memory] });
  const researcherModel = scriptedModel('researcher-model', [{ text: ORIBOS_FACT }]);
  const researcher = new Agent({
    name: 'researcher',
    instructions: RESEARCHER_INSTRUCTIONS,
    model: researcherModel,
    description: 'Researches questions against the almanac.',
    tracer,
  });
  const deskModel = scriptedModel('desk-model', [
    {
      toolCalls: [
        { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is Oribos?' } },
      ],
    },
    { text: 'done' },
  ]);
  const desk = createSupervisor({
    name: 'desk',
    instructions: DESK_INSTRUCTIONS,
    model: deskModel,
    agents: { researcher },
    tracer,
  });

  await desk.generate('Trace this.');

  const spans = memory.spans();
  const span = (type: string, name: string) => {
    const found = spans.find((candidate) => candidate.type === type && candidate.name === name);
    assert.ok(found, `expected a ${type} span named '${name}'`);
    return found;
  };
  const deskRun = span(AGENT_RUN_SPAN, 'desk');
  const toolCall = span(TOOL_CALL_SPAN, 'researcher');
  const childRun = span(AGENT_RUN_SPAN, 'researcher');
  // The delegated run is a child span of the delegation's tool-call span, in the same trace.
  assert.equal(childRun.parentSpanId, toolCall.id);
  assert.equal(childRun.traceId, deskRun.traceId);
  console.log(`trace ${childRun.traceId}`);
  console.log(`  agent-run desk`);
  console.log(`  └─ tool-call researcher`);
  console.log(`     └─ agent-run researcher   <- the delegation, in the same trace`);
}

// ── Act 4 — a truncated delegation is visible to the parent ─────────────────────────────────────

console.log('\n──────── Act 4 — delegation.maxSteps: 1 — the desk sees the truncation ────────');
{
  const researcher = makeResearcher([
    { toolCalls: [{ toolCallId: 'lookup-1', toolName: 'lookup', input: { topic: 'oribos' } }] },
  ]);
  const deskModel = scriptedModel('desk-model', [
    {
      toolCalls: [
        { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is Oribos?' } },
      ],
    },
    { text: 'The researcher was cut short (tool-calls); reporting the partial.' },
  ]);
  const desk = createSupervisor({
    name: 'desk',
    instructions: DESK_INSTRUCTIONS,
    model: deskModel,
    agents: { researcher: researcher.agent },
    delegation: { maxSteps: 1 },
  });

  const result = await desk.generate('Tell me about Oribos.');

  // One step cap: the lookup ran, but no second model call — the sub-run finishes 'tool-calls',
  // and the desk is fed { text, finishReason } instead of a bare (and silently partial) text.
  assert.equal(researcher.model.calls.length, 1);
  assert.deepEqual(result.toolResults[0]?.output, { text: '', finishReason: 'tool-calls' });
  console.log(`researcher -> ${JSON.stringify(result.toolResults[0]?.output)}`);
  console.log(`desk: ${result.text}`);
}

console.log('\nDone — delegation stayed ordinary tool calls all the way down: constructed input,');
console.log('bare-text results, one trace, and no hidden truncations.');
