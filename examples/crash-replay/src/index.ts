/**
 * Oribos crash-replay example — a process is killed mid-run; the next process boots, sweeps the
 * checkpoint store, and replays the run from its last completed step.
 *
 * The crash is real: one `node` process starts an agent run and SIGKILLs itself in the middle of
 * it (the model stub's third call — a real crash is exactly that from the run's point of view: no
 * unwind, no settle hook, nothing but what already reached the store). The store is this
 * example's own file-backed `AgentRunCheckpointStore` — the deployment's half of the port, a JSON
 * file both processes open — and the second process attaches the same file, calls `recoverAll()`,
 * and checks what the replay costs.
 *
 * The acts:
 *
 * 1. **Crash.** The worker's run completes step 0 and step 1 (two model calls, two `note` tool
 *    executions) and dies during step 2's model call. The last checkpoint — step 1's boundary —
 *    is what survives, in the store file.
 * 2. **Boot sweep.** `recoverAll()` finds the residue and replays it: the replayed step makes no
 *    model call (its output came from the checkpoint), its `note` call executes again (the
 *    idempotency cost, visible in the log as a `boot` line), and step 2's model call is re-sent —
 *    the one in-flight call, and the only model work a recovery ever repeats.
 * 3. **Cleared.** The recovered run settles and consumes its checkpoint; a second sweep finds
 *    nothing.
 *
 * The script self-asserts (`node:assert/strict`): a re-sent completed step, a missing tool
 * re-execution, or a leftover checkpoint exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-crash-replay start
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@oribos/core/agent';
import type { Model, ModelStreamPart } from '@oribos/core/model';
import type { StandardSchema, Tool } from '@oribos/core/tools';
import { createCheckpointedAgent } from '@oribos/checkpoints';
import type { AgentRunCheckpoint, AgentRunCheckpointStore } from '@oribos/checkpoints';

// ── The file-backed store: the deployment's half of the port ───────────────────────────────────

/**
 * This example's durable store: the whole record set in one human-readable JSON file, the four
 * port methods implemented over it. Production stores are SQL tables / Redis / object storage —
 * same contract, same JSON-only records; a file this trivial is enough to prove the seam
 * survives a process boundary.
 */
function createFileCheckpointStore(path: string): AgentRunCheckpointStore {
  const readAll = (): Record<string, AgentRunCheckpoint> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, AgentRunCheckpoint>;
    } catch {
      return {}; // no file yet = an empty store
    }
  };
  const writeAll = (all: Record<string, AgentRunCheckpoint>): void => {
    writeFileSync(path, JSON.stringify(all, null, 1));
  };
  return {
    save: async (runId, checkpoint) => {
      const all = readAll();
      all[runId] = checkpoint;
      writeAll(all);
    },
    load: async (runId) => readAll()[runId] ?? null,
    delete: async (runId) => {
      const all = readAll();
      delete all[runId];
      writeAll(all);
    },
    list: async () => Object.values(readAll()),
  };
}

// ── The tool: every execution appends a line to the shared log (the idempotency witness) ───────

