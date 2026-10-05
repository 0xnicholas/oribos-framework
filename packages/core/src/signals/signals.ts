import type { Agent } from '../agent/agent.js';
import { passThrough } from '../agent/boundary.js';
import { toUserTextMessages } from '../agent/input.js';
import type {
  AgentGenerateResult,
  AgentMemoryOptions,
  AgentRunOptions,
  AgentStepBoundary,
  AgentStepBoundaryEvent,
  AgentStreamResult,
  StructuredOutputConfig,
} from '../agent/types.js';
import type { Chunk } from '../model/chunks.js';
import type { ModelMessage } from '../model/contract.js';
import { assertMemoryTarget, resolveThreadId } from '../memory/identity.js';
import type { Memory } from '../memory/index.js';
import type { Tracer } from '../observability/index.js';
import { normalizeTraceContinuation } from '../observability/span.js';
import { materialize, teeOutputObject } from '../output-object.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';

/**
 * The signals subsystem: the thread-directed interaction primitive — inject into the active run,
 * wake an idle thread, queue in order — over an in-process registry of thread → active run and an
 * in-memory pubsub for chunk subscribers.
 *
 * Three fixed rules (verbatim from the spec): on an active thread a message is injected into the
 * current run, taking effect at the next step; on an idle thread it wakes a new run; and
 * `queueMessage` queues it in arrival order. Those rules act on the runs started through this
 * wrapper
 * (`stream` / `generate` with a per-call `memory` identity) and on the runs the wrapper starts
 * itself (wakes, continuations); a bare `agent.stream(...)` call knows nothing about signals.
 *
 * Single-process semantics: the registry and the queues live in this object, so the process dying
 * drops every queued message (documented; cross-instance PubSub + leases are a capability package,
 * out of spec). The injection seam is the agent loop's step boundary (`AgentRunOptions.stepBoundary`
 * — the seam of M4 #56): a run without signals wiring consults nothing, copies nothing.
 */

/** The `createSignals` config. */
export interface SignalsConfig {
  /** The agent whose runs signals act on. */
  readonly agent: Agent;
  /**
   * The memory instance injected/woken content lands in, as ordinary messages of message history
   * (reusing `MemoryStore`, no new storage). Must be the same instance the agent is configured with
   * (`AgentConfig.memory`): woken runs carry their thread identity as the per-call `memory`
   * option, which an agent without a configured memory rejects. Absent = waking starts a new run
   * with no history at all (documented: nothing is persisted, nothing is recalled) and injections
   * ride the active run's prompt without landing anywhere.
   */
  readonly memory?: Memory | undefined;
  /**
   * The tracer injection events report to (the composition root distributes it). Present = each
   * injection lands as one `isEvent` span on the active run's `agent-run` span — hung through the
   * boundary event's `traceId` / `spanId` continuation, no loop change. A woken run's own
   * `agent-run` span comes from the agent itself (`AgentConfig.tracer`). Absent = no span object
   * is ever created here.
   */
  readonly tracer?: Tracer | undefined;
}

/**
 * A signal payload: an open `type` plus whatever fields the sender's protocol carries. Rendered
 * into the conversation (and message history) as one user text message —
 * `[signal] ${JSON.stringify(payload)}` — deterministic, and lossless for JSON-serializable values.
 */
