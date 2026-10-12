/**
 * Oribos background-tasks example — a tool that acks now, a signal that reports later.
 *
 * Background tasks are a recipe here, not a subsystem (ADR-0011 judged the primitive combination
 * equivalent): the tool's `execute` registers the job with an application-owned worker and returns
 * immediately, the run finishes on that ack — the core's completion semantics are untouched, no
 * `untilIdle`, nothing in the framework waits for the work — and when the work is done the worker
 * calls `sendSignal` on the thread the run carried. The idle thread wakes with the rendered
 * `[signal]` message and the desk reports to the customer. One script, no external services: a
 * scripted model stub plays the desk (no API key, no network) and a `setTimeout` plays the worker's
 * latency. Zero new seams, zero dependencies.
 *
 * The three pieces the recipe is about:
 *
 * - **The tool acks, the work is yours.** `runReport` hands the job to the application's worker and
 *   returns `{ taskId, status: 'accepted' }` in the same breath. The loop's next model call
 *   composes on that ack and the run ends — the "background" is entirely the application's own
 *   worker, which is why nothing resident ever runs inside the framework.
 * - **The thread rides the request context.** A tool's `ctx` does not carry the run's memory
 *   identity, so the run is started with `replyTo` — the same thread target every signal method
 *   takes — on its open request-context bag, and the tool reads it back to route the report. The
 *   bag is per-run, so one tool serves every thread.
 * - **Completion is one `sendSignal`.** Success and failure go through the same door: a finished
 *   job signals `{ type: 'report-completed', … }`, a failed one `{ type: 'report-failed', error }`.
 *   The payload's shape is the receiver's protocol; the thread wakes with it in its prompt and in
 *   history, like any message.
 *
 * The acts:
 *
 * 1. **Ack now, report later.** The revenue report acks (`r-1`, accepted); the run ends while the
 *    work is still running — then the worker's signal wakes the thread and the woken run reports
 *    the finished report's URL.
 * 2. **Failure reports through the same door.** The inventory report acks the same way and fails
 *    out-of-band; the `report-failed` signal wakes the thread and the desk tells the customer why.
 * 3. **The framework holds nothing.** The worker is stopped and a third report acks into a job
 *    table nobody is working: no run wakes and no model call happens. Between an ack and its
 *    signal the process holds only the application's own machinery — a registered job row and,
 *    normally, its timer.
 *
 * The script asserts its own payoff (`node:assert/strict`): a run that waited for the work, a
 * signal that missed the woken run's prompt, a failure that masqueraded as success, a job nobody
 * worked that woke something — each exits non-zero instead of printing a happy face.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-background-tasks start
 */