/** The `note` tool's input schema — a hand-written Standard Schema dual interface, no libraries. */
const noteInputSchema: StandardSchema<{ value: string }> = {
  '~standard': {
    version: 1,
    vendor: '@oribos/example-crash-replay',
    validate: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'note input must be an object with a string `value`' }] };
      }
      const note = (value as Record<string, unknown>)['value'];
      return typeof note === 'string'
        ? { value: { value: note } }
        : { issues: [{ message: 'note input `value` must be a string', path: [{ key: 'value' }] }] };
    },
    jsonSchema: {
      input: () => ({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
      output: () => ({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
    },
  },
};

/** The `note` tool: one log line per execution, with the actor that executed it. */
function noteTool(logPath: string, actor: string): Tool {
  return {
    description: 'Appends one line to the run log.',
    inputSchema: noteInputSchema,
    execute: ({ value }) => {
      appendFileSync(logPath, `${JSON.stringify({ actor, value })}\n`);
      return { recorded: value };
    },
  };
}

/** The log's lines, in execution order (missing file = no executions yet). */
function readLog(logPath: string): { actor: string; value: string }[] {
  let raw = '';
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { actor: string; value: string });
}

/** Waits until the store holds nothing — the clear is bookkeeping that follows the run's settle. */
async function untilStoreEmpty(store: AgentRunCheckpointStore, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await store.list()).length > 0) {
    if (Date.now() > deadline) throw new Error('the checkpoint was never cleared');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── The scripted model: a paced-free offline stub that can die on command ───────────────────────

/** One scripted answer: text, an optional `note` call, and whether this call is the crash point. */
interface ScriptedStep {
  readonly text: string;
  readonly note?: string | undefined;
}

/** The worker's script: two tool steps, then the final answer (call 3 never completes). */
const WORKER_SCRIPT: readonly ScriptedStep[] = [
  { text: 'reading the log', note: 'started' },
  { text: 'writing more', note: 'working' },
  { text: 'all done' },
];

/** One scripted answer's stream parts (the vendor stream shape the core normalizes). */
function answerParts(step: ScriptedStep, callIndex: number): ModelStreamPart[] {
  const parts: ModelStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-0' },
    { type: 'text-delta', id: 'text-0', delta: step.text },
    { type: 'text-end', id: 'text-0' },
  ];
  if (step.note !== undefined) {
    const toolCallId = `call-${callIndex}`;
    parts.push(
      { type: 'tool-input-start', id: toolCallId, toolName: 'note' },
      { type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify({ value: step.note }) },
      { type: 'tool-input-end', id: toolCallId },
      // The vendor shape: the tool-call part carries the stringified input, the parsed one
      // follows from the core's normalizer.
      { type: 'tool-call', toolCallId, toolName: 'note', input: JSON.stringify({ value: step.note }) },
    );
  }
  parts.push({
    type: 'finish',
    finishReason: { unified: step.note === undefined ? 'stop' : 'tool-calls', raw: 'stop' },
    usage: {
      inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 3, text: undefined, reasoning: undefined },
    },
  });
  return parts;
}

/**
 * The scripted offline model: answers the steps in order; the `crashAtCall`-th call SIGKILLs the
 * process before producing anything — the crash point. `calls()` reports how many calls the
 * script was asked for, the re-send counter the example asserts on.
 */
