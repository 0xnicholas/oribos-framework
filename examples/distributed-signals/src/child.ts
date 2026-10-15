/**
 * The child process (B): it never hosts the thread — it only sends across the IPC transport and
 * stays at zero model calls. Its final assertion is the example's whole point: two sends, one
 * injection, one wake, none of them here.
 */
import assert from 'node:assert/strict';
import type { Model } from '@oribos/core/model';
import { Agent } from '@oribos/core/agent';
import { createSignals } from '@oribos/core/signals';
import { createDistributedSignals } from '@oribos/distributed-signals';
import { createIpcPorts } from './ipc-transport.ts';

const TARGET = { thread: 'support', resource: 'acme' } as const;

/** A model that must never be asked for anything. */
function silentModel(): Model {
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'distributed-signals-child',
    doGenerate: async () => {
      throw new Error('the child must never generate');
    },
    doStream: async () => {
      throw new Error('the child must never stream');
    },
  };
}

export async function childEntry(): Promise<void> {
  const ports = createIpcPorts();
  process.on('message', (message) => ports.onMessage(message));

  let calls = 0;
  const model: Model = {
    ...silentModel(),
    doStream: async (options) => {
      calls += 1;
      void options;
      throw new Error('the child must never stream');
    },
  };

  const agent = new Agent({ name: 'sender', instructions: 'You never run.', model });
  const distributed = createDistributedSignals({
    signals: createSignals({ agent }),
    pubsub: ports.pubsub,
    lease: ports.lease,
  });
  process.send?.({ t: 'ready' });

  await new Promise<void>((resolve) => {
    process.on('message', (message: { t?: string; payload?: Record<string, unknown> }) => {
      if (message !== null && typeof message === 'object' && message.t === 'send-signal') {
        const payload = message.payload ?? {};
        void distributed.sendSignal(
          { ...TARGET },
          { type: typeof payload['type'] === 'string' ? payload['type'] : 'signal', ...payload },
        );
      }
      if (message !== null && typeof message === 'object' && message.t === 'done') {
        resolve();
      }
    });
  });

  assert.equal(calls, 0, 'the child never runs a model call — it only sends');
  process.exit(0);
}

childEntry().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
