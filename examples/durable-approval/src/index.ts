/**
 * Oribos durable-approval example — a refund desk where money moves only after a human says so.
 *
 * A scripted, non-interactive run drives one durable agent over a real OpenAI model and shows the
 * M4 approval gate end to end: the model's tool calls reach the loop's step boundary, a call whose
 * tool name is on the approval list does **not** execute, the run's loop snapshot goes to the
 * `AgentRunSnapshotStore`, `finishReason` settles `'suspended'`, and `resume(runId, { approved })`
 * continues the run — execute the held calls, or answer them with a rejection tool result and let
 * the model replan.
 *
 * The acts:
 *
 * 1. **Run A suspends** — the customer asks for a $129 refund; the model calls `issueRefund`, the
 *    gate holds the call, and the run lands `'suspended'` with `suspendPayload` reporting what was
 *    held back. Nothing executed: the refund ledger is still empty.
 * 2. **The snapshot** — what a resume needs, straight from the store: the message list the run
 *    stopped at (the prompt plus the model's own tool-calling message), the step count, the held
 *    calls, and the `traceId` the run was exported under. The store decorator's write log shows the
 *    one snapshot a suspension writes — the shape has no terminal state.
 * 3. **Resume, approved** — `resume(runId, { approved: true })` loads the snapshot, replays the
 *    held call as the run's first step (no model round trip re-deriving it), executes it — the
 *    ledger gets its entry — and the run finishes on the model's report. The resumed segment opens
 *    a fresh `agent-run` span in the *same* trace, so one HITL interaction stays one trace.
 * 4. **Run B suspends** — a second request, same gate, same shape.
 * 5. **Resume, rejected** — `{ approved: false }` runs nothing: the held call is answered with a
 *    rejection result, the model receives it as an ordinary tool failure and replans. A refusal
 *    does not terminate the run, and the ledger is untouched.
 *
 * The script asserts its own payoff: a run that does not suspend, a refund that executes while the
 * run is suspended, a resume that does not reach `'stop'`, or a rejection that moves money exits
 * non-zero instead of printing a happy face.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-durable-approval start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @oribos/example-durable-approval start
 */
import { openai } from '@ai-sdk/openai';
import { createApp } from '@oribos/core';
import { createInMemoryAgentRunSnapshotStore } from '@oribos/core/durable-agent';
import type { DurableStreamResult } from '@oribos/core/durable-agent';
import type { AgentRunSnapshotStore } from '@oribos/core/durable-agent';
import type { Chunk, FinishReason, ModelMessage } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  consoleExporter,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** The two scripted requests: the order, the overcharge, and the customer's words. */
const REQUEST_A = { orderId: 'A-4471', amount: 129 };
const REQUEST_B = { orderId: 'B-8890', amount: 1_240 };

/**
 * The refund ledger — what the gated tool writes to, and what the script counts. It is the
 * example's stand-in for money moving: a call that never executes leaves it untouched, which is
 * the whole point of the gate. A real tool would hit a payment API; the ledger is what makes the
 * payoff assertable.
 */
const refunds: Array<{ orderId: string; amount: number }> = [];

/**
 * The ledger's size. The script's assertions read it through a call, so they always see what the
 * tool has written — and the type checker never narrows a bare `refunds.length` to a literal.
 */
function ledgerSize(): number {
  return refunds.length;
}

/**
 * The tool the approval list gates. Its description tells the model that executing it is a
 * commitment, but nothing on the tool itself declares that a human must approve it — the approval
 * list lives on the durable wrapper (`approval` is declared there; a tool's four fields carry no
 * permission).
 */
const issueRefund = createTool({
  description:
    'Issue a refund for an order. Money leaves the account and cannot be recalled — this call ' +
    'requires a human approval before it executes.',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: ({ orderId, amount }) => {
    refunds.push({ orderId, amount });
    return { refunded: true, orderId, amount };
  },
});

/**
 * The store is a port: any object with `load` / `save` (`AgentRunSnapshotStore`, JSON-only, 2
 * methods). This one decorates the core's in-memory default with a write log, so the durable
 * ritual is visible: one `suspended` snapshot per suspension and nothing else — a consumed
 * snapshot is the application's to drop, exactly as cross-process safety is. A real deployment
 * swaps the in-memory default for a persistent adapter.
 */
