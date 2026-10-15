/**
 * Oribos distributed-signals example — two real Node processes, one thread, signals routed
 * across the process boundary.
 *
 * The processes share nothing but an IPC relay that implements the package's two ports (see
 * `ipc-transport.ts` — the deployment's half of the seam; production swaps it for Redis). The
 * parent (process A) hosts the thread; the child (process B) only sends.
 *
 * The acts:
 *
 * 1. **Cross-instance inject.** A streams a run on thread `support` and parks it in a gated
 *    tool. B `sendSignal`s across: the envelope lands on A, whose run is live — the signal is
 *    injected into the run's next step (the prompt tail of the model's second call, persisted
 *    as an ordinary message on the way). B's own model never runs: one publish, one injector.
 * 2. **Idle wake.** A's run settles and its lease is released. B sends again: A hears it idle,
 *    wins the lease race, and wakes a new run — the signal is that run's input (the model's
 *    third call). B stays at zero model calls: exactly one instance woke.
 *
 * The script self-asserts (`node:assert/strict`): a missed injection, a second wake, or any
 * model call on B exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-distributed-signals start
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Model, ModelPrompt, ModelStreamPart } from '@oribos/core/model';
import { Agent } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { createSignals } from '@oribos/core/signals';
import { createTool } from '@oribos/core/tools';
import { createDistributedSignals } from '@oribos/distributed-signals';
import { createIpcHub } from './ipc-transport.ts';

const TARGET = { thread: 'support', resource: 'acme' } as const;
const INSTRUCTIONS = 'You are concise.';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: (value: void) => void } {
  let resolve!: (value: void) => void;
  const promise = new Promise<void>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

/** The scripted offline model: answers in order, records every prompt for the assertions. */
function scriptedModel(steps: readonly string[]): {
  model: Model;
  calls(): number;
  prompts(): readonly ModelPrompt[];
} {
  let callCount = 0;
  const recorded: ModelPrompt[] = [];
  return {
    calls: () => callCount,
    prompts: () => recorded,
    model: {
      specificationVersion: 'v4',
      provider: 'example',
      modelId: 'distributed-signals-stub',
      doGenerate: async () => {
        throw new Error('the example only streams');
      },
      doStream: async (options) => {
        callCount += 1;
        recorded.push(options.prompt);
        const text = steps[callCount - 1];
        if (text === undefined) {
          throw new Error(`scripted model exhausted: no step for call ${String(callCount)}`);
        }
        return {
          stream: new ReadableStream<ModelStreamPart>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'text-0' });
              controller.enqueue({ type: 'text-delta', id: 'text-0', delta: text });
              controller.enqueue({ type: 'text-end', id: 'text-0' });
  // Call 1 asks for the `wait` tool; call 3 (the wake run) does too — see `activeGate`.
  if (callCount === 1 || callCount === 3) {
                controller.enqueue({ type: 'tool-input-start', id: `call-${String(callCount)}`, toolName: 'wait' });
                controller.enqueue({ type: 'tool-input-delta', id: `call-${String(callCount)}`, delta: '{}' });
                controller.enqueue({ type: 'tool-input-end', id: `call-${String(callCount)}` });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: `call-${String(callCount)}`,
                  toolName: 'wait',
                  input: '{}',
                });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: callCount === 1 || callCount === 3 ? 'tool-calls' : 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 3, text: undefined, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        };
      },
    },
  };
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await sleep(10);
  }
}

/** The text of a prompt's last message (the assertion surface for injections). */
function lastPromptText(prompt: ModelPrompt): string | undefined {
  const last = prompt.at(-1);
  if (last === undefined) return undefined;
  const part = last.content.at(-1);
  if (part === undefined) return undefined;
  if (typeof part === 'string') return part;
  return part.type === 'text' ? part.text : undefined;
}

async function main(): Promise<void> {
  const child = fork(fileURLToPath(new URL('./child.ts', import.meta.url)));
  const hub = createIpcHub({ send: (message) => child.send(message) });
  let childReady = false;
  child.on('message', (message) => {
    if (message !== null && typeof message === 'object' && (message as { t?: string }).t === 'ready') {
      childReady = true;
    }
    hub.onChildMessage(message);
  });
  await waitFor('the child to boot', () => childReady);

  const model = scriptedModel(['Working.', 'Saw the signal.', 'Woken by the signal.', 'Done.']);
  const memory = new Memory();
  const gate1 = deferred();
  const gate2 = deferred();
  // The gate the `wait` tool hands back: act N's run parks there until its assertions are done —
  // while the run is parked the lease is held, so the child's own echo of every send converges
  // (acquire fails) instead of racing an already-settled thread.
  let activeGate: Promise<void> = gate1.promise;
  const agent = new Agent({
    name: 'support',
    instructions: INSTRUCTIONS,
    model: model.model,
    memory,
    tools: { wait: createTool({ description: 'Waits for the gate.', execute: () => activeGate }) },
  });
  const distributed = createDistributedSignals({
    signals: createSignals({ agent, memory }),
    pubsub: hub.ports,
    lease: hub.ports,
  });

  // ── Act 1: cross-instance inject ──────────────────────────────────────────────────────────────
  const run = distributed.stream('Start.', { memory: { ...TARGET } });
  void run.text;
  await waitFor('the first model call', () => model.calls() === 1);
  console.log('act 1: A holds thread `support` (model call 1, parked in the gated tool)');

  child.send({ t: 'send-signal', payload: { type: 'nudge', n: 1 } });
  // The injection persists the signal as an ordinary message before the next step — the real
  // observable that the envelope crossed, independent of run pacing.
  await waitFor(
    'the signal to land in A’s history',
    async () =>
      (await memory.recall({ threadId: TARGET.thread })).some((message) =>
        JSON.stringify(message.content).includes('nudge'),
      ),
  );
  gate1.resolve();
  await run.text;
  assert.equal(
    lastPromptText(model.prompts()[1]!),
    '[signal] {"type":"nudge","n":1}',
    'act 1: the cross-instance signal is injected into the live run’s next step',
  );
  console.log('act 1: B’s sendSignal injected into A’s live run (model call 2 prompt tail)');

  // ── Act 2: idle wake ──────────────────────────────────────────────────────────────────────────
  // The wake run parks on its own gate too: the child's echo must find the lease held (and drop)
  // rather than racing an already-settled thread.
  activeGate = gate2.promise;
  child.send({ t: 'send-signal', payload: { type: 'wake', n: 2 } });
  await waitFor('the wake run', () => model.calls() === 3);
  assert.equal(
    lastPromptText(model.prompts()[2]!),
    '[signal] {"type":"wake","n":2}',
    'act 2: the signal wakes A’s idle thread — it is the new run’s input',
  );
  console.log('act 2: B’s second sendSignal woke A’s idle thread (model call 3 = the wake run)');
  gate2.resolve();
  await waitFor('the wake run to settle', () => model.calls() === 4);

  child.send({ t: 'done' });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, 'the child exits clean, having made zero model calls');
  console.log('child: zero model calls — exactly one instance ever held or woke the thread');
  console.log('all acts green.');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
