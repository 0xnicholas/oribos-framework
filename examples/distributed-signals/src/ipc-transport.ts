/**
 * The IPC transport both processes share: the deployment's half of the two ports.
 *
 * One hub topology — the parent process arbitrates: its [`IpcHub`] implements [`SignalPubSub`]
 * and [`SignalLease`] directly (fan-out to parent handlers plus a forward to the child; leases
 * delegated to the package's own in-memory store), while the child implements the same two ports
 * as RPCs over `process.send` / `process.on('message')`. Every publish reaches every subscriber
 * on both sides — the broadcast redundancy the package's lease is there to converge. Production
 * deployments swap this file for Redis; the ports are the whole seam.
 */
import type { SignalLease, LeaseHandle, SignalPubSub } from '@oribos/distributed-signals';
import { createInMemoryLeaseStore } from '@oribos/distributed-signals';

/** The wire messages between the processes. */
type IpcMessage =
  | { readonly t: 'pub'; readonly topic: string; readonly payload: string }
  | { readonly t: 'acquire'; readonly rid: number; readonly key: string; readonly ttl: number }
  | { readonly t: 'renew'; readonly rid: number; readonly key: string; readonly token: string; readonly ttl: number }
  | { readonly t: 'release'; readonly key: string; readonly token: string }
  | { readonly t: 'acquired'; readonly rid: number; readonly token: string | null }
  | { readonly t: 'renewed'; readonly rid: number; readonly ok: boolean }
  | { readonly t: 'send-signal'; readonly payload: Record<string, unknown> }
  | { readonly t: 'ready' }
  | { readonly t: 'done' };

function isIpcMessage(value: unknown): value is IpcMessage {
  return typeof value === 'object' && value !== null && 't' in value;
}

/** The child's process handle the hub talks to (the subset of `ChildProcess` the hub needs). */
export interface IpcPeer {
  send(message: IpcMessage): void;
}

/**
 * The parent's ports plus the pump for the child's messages: pubsub fan-out (parent handlers +
 * forward to the child) and lease arbitration (the package's in-memory store, holding the
 * child-held lease handles by token so renew/release route back to them).
 */
export function createIpcHub(peer: IpcPeer): {
  ports: SignalPubSub & SignalLease;
  onChildMessage(message: unknown): void;
} {
  const subscriptions: { topics: readonly string[]; handler: (topic: string, payload: string) => void }[] = [];
  const childLeases = new Map<string, LeaseHandle>();
  const leases = createInMemoryLeaseStore();

  function deliver(topic: string, payload: string): void {
    for (const subscription of [...subscriptions]) {
      if (subscription.topics.includes(topic)) subscription.handler(topic, payload);
    }
    peer.send({ t: 'pub', topic, payload });
  }

  return {
    ports: {
      publish: async (topic, payload) => {
        deliver(topic, payload);
      },
      subscribe: async (topics, handler) => {
        const topicList = typeof topics === 'string' ? [topics] : [...topics];
        subscriptions.push({ topics: topicList, handler });
        return async () => {
          const index = subscriptions.findIndex((entry) => entry.handler === handler);
          if (index >= 0) subscriptions.splice(index, 1);
        };
      },
      acquire: leases.acquire,
    },
    onChildMessage: (message) => {
      if (!isIpcMessage(message)) return;
      if (message.t === 'pub') {
        deliver(message.topic, message.payload);
        return;
      }
      if (message.t === 'acquire') {
        void leases.acquire(message.key, message.ttl).then((handle) => {
          if (handle !== null) childLeases.set(handle.token, handle);
          peer.send({ t: 'acquired', rid: message.rid, token: handle?.token ?? null });
        });
        return;
      }
      if (message.t === 'renew') {
        void childLeases.get(message.token)?.renew(message.ttl).then((ok) => {
          peer.send({ t: 'renewed', rid: message.rid, ok });
        });
        return;
      }
      if (message.t === 'release') {
        void childLeases.get(message.token)?.release().then(() => {
          childLeases.delete(message.token);
        });
      }
    },
  };
}

// ── Child side: the RPC ports ───────────────────────────────────────────────────────────────────

/**
 * The child's ports: pubsub delivery arrives as messages, lease calls are request/reply RPCs.
 * The handlers registry and the pending-RPC map are the child's whole state.
 */
export function createIpcPorts(): {
  pubsub: SignalPubSub;
  lease: SignalLease;
  onMessage(message: unknown): void;
} {
  const subscriptions: { topics: readonly string[]; handler: (topic: string, payload: string) => void }[] = [];
  const pending = new Map<number, (message: IpcMessage) => void>();
  let nextRid = 1;

  function rpc(message: { t: 'acquire'; key: string; ttl: number }): Promise<IpcMessage> {
    const rid = nextRid++;
    return new Promise((resolve) => {
      pending.set(rid, resolve);
      process.send?.({ ...message, rid });
    });
  }

  return {
    pubsub: {
      publish: async (topic, payload) => {
        process.send?.({ t: 'pub', topic, payload });
      },
      subscribe: async (topics, handler) => {
        const topicList = typeof topics === 'string' ? [topics] : [...topics];
        subscriptions.push({ topics: topicList, handler });
        return async () => {
          const index = subscriptions.findIndex((entry) => entry.handler === handler);
          if (index >= 0) subscriptions.splice(index, 1);
        };
      },
    },
    lease: {
      acquire: async (key, ttlMs) => {
        const reply = await rpc({ t: 'acquire', key, ttl: ttlMs });
        if (reply.t !== 'acquired' || reply.token === null) return null;
        const token = reply.token;
        return {
          token,
          renew: async (renewTtl) => {
            const rid = nextRid++;
            const renewed = await new Promise<IpcMessage>((resolve) => {
              pending.set(rid, resolve);
              process.send?.({ t: 'renew', rid, key, token, ttl: renewTtl });
            });
            return renewed.t === 'renewed' && renewed.ok;
          },
          release: async () => {
            process.send?.({ t: 'release', key, token });
          },
        };
      },
    },
    onMessage: (message) => {
      if (!isIpcMessage(message)) return;
      if (message.t === 'pub') {
        for (const subscription of [...subscriptions]) {
          if (subscription.topics.includes(message.topic)) {
            subscription.handler(message.topic, message.payload);
          }
        }
        return;
      }
      if ('rid' in message && typeof message.rid === 'number') {
        pending.get(message.rid)?.(message);
        pending.delete(message.rid);
      }
    },
  };
}