export interface SignalPayload {
  /** What kind of signal this is; an open vocabulary, the receiver's contract. */
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The signals entry object: the agent's run surface wrapped, plus the four signal methods. */
export interface Signals {
  /**
   * Runs the agent once, exactly as `agent.stream` does, with the thread registered while the run
   * is live: messages sent to the run's thread inject here, `subscribeToThread` listeners receive
   * this run's chunks. The per-call `memory` identity is what registers the run — a call without
   * one passes through to the agent untouched, with no registration. A run on a thread that
   * already has a live run is rejected: one active run per thread is what the three sentences
   * presuppose (`queueMessage` waits instead).
   *
   * Registration is eager — the thread is claimed when `stream` is called — while the run itself
   * stays lazy like the bare agent's: the model call happens on first consumption.
   */
  stream<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): AgentStreamResult<StandardSchemaV1.InferOutput<TSchema>>;
  stream(input: string | ModelMessage[], options?: AgentRunOptions): AgentStreamResult;
  /** `stream()` awaited to its terminal values, exactly as `agent.generate`. */
  generate<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): Promise<AgentGenerateResult<StandardSchemaV1.InferOutput<TSchema>>>;
  generate(input: string | ModelMessage[], options?: AgentRunOptions): Promise<AgentGenerateResult>;
  /**
   * Sends a message to a thread — active = injected into the current run, idle = wakes a new run.
   * The content lands in message history as an ordinary message — saved here when injected (no run
   * would ever persist it), saved by the woken run itself when it wakes one. Resolves once the
   * message is delivered — persisted and buffered for injection, or the run started — never
   * awaits a woken run's completion.
   */
  sendMessage(target: AgentMemoryOptions, input: string | ModelMessage[]): Promise<void>;
  /**
   * Queues a message for a thread: it waits for the current run to end, then lands as the input
   * of one continuation run, in arrival order with everything queued before it. On an
   * idle thread it is simply a wake. The queue is process memory — the process dying drops it
   * (documented single-process semantics).
   */
  queueMessage(target: AgentMemoryOptions, input: string | ModelMessage[]): Promise<void>;
  /**
   * Sends a system signal (open `type`): same delivery as `sendMessage` — inject into the active
   * run, wake an idle thread — with the payload rendered as its message
   * (`[signal] ${JSON.stringify(payload)}`) instead of the caller's input.
   */
  sendSignal(target: AgentMemoryOptions, payload: SignalPayload): Promise<void>;
  /**
   * Subscribes to the chunks of the runs on a thread: every chunk of the thread's current and
   * future runs flows to the subscription until the consumer breaks out of the loop. No replay —
   * chunks emitted before subscribing never arrive. An unconsumed subscription buffers without
   * bound: consume it, or leave the loop.
   */
  subscribeToThread(target: AgentMemoryOptions): AsyncIterable<Chunk>;
}

/**
 * One thread's signals state. Present in the registry only while a run is live (or reserved for
 * the continuation about to start), a message is queued, or a subscriber listens — a fully idle,
 * unsubscribed thread drops out.
 */
interface ThreadState {
  /** The thread's registry key. */
  readonly threadId: string;
  /** A run is live on this thread — or reserved: the continuation run is starting. */
  running: boolean;
  /** The identity the live run runs under; set before `running`, read by the continuation. */
  target: AgentMemoryOptions | undefined;
  /** Messages buffered for injection, drained into the run's next model call. */
  readonly pending: ModelMessage[];
  /** Messages queued for the continuation run, in arrival order. */
  readonly queue: ModelMessage[];
  /** Live chunk subscribers of the thread. */
  readonly subscribers: Set<Subscriber>;
}

/** One live subscription's push end (the pull end is its async iterator). */
interface Subscriber {
  push(chunk: Chunk): void;
}

const DONE: IteratorResult<Chunk> = { value: undefined, done: true };

/** The fix hint the signals subsystem's memory identity errors carry (memory/identity.ts template). */
const TARGET_HINT = 'pass { thread, resource } with both fields.';

/**
 * Creates the signals entry object. See `Signals` for the per-method semantics.
 */