function recordingStore(): { readonly store: AgentRunSnapshotStore; readonly writes: string[] } {
  const inner = createInMemoryAgentRunSnapshotStore();
  const writes: string[] = [];
  return {
    writes,
    store: {
      load: (id) => inner.load(id),
      save: (id, snapshot) => {
        const held = snapshot.suspendPayload.toolCalls.map((call) => call.toolName).join(', ');
        writes.push(`suspended  stepCount=${snapshot.stepCount}  held=[${held}]  runId=${id}`);
        return inner.save(id, snapshot);
      },
    },
  };
}

// One tracer is assembled here and distributed by the composition root (ADR-0002): the agent
// receives it through `app.agent`, the durable wrapper's snapshot store through the
// `storage.durableAgent` slot. The memory exporter keeps the spans in-process — the assertions
// below read them (it is the observability kernel's specified assertion surface).
const exporter = memoryExporter({ capacity: 2_000 });
const tracer = createTracer({ exporters: [consoleExporter(), exporter] });
const { store, writes } = recordingStore();

const app = createApp({ tracer, storage: { durableAgent: store } });

const agent = app.agent({
  name: 'refund-desk',
  instructions:
    'You are the refund desk for a small shop. When a customer asks for a refund, call ' +
    'issueRefund with the order id and the amount they were overcharged, then report the outcome ' +
    'in one or two short sentences. If the refund comes back rejected, apologise in one sentence ' +
    'and offer a concrete alternative (store credit or a manual review) instead.',
  // Chat Completions is the lowest common denominator: it works against OpenAI and any
  // OpenAI-compatible endpoint (Ollama, LM Studio, gateways).
  model: openai.chat('gpt-4o-mini'),
  tools: { issueRefund },
});

/**
 * The durable wrapper: the agent's own run surface plus `resume`, with the approval list declared
 * here. The gate only exists in this wrapper — a bare `agent.generate(...)` never produces
 * `'suspended'` and keeps no snapshot.
 */
const durable = app.durableAgent({ agent, approval: { tools: ['issueRefund'] } });

// ── Script helpers ─────────────────────────────────────────────────────────────────────────────

/** A narration header between acts of the scripted session. */
function act(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

/** The example's assertion: a payoff the script does not see exits non-zero. */
function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** JSON with a hard cap, for one-line printouts. */
function clip(value: unknown, max = 88): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One compact line per chunk of the run's stream protocol. */
function chunkLine(chunk: Chunk): string {
  switch (chunk.type) {
    case 'text-delta':
      return `[chunk] text-delta   ${JSON.stringify(chunk.textDelta)}`;
    case 'tool-call':
      return `[chunk] tool-call    ${chunk.toolName}(${clip(chunk.input, 60)})`;
    case 'tool-result':
      return `[chunk] tool-result  ${chunk.toolName} -> ${clip(chunk.output, 60)}${chunk.isError ? '  (error)' : ''}`;
    case 'finish':
      return `[chunk] finish       ${chunk.finishReason}`;
    default:
      // Opt-in delta frames (run option `deltas`) never occur in this example — it sets no
      // `deltas`; any other future chunk type degrades to its type name (unknown frames are
      // safe to ignore).
      return `[chunk] ${chunk.type}`;
  }
}

/** One line describing a prompt message: its text plus any tool call it carries. */
function partLine(part: unknown): string {
  if (typeof part !== 'object' || part === null) return String(part);
  const record = part as Record<string, unknown>;
  switch (record['type']) {
    case 'text':
      return String(record['text'] ?? '');
    case 'tool-call':
      return `→ ${String(record['toolName'])}(${clip(record['input'], 44)})`;
    case 'tool-result':
      return `← ${String(record['toolName'])}`;
    default:
      return `[${String(record['type'])}]`;
  }
}

/** The rendered form of one `ModelMessage` (content is a string for system, parts otherwise). */
function messageSummary(message: ModelMessage): string {
  const content: unknown = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => partLine(part)).join(' ');
}

/** Whether one snapshot message is the assistant turn that requested a given tool. */
function requests(message: ModelMessage | undefined, toolName: string): boolean {
  if (message === undefined || message.role !== 'assistant') return false;
  const content: unknown = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as Record<string, unknown>)['type'] === 'tool-call' &&
      (part as Record<string, unknown>)['toolName'] === toolName,
  );
}