import assert from 'node:assert/strict';
import { createApp } from '@oribos/core';
import type { AgentMemoryOptions } from '@oribos/core/agent';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { Model, ModelCallOptions, ModelStreamPart } from '@oribos/core/model';
import { AGENT_RUN_SPAN, AGENT_STEP_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';
import type { SignalPayload, Signals } from '@oribos/core/signals';
import { createTool } from '@oribos/core/tools';
import type { StandardSchema } from '@oribos/core/tools';

// ── A scripted model: the story is what the desk says and calls ───────────────────────────────

/** One scripted model call: some text, some tool calls, or both — consumed in order. */
interface ScriptEntry {
  readonly text?: string;
  readonly toolCalls?: readonly { readonly toolCallId: string; readonly toolName: string; readonly input: Record<string, unknown> }[];
}

function scriptedModel(script: readonly ScriptEntry[]): Model & { calls: () => number } {
  let answered = 0;
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'reporting-desk-model',
    calls: () => answered,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async (_call: ModelCallOptions) => {
      const entry = script[answered];
      answered += 1;
      if (entry === undefined) {
        throw new Error(`script exhausted after ${script.length} call(s) — something woke a run nobody scripted`);
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
        parts.push({ type: 'tool-call', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input });
      }
      const unified = (entry.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop';
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
  { toolCalls: [{ toolCallId: 'call-1', toolName: 'runReport', input: { kind: 'revenue' } }] },
  { text: 'Revenue report r-1 is running — I will post here when it is ready.' },
  { text: 'Revenue report r-1 is ready: https://reports.example/r-1.' },
  { toolCalls: [{ toolCallId: 'call-2', toolName: 'runReport', input: { kind: 'inventory' } }] },
  { text: 'Inventory report r-2 is running — I will post here when it is ready.' },
  { text: 'Inventory report r-2 failed: the warehouse feed is down. Want me to retry?' },
  { toolCalls: [{ toolCallId: 'call-3', toolName: 'runReport', input: { kind: 'churn' } }] },
  { text: 'Churn report r-3 is queued — I will post here when it is ready.' },
];

// ── The application's worker: a job table and a timer, nothing more ───────────────────────────

/** How long the "work" takes — the stand-in for a real job's latency. */
const WORK_MS = 300;

/**
 * The background itself, application-owned end to end: a job table (`taskId → job`) plus one
 * `setTimeout` per scheduled job. `setTimeout` plays a real worker here; in a deployment the same
 * shape is your queue consumer or worker process — what stays identical is the contract: work
 * finishes out-of-band, then one `sendSignal` reports it to the job's thread.
 */
function reportWorker(report: (target: AgentMemoryOptions, payload: SignalPayload) => Promise<void>) {
  interface Job {
    readonly kind: string;
    readonly target: AgentMemoryOptions;
    state: 'accepted' | 'running' | 'done' | 'failed';
  }
  const jobs = new Map<string, Job>();
  let scheduling = true;
  return {
    /** Registers a job and (while the worker runs) schedules it — the tool's entire ack path. */
    submit: (kind: string, target: AgentMemoryOptions): { taskId: string; status: 'accepted' } => {
      const taskId = `r-${jobs.size + 1}`;
      jobs.set(taskId, { kind, target, state: 'accepted' });
      if (scheduling) schedule(taskId);
      return { taskId, status: 'accepted' };
    },
    /** Stops scheduling new work — act 3's "nobody is working the queue" window. */
    stop: (): void => {
      scheduling = false;
    },
    status: (taskId: string): Job['state'] | undefined => jobs.get(taskId)?.state,
    /** The one thing left in the process between an ack and its signal: the job rows. */
    size: (): number => jobs.size,
  };
  function schedule(taskId: string): void {
    const job = jobs.get(taskId);
    if (job === undefined) return;
    job.state = 'running';
    setTimeout(() => {
      // Success and failure go through the same door — the payload's type is the receiver's
      // protocol, and the thread wakes with it either way.
      if (job.kind === 'revenue') {
        job.state = 'done';
        void report(job.target, { type: 'report-completed', taskId, kind: job.kind, url: `https://reports.example/${taskId}` });
      } else {
        job.state = 'failed';
        void report(job.target, { type: 'report-failed', taskId, kind: job.kind, error: 'warehouse feed is down' });
      }
    }, WORK_MS);
  }
}

// ── The tool: ack in the same breath, route the report via the request context ────────────────

/** The tool's input — `{ kind: string }` as a hand-written Standard Schema, zero dependencies. */
interface ReportInput {
  readonly kind: string;
}
const reportInputJsonSchema = {
  type: 'object',
  properties: { kind: { type: 'string', description: 'which report to run: revenue, inventory, churn' } },
  required: ['kind'],
  additionalProperties: false,
} as const;
const reportInputSchema: StandardSchema<ReportInput> = {
  '~standard': {
    version: 1,
    vendor: '@oribos/example-background-tasks',
    validate: (value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as Record<string, unknown>)['kind'] !== 'string') {
        return { issues: [{ message: 'report input must be an object with a string `kind`' }] };
      }
      return { value: { kind: (value as Record<string, unknown>)['kind'] as string } };
    },
    jsonSchema: {
      input: () => reportInputJsonSchema,
      output: () => reportInputJsonSchema,
    },
  },
};

// ── The composition root and the desk ──────────────────────────────────────────────────────────

// The memory exporter is the assertion surface: a woken run hands out no output object to await,
// so the script watches runs the way a deployment can — a run's `agent-run` span ends when the run
// does, and a step span's `input` is the model call's exact prompt.
const exporter = memoryExporter({ capacity: 1_000 });
const tracer = createTracer({ exporters: [exporter] });
const memoryStore = createInMemoryStore();
const app = createApp({ tracer, storage: { memory: memoryStore } });

// Late-bound on purpose: the worker reports through the signals facade, which is built from the
// agent, whose tool talks to the worker — the arrow runs only after the wiring below is complete.
let signals: Signals;
const worker = reportWorker((target, payload) => signals.sendSignal(target, payload));

const model = scriptedModel(SCRIPT);
const runReport = createTool({
  description:
    'Starts a report job in the background and returns immediately with its task id. The report ' +
    'itself takes a while — its result or failure arrives later as a [signal] message in this ' +
    'conversation.',
  inputSchema: reportInputSchema,
  execute: (input, ctx) => {
    // The run carried its thread identity on the open request-context bag (`replyTo`) — the same
    // target every signal method takes. Without it there is nowhere for the report to land.
    const replyTo = ctx.requestContext['replyTo'];
    if (typeof replyTo !== 'object' || replyTo === null) {
      throw new Error('runReport: no `replyTo` on the request context — start the run with its thread target on the options.');
    }
    return worker.submit(input.kind, replyTo as AgentMemoryOptions);
  },
});

const desk = app.agent({
  name: 'desk',
  instructions:
    'You are the reporting desk for a small shop. Report jobs run in the background: when you ' +
    'start one, tell the customer it is running and that you will post here when it is done. ' +
    'Results and failures arrive later as [signal] messages — report each in one short sentence.',
  model,
  tools: { runReport },
});
signals = app.signals({ agent: desk });

// ── Script helpers ─────────────────────────────────────────────────────────────────────────────

/** The one conversation this session is about, and its owner. */
const THREAD_ID = 'reports-1';
const TARGET: AgentMemoryOptions = { thread: { id: THREAD_ID, title: 'Backoffice reports' }, resource: 'backoffice' };

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

/** The rendered tail of one step span's prompt — the last message the model call saw. */
function promptTail(span: ExportedSpan | undefined): string {
  return textOf((span?.input as unknown[] | undefined)?.at(-1));
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

/** The script's read handle on history: a `Memory` over the same store the app distributed. */
const memory = new Memory({ storage: memoryStore });

/** The user messages one thread's history carries, rendered. */
async function historyTexts(threadId: string): Promise<string[]> {
  const history = await memory.recall({ threadId });
  return history.filter((message) => message.role === 'user').map((message) => textOf(message));
}

// ── The scripted session ───────────────────────────────────────────────────────────────────────

try {
  console.log('background-tasks — a tool that acks now, a signal that reports later.');
  console.log(`one thread (${THREAD_ID}), one desk, an application-owned worker (${WORK_MS}ms per job)\n`);

  console.log('Act 1 — the tool acks now, the work reports later');
  const result1 = await signals.generate('Please run the October revenue report.', {
    memory: TARGET,
    replyTo: TARGET,
  });
  assert.deepEqual(result1.toolResults[0]?.output, { taskId: 'r-1', status: 'accepted' });
  assert.equal(result1.text, SCRIPT[1]?.text);
  // The run finished on the ack — the work is still running. That is the whole trick: the core's
  // completion semantics never waited for it.
  assert.equal(worker.status('r-1'), 'running');
  console.log(`  desk acked r-1 (accepted) and answered — run ended, work still running`);

  exporter.clear();
  await waitForRuns(1);
  const tail1 = promptTail(stepSpans().at(0));
  assert.ok(
    tail1.startsWith('[signal] {"type":"report-completed","taskId":"r-1"'),
    `the woken run's prompt ends with the completed report, got "${tail1}"`,
  );
  assert.ok(tail1.includes('"url":"https://reports.example/r-1"'), `the signal carries the report url, got "${tail1}"`);
  assert.equal(reportedText(endedRuns().at(0)), SCRIPT[2]?.text);
  const history1 = await historyTexts(THREAD_ID);
  assert.equal(history1.length, 2);
  assert.equal(history1.at(-1), tail1);
  console.log(`  ${WORK_MS}ms later  ${tail1}`);
  console.log(`  [woken run] ${reportedText(endedRuns().at(0))}\n`);

  console.log('Act 2 — failure reports through the same door');
  const result2 = await signals.generate('Now run the inventory count too.', {
    memory: TARGET,
    replyTo: TARGET,
  });
  assert.deepEqual(result2.toolResults[0]?.output, { taskId: 'r-2', status: 'accepted' });

  exporter.clear();
  await waitForRuns(1);
  const tail2 = promptTail(stepSpans().at(0));
  assert.ok(
    tail2.startsWith('[signal] {"type":"report-failed","taskId":"r-2"'),
    `a failed job wakes its thread with report-failed, got "${tail2}"`,
  );
  assert.ok(tail2.includes('"error":"warehouse feed is down"'), `the failure signal carries its error, got "${tail2}"`);
  assert.equal(reportedText(endedRuns().at(0)), SCRIPT[5]?.text);
  assert.equal(worker.status('r-2'), 'failed');
  console.log(`  ${WORK_MS}ms later  ${tail2}`);
  console.log(`  [woken run] ${reportedText(endedRuns().at(0))}\n`);

  console.log('Act 3 — the framework holds nothing');
  worker.stop();
  const result3 = await signals.generate('Also queue the churn report.', {
    memory: TARGET,
    replyTo: TARGET,
  });
  assert.deepEqual(result3.toolResults[0]?.output, { taskId: 'r-3', status: 'accepted' });
  assert.equal(worker.status('r-3'), 'accepted');
  exporter.clear();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(endedRuns().length, 0);
  assert.equal(model.calls(), SCRIPT.length);
  console.log(`  worker stopped, r-3 registered (${worker.size()} job rows) — no run woke, no model call`);
  console.log('  between an ack and its signal the framework holds nothing: the application owns the background\n');

  console.log(
    'Done — ack in the tool, work in your own worker, one sendSignal when it lands. Success and ' +
      'failure through the same door, and the core never waited for any of it.',
  );
} finally {
  // Nothing to release: every timer the worker started has fired, and the framework opened none.
}