export function createSignals(config: SignalsConfig): Signals {
  const { agent, memory, tracer } = config;
  if (memory !== undefined && agent.memory === undefined) {
    throw new Error(
      'createSignals: memory requires the agent to be configured with the same instance ' +
        '(AgentConfig.memory) — woken runs carry their thread identity as the per-call memory ' +
        'option, which an agent without a configured memory rejects.',
    );
  }
  /** thread id → live state (see `ThreadState` for when an entry exists). */
  const threads = new Map<string, ThreadState>();

  function stateOf(threadId: string): ThreadState {
    let state = threads.get(threadId);
    if (state === undefined) {
      state = { threadId, running: false, target: undefined, pending: [], queue: [], subscribers: new Set() };
      threads.set(threadId, state);
    }
    return state;
  }

  /** The run surface: registers the thread (or passes through when no identity is given). */
  function streamWrapped(
    input: string | ModelMessage[],
    options: AgentRunOptions | undefined,
  ): AgentStreamResult {
    const target = options?.memory;
    if (target === undefined) return agent.stream(input, options);
    const state = stateOf(resolveThreadId('signals', target.thread, TARGET_HINT));
    if (state.running) {
      throw new Error(
        `signals: thread '${state.threadId}' already has a live run — one active run per thread is ` +
          'what the signals semantics presuppose; await the current run, or queueMessage to wait for it.',
      );
    }
    state.running = true;
    state.target = target;
    // The user's own options ride through as given — the per-call memory identity included (it
    // is the target that registered the run); only the boundary is taken over (composed).
    return startRun(state, target, input, options);
  }

  /**
   * Starts one wrapped run: the boundary wires the injector into the loop's step seam (composing
   * whatever boundary the caller passed — their `beforeNextStep` results ride after the injected
   * messages, their `beforeToolCalls` gate is consulted untouched), and the chunk stream fans out
   * to the thread's subscribers on its way to the caller. Lazy like the agent's own output object
   * — nothing runs until first consumption — but the thread was already claimed by the caller
   * (`streamWrapped`) or by the wake. The caller's options ride through as given: a user run
   * carries its own `memory` identity, a woken run the one built by `driveRun`.
   */
  function startRun(
    state: ThreadState,
    target: AgentMemoryOptions,
    input: string | ModelMessage[],
    options: AgentRunOptions | undefined,
  ): AgentStreamResult {
    const userBoundary = options?.stepBoundary;
    const boundary: AgentStepBoundary = {
      async beforeNextStep(event: AgentStepBoundaryEvent) {
        const injected = drainPending(state, target, event);
        const theirs = await userBoundary?.beforeNextStep?.(event);
        return [...injected, ...(theirs ?? [])];
      },
      ...passThrough('beforeToolCalls', userBoundary?.beforeToolCalls),
    };
    const inner = agent.stream(input, { ...options, stepBoundary: boundary });
    return teeOutputObject<Chunk, AgentGenerateResult>(inner, {
      // Every chunk fans out to the thread's subscribers on its way to the caller.
      onChunk: (chunk) => {
        for (const subscriber of state.subscribers) subscriber.push(chunk);
      },
      // The run's end releases the thread (and fires a queued continuation) before the caller can
      // observe it settled — on success and on failure alike (the tee's completion chain).
      beforeSettle: () => {
        settleRun(state);
      },
    });
  }

  /**
   * Drains the thread's injection buffer at a step boundary: the buffered messages become the
   * tail of the run's next model call (injected into the run, effective next step). An injection
   * landing with a tracer attached and a traced run hangs as one `isEvent` span off the live
   * `agent-run` span — the boundary event's continuation ids, the observability anchor.
   */
  function drainPending(
    state: ThreadState,
    target: AgentMemoryOptions,
    event: AgentStepBoundaryEvent,
  ): ModelMessage[] {
    const injected = state.pending.splice(0);
    if (injected.length === 0 || tracer === undefined) return injected;
    // The boundary event's ids carry the `''` = "no trace" encoding — read through the
    // convention's one home; only a pair surviving normalization whole has a live run span to
    // hang the event span off.
    const continuation = normalizeTraceContinuation(event.traceId, event.spanId);
    if (continuation.traceId !== undefined && continuation.parentSpanId !== undefined) {
      tracer.startSpan({
        name: 'signal',
        // An open span-type literal, deliberately not one of the framework's seven constants
        // (the anchor: no new span-type constant — `SpanType` is an open string by design).
        type: 'signal',
        isEvent: true,
        traceId: continuation.traceId,
        parentSpanId: continuation.parentSpanId,
        input: injected,
        attributes: { threadId: state.threadId, resource: target.resource },
      });
    }
    return injected;
  }

  /**
   * Ends one run's hold on its thread. A message still in the injection buffer (a `sendMessage`
   * whose history save was in flight when the run ended) folds to the queue's front, so arrival
   * order holds. A non-empty queue reserves the thread again — synchronously, so no send in
   * between can see an idle thread — and its continuation run is driven to completion in the
   * background. An idle thread with no subscribers drops its state.
   */
  function settleRun(state: ThreadState): void {
    const queued = [...state.pending.splice(0), ...state.queue.splice(0)];
    // `target` is set whenever the queue can be non-empty (messages only queue while a run —
    // which always sets it — was live); the guard is for the type, not for a real case.
    const target = state.target;
    if (queued.length > 0 && target !== undefined) {
      state.running = true;
      void driveRun(state, target, queued);
      return;
    }
    state.running = false;
    if (state.subscribers.size === 0) threads.delete(state.threadId);
  }

  /**
   * Drives a woken (or continuation) run to completion: the wrapper itself consumes the output
   * object, so the run starts without an external consumer, its chunks fan out to the thread's
   * subscribers, and its `settleRun` fires the next continuation when it ends. With `memory` the
   * run carries its thread identity and so recalls and saves history itself; without it the run
   * is history-free (documented) — the per-call option is dropped, not forwarded, because an
   * agent without a configured memory rejects it. A woken run's failure never reaches its sender
   * — it is visible on the run's own `agent-run` span (tracer) and in the subscriber stream up
   * to the failure — and the queue still drains after it.
   */
  async function driveRun(
    state: ThreadState,
    target: AgentMemoryOptions,
    input: readonly ModelMessage[],
  ): Promise<void> {
    try {
      const options: AgentRunOptions = memory === undefined ? {} : { memory: target };
      const output = startRun(state, target, [...input], options);
      const iterator = output[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
      }
    } catch {
      // Documented above: swallowed on purpose, the run's trace carries it.
    }
  }

  /**
   * Delivers a message (or rendered signal): active = injected into the current run, idle = wakes
   * a new run. The inject path buffers first — the message is committed to the run, and a run
   * ending while the history save is still in flight folds the buffer into its continuation
   * (`settleRun`) — then persists it as an ordinary message (no run would ever save an injected
   * message; a woken run saves its
   * own input with its first step, so the wake path does not double-save).
   */
  async function deliver(target: AgentMemoryOptions, messages: readonly ModelMessage[]): Promise<void> {
    const { threadId, valid } = toTarget(target);
    const state = threads.get(threadId);
    if (state !== undefined && state.running) {
      state.pending.push(...messages);
      if (memory !== undefined) {
        await memory.save({ thread: valid.thread, resource: valid.resource, messages: [...messages] });
      }
      return;
    }
    wake(valid, threadId, [...messages]);
  }

  /**
   * Queues a message: on a live thread it joins the continuation queue (in arrival order);
   * on an idle thread it is simply a wake.
   */
  function queue(target: AgentMemoryOptions, messages: readonly ModelMessage[]): Promise<void> {
    const { threadId, valid } = toTarget(target);
    const state = threads.get(threadId);
    if (state !== undefined && state.running) {
      state.queue.push(...messages);
      return Promise.resolve();
    }
    wake(valid, threadId, [...messages]);
    return Promise.resolve();
  }

  /**
   * Wakes an idle thread: the state is reserved synchronously (the single-active-run invariant —
   * no send between the reservation and the run's start can see an idle thread), then the run is
   * driven in the background. With `memory` the run carries its thread identity and so recalls
   * and saves history itself; without it the run is history-free (documented).
   */
  function wake(valid: AgentMemoryOptions, threadId: string, messages: readonly ModelMessage[]): void {
    const state = stateOf(threadId);
    state.running = true;
    state.target = valid;
    void driveRun(state, valid, messages);
  }

  /** Subscribes to the thread's run chunks (see `Signals.subscribeToThread`). */
  function subscribe(target: AgentMemoryOptions): AsyncIterable<Chunk> {
    const { threadId } = toTarget(target);
    const state = stateOf(threadId);
    const buffered: Chunk[] = [];
    let closed = false;
    let notify: (() => void) | undefined;
    const subscriber: Subscriber = {
      push(chunk: Chunk): void {
        if (closed) return;
        buffered.push(chunk);
        notify?.();
      },
    };
    state.subscribers.add(subscriber);
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<Chunk>> {
          while (buffered.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
          const chunk = buffered.shift();
          return chunk === undefined ? DONE : { value: chunk, done: false };
        },
        /** Leaving the loop is the unsubscribe: the subscriber detaches and the iterator ends. */
        return(): Promise<IteratorResult<Chunk>> {
          closed = true;
          state.subscribers.delete(subscriber);
          notify?.();
          return Promise.resolve(DONE);
        },
      }),
    };
  }

  return {
    stream: streamWrapped,
    async generate(
      input: string | ModelMessage[],
      options?: AgentRunOptions,
    ): Promise<AgentGenerateResult> {
      return materialize<AgentGenerateResult>(streamWrapped(input, options));
    },
    sendMessage: (target, input) => deliver(target, toUserTextMessages(input)),
    queueMessage: (target, input) => queue(target, toUserTextMessages(input)),
    sendSignal: (target, payload) => deliver(target, [toSignalMessage(payload)]),
    subscribeToThread: subscribe,
  };
}

/**
 * Validates a target identity and returns its registry key plus the identity itself — the memory
 * identity rule's one home is `memory/identity.ts`: a target missing either field fails before
 * anything is delivered.
 */
function toTarget(target: AgentMemoryOptions): { threadId: string; valid: AgentMemoryOptions } {
  const threadId = assertMemoryTarget('signals', target, TARGET_HINT);
  return { threadId, valid: target };
}

/** Renders a signal payload as its conversation message (`SignalPayload` for the exact recipe). */
function toSignalMessage(payload: SignalPayload): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `[signal] ${JSON.stringify(payload)}` }],
  };
}