/** Every `agent-run` span the tracer exported so far. */
function runSpans(): readonly ExportedSpan[] {
  return exporter.spans().filter((span) => span.type === AGENT_RUN_SPAN);
}

/** One attribute off an exported span — the span model's attributes are its own open bag. */
function attribute(span: ExportedSpan, key: string): unknown {
  const attributes: unknown = span.attributes;
  return typeof attributes === 'object' && attributes !== null
    ? (attributes as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Streams one run's chunks to the console and returns its terminal reason. The suspend payload is
 * read alongside it, so the run has fully settled by the time the act continues.
 */
async function settle(run: DurableStreamResult): Promise<FinishReason> {
  for await (const chunk of run) console.log(chunkLine(chunk));
  const [finishReason] = await Promise.all([run.finishReason, run.suspendPayload]);
  return finishReason;
}

// ── The scripted session ───────────────────────────────────────────────────────────────────────

console.log('durable-approval — a refund desk where money moves only after a human says so.');

act(`Act 1 — run A: the model asks to refund $${REQUEST_A.amount}; the gate suspends the run`);
const runA = durable.stream(
  `Customer message: "You charged me twice for order ${REQUEST_A.orderId} — please refund the ` +
    `$${REQUEST_A.amount} overcharge."`,
);
const finishA = await settle(runA);
const suspendA = await runA.suspendPayload;

if (finishA !== 'suspended') {
  fail(
    `Expected run '${runA.runId}' to suspend at the approval gate, but it settled '${finishA}'. ` +
      'The gate only fires when the model calls a listed tool — re-run the example.',
  );
}
if (suspendA === undefined) {
  fail(`Run '${runA.runId}' settled 'suspended' without a suspend payload.`);
}
if (ledgerSize() !== 0) {
  fail(`A call executed while run '${runA.runId}' was suspended — the gate did not hold.`);
}

console.log(`\nRun '${runA.runId}' settled '${finishA}'.`);
console.log(
  `  held calls   ${suspendA.toolCalls.map((call) => `${call.toolName}(${clip(call.input, 48)})`).join(', ')}`,
);
console.log(`  awaiting     ${suspendA.awaitingApproval.join(', ')}  ← the ids resume's decision governs`);
console.log(`  ledger       ${ledgerSize()} entries  ← nothing executed`);

act('Act 2 — the snapshot: the one write a suspension makes, and what a resume loads');
console.log(`Store writes so far (${writes.length}):`);
for (const write of writes) console.log(`  ${write}`);

// `load` returns the JSON-only state a resume re-enters from — run identity, message list, step
// count and the held calls — plus the trace the run was exported under.
const snapshot = await store.load(runA.runId);
if (snapshot === null) fail(`Expected a snapshot for run '${runA.runId}', but the store has none.`);
if (snapshot.status !== 'suspended') fail(`Expected a 'suspended' snapshot, got '${snapshot.status}'.`);
if (ledgerSize() !== 0) fail('The ledger moved while the snapshot was being read.');

const lastMessage = snapshot.messages.at(-1);
if (!requests(lastMessage, 'issueRefund')) {
  fail(
    'The snapshot does not end with the model\'s tool-calling message — a resume would have ' +
      'nothing to replay and no assistant turn to answer.',
  );
}

console.log(`\nstore.load('${runA.runId}') — one JSON value:`);
console.log(`  status       ${snapshot.status}`);
console.log(`  stepCount    ${snapshot.stepCount}  ← where a resume continues numbering`);
console.log(`  traceId      ${snapshot.traceId ?? '(untraced)'}  ← the resumed segment opens its span here`);
console.log(`  messages     ${snapshot.messages.length} — the prompt plus the model's own tool-calling turn:`);
for (const message of snapshot.messages) {
  console.log(`    ${message.role.padEnd(9)} ${messageSummary(message).slice(0, 88)}`);
}
console.log('  suspendPayload.toolCalls:');
for (const call of snapshot.suspendPayload.toolCalls) {
  console.log(`    ${call.toolName}(${clip(call.input, 56)})  toolCallId=${call.toolCallId}`);
}

// The observability anchor: suspension is a normal end of the run's `agent-run` span under a status
// attribute — not an error, not a new span type.
const suspended = runSpans().find((span) => attribute(span, 'status') === 'suspended');
if (suspended === undefined) {
  fail("Expected the suspended run's `agent-run` span to carry attributes.status = 'suspended'.");
}
if (snapshot.traceId === undefined || suspended.traceId !== snapshot.traceId) {
  fail("The suspended run's span is not in the trace the snapshot carries.");
}
console.log(`\n  agent-run    attributes.status='suspended'  trace=${suspended.traceId}  ← normal end`);

act('Act 3 — resume(approved: true): the held call executes and the run continues');
// The resumed segment's spans are the only ones in front of us from here on.
exporter.clear();

const outcomeA = await durable.resume(runA.runId, { approved: true });
if (outcomeA.finishReason !== 'stop') {
  fail(`Expected the resumed run to reach 'stop', but it settled '${outcomeA.finishReason}'.`);
}
if (
  ledgerSize() !== 1 ||
  refunds[0]?.orderId !== REQUEST_A.orderId ||
  refunds[0]?.amount !== REQUEST_A.amount
) {
  fail(`Expected exactly the approved refund on the ledger, got ${JSON.stringify(refunds)}.`);
}
const executed = outcomeA.toolResults.find((result) => result.toolName === 'issueRefund');
if (executed === undefined || executed.isError) {
  fail(`Expected an executed refund result, got ${clip(executed?.output)}.`);
}
const resumedSpans = runSpans();
if (snapshot.traceId === undefined || resumedSpans.length === 0) {
  fail('The resumed segment exported no `agent-run` span.');
}
if (resumedSpans.some((span) => span.traceId !== snapshot.traceId)) {
  fail("The resumed segment's span opened a new trace — the suspension broke the observation tree.");
}

console.log(`resume('${runA.runId}', { approved: true }) — the run continued:`);
console.log(`  agent-run    ${resumedSpans.length} span(s), all in trace ${snapshot.traceId}  ← one HITL, one trace`);
console.log(`  tool result  ${clip(executed.output)}`);
console.log(`  ledger       ${JSON.stringify(refunds)}`);
console.log(`\nDesk reply:\n${outcomeA.text.trim()}`);

act(`Act 4 — run B: a second request (order ${REQUEST_B.orderId}) suspends the same way`);
const runB = durable.stream(
  `Customer message: "Order ${REQUEST_B.orderId} was charged twice — please refund the ` +
    `$${REQUEST_B.amount} duplicate charge."`,
);
const finishB = await settle(runB);
const suspendB = await runB.suspendPayload;
if (finishB !== 'suspended' || suspendB === undefined) {
  fail(`Expected run '${runB.runId}' to suspend, but it settled '${finishB}'.`);
}
if (ledgerSize() !== 1) fail('The ledger moved while run B was suspended.');
console.log(`\nRun '${runB.runId}' settled 'suspended' — ledger still ${ledgerSize()} entry.`);

act('Act 5 — resume(approved: false): nothing executes; the refusal is fed back and the model replans');
const outcomeB = await durable.resume(runB.runId, { approved: false });
if (outcomeB.finishReason !== 'stop') {
  fail(
    `A rejection must not terminate the run — expected 'stop', got '${outcomeB.finishReason}'.`,
  );
}
if (ledgerSize() !== 1) fail(`A rejected call executed: ledger = ${JSON.stringify(refunds)}.`);
const rejected = outcomeB.toolResults.find((result) => result.toolName === 'issueRefund');
if (rejected === undefined || !rejected.isError) {
  fail(`Expected the held call to come back as a rejection result, got ${clip(rejected?.output)}.`);
}
if (outcomeB.text.trim() === '') {
  fail('The model produced no reply after the rejection — nothing replanned.');
}

console.log(`resume('${runB.runId}', { approved: false }) — the run continued:`);
console.log(`  tool result  ${clip(rejected.output)}  (isError=${String(rejected.isError)})`);
console.log(`  ledger       ${JSON.stringify(refunds)}  ← unchanged`);
console.log(`\nDesk reply:\n${outcomeB.text.trim()}`);

console.log(
  `\nDone — the approved call executed and its run finished; the rejected one never ran, and the ` +
    `model replanned from the refusal. Two runs, two suspensions, two resumes — the store's whole ` +
    `write log is ${writes.length} line(s).`,
);