function scriptedModel(
  steps: readonly ScriptedStep[],
  crashAtCall?: number,
): { model: Model; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      specificationVersion: 'v4',
      provider: 'example',
      modelId: 'crash-replay-stub',
      doGenerate: async () => {
        throw new Error('the example only streams');
      },
      doStream: async () => {
        calls += 1;
        if (calls === crashAtCall) {
          // The crash: the process vanishes here. SIGKILL cannot be caught or unwound — no
          // finally, no exit hook, exactly like a killed pod. The never-settling promise below
          // is belt and braces: if the signal were somehow delayed, the run would stall rather
          // than continue past the crash point.
          process.kill(process.pid, 'SIGKILL');
          return new Promise<never>(() => {});
        }
        const step = steps[calls - 1];
        if (step === undefined) {
          throw new Error(`scripted model exhausted: no step for call ${calls}`);
        }
        return {
          stream: new ReadableStream<ModelStreamPart>({
            start(controller) {
              for (const part of answerParts(step, calls)) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    },
  };
}

// ── Act 1's process: the worker that dies ──────────────────────────────────────────────────────

/** The crash process: runs the job, dies on the model's third call. Started by the parent below. */
async function runWorker(): Promise<void> {
  const storePath = process.env['CRASH_REPLAY_STORE'] ?? '';
  const logPath = process.env['CRASH_REPLAY_LOG'] ?? '';
  const { model } = scriptedModel(WORKER_SCRIPT, /* crashAtCall */ 3);
  const cp = createCheckpointedAgent({
    agent: new Agent({
      name: 'crash-worker',
      instructions: 'You work through the job step by step.',
      model,
      tools: { note: noteTool(logPath, 'worker') },
    }),
    storage: createFileCheckpointStore(storePath),
  });

  // An interval keeps the event loop alive until the crash lands; reading a terminal starts the
  // run (same lazy output object as `agent.stream`).
  setInterval(() => undefined, 1000);
  void cp.stream('work the job').text.catch(() => undefined);
}

// ── The parent: crash, boot, sweep, assert ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const storePath = join(tmpdir(), `oribos-crash-replay-store-${process.pid}.json`);
  const logPath = join(tmpdir(), `oribos-crash-replay-log-${process.pid}.jsonl`);

  // Act 1: a process really dies mid-run.
  const worker = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), 'worker'],
    {
      env: { ...process.env, CRASH_REPLAY_STORE: storePath, CRASH_REPLAY_LOG: logPath },
      stdio: 'inherit',
    },
  );
  const death = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      worker.on('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(death.signal, 'SIGKILL', `the worker died mid-run (got ${JSON.stringify(death)})`);

  // The scene: the store holds the in-flight run's last checkpoint — the only survivor.
  const store = createFileCheckpointStore(storePath);
  const crashed = await store.list();
  assert.equal(crashed.length, 1, 'one crashed run left in the store');
  const residue = crashed[0]!;
  assert.equal(residue.stepCount, 1, "the residue is step 1's boundary (step 2 was in flight)");
  assert.equal(residue.toolCalls.length, 1);
  assert.deepEqual(
    readLog(logPath).map((line) => `${line.actor}:${line.value}`),
    ['worker:started', 'worker:working'],
    'the dead process completed both tool steps',
  );

  // Act 2: boot — a new process (this one) attaches the same store and sweeps it.
  const boot = scriptedModel([{ text: 'all done' }]);
  const cp = createCheckpointedAgent({
    agent: new Agent({
      name: 'boot',
      instructions: 'You finish the job.',
      model: boot.model,
      tools: { note: noteTool(logPath, 'boot') },
    }),
    storage: store,
  });
  const results = await cp.recoverAll();

  assert.equal(results.length, 1);
  const result = results[0]!;
  if (result.ok !== true) throw new Error(`recovery failed: ${String(result.error)}`);
  assert.equal(result.outcome.runId, residue.runId);
  assert.equal(result.outcome.finishReason, 'stop');
  assert.equal(result.outcome.text, 'all done');
  // The re-send count: step 0 and step 1 were never re-asked; step 2's killed call is the one
  // model call recovery repeats — the script above holds exactly one answer, so any extra ask
  // would have exhausted it.
  assert.equal(boot.calls(), 1, 'recovery re-sent exactly the one in-flight model call');

  // The idempotency cost, explicit: the residue's tool ran again in the boot process.
  assert.deepEqual(
    readLog(logPath).map((line) => `${line.actor}:${line.value}`),
    ['worker:started', 'worker:working', 'boot:working'],
    'the last checkpointed step\'s tool executed once more (idempotency is the application\'s)',
  );

  // Act 3: the recovered run settled and consumed its checkpoint; a second sweep is a no-op.
  await untilStoreEmpty(store);
  assert.deepEqual(await cp.recoverAll(), [], 'a second sweep finds nothing');

  console.log('crash-replay example: all three acts passed');
  console.log(`  crashed run:   ${residue.runId}`);
  console.log(`  replayed from: step ${residue.stepCount} (${residue.toolCalls.map((call) => call.toolName).join(', ')})`);
  console.log('  model calls:   worker 2 completed + 1 killed; boot 1 (the killed call, re-sent)');
  console.log(
    `  tool log:      ${readLog(logPath)
      .map((line) => `[${line.actor}] ${line.value}`)
      .join(' → ')}`,
  );
  rmSync(storePath, { force: true });
  rmSync(logPath, { force: true });
}

if (process.argv[2] === 'worker') {
  runWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
