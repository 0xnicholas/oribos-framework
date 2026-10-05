import type {
  Chunk,
  FinishReason,
  ToolCallChunk,
  ToolResultChunk,
  Usage,
} from '../model/chunks.js';
import type { Model, ModelCallOptions, ModelMessage, ModelProviderOptions } from '../model/contract.js';
import type { Memory, MemoryThreadRef } from '../memory/index.js';
import type { Tracer } from '../observability/index.js';
import type { StandardSchema } from '../standard-schema.js';
import type { Tool } from '../tools/index.js';
import type { Processor } from './processors.js';

/**
 * The Agent surface: the five definition fields — `name`,
 * `instructions`, `model`, optional `tools`, optional `description` — plus the optional `memory`
 * subsystem (a first-class optional field of the same surface), and
 * the `tracer` / `processors` seams. Nothing beyond them.
 *
 * `tracer` is not a sixth definition field: it is the observability injection seam — a
 * cross-cutting dependency the composition root hands to the subsystem (`createApp({ tracer })`),
 * which a standalone `new` may also pass
 * explicitly. Not attaching it leaves the whole observability subsystem at zero overhead.
 *
 * Every config field accepts a static value or a resolver (`DynamicArgument`), resolved again for
 * each run. Widening a field is additive.
 */
export interface AgentConfig {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions for every run — a plain string (no message-union passthrough). */
  readonly instructions: DynamicArgument<string>;
  /**
   * The language model(s) to run — an instance, an array of instances forming a fallback chain
   * (`ModelInput`), or a resolver that picks either per request context. Any AI SDK provider
   * package instance satisfies the contract structurally; a wrong specification version fails
   * loudly when the field is resolved (at construction for a static value, at resolution time for
   * a resolver's pick).
   */
  readonly model: ModelInput;
  /** Tool container — the Record key is the tool name. Static, or resolved per request context. */
  readonly tools?: DynamicArgument<Record<string, Tool>>;
  /** Shown to an upstream model when the agent is composed as a tool (`resolveDynamicArgument`). */
  readonly description?: DynamicArgument<string>;
  /**
   * The memory subsystem instance this agent's runs read and write through (the configuration
   * surface): message history lands in the thread/resource named by the per-call `memory`
   * option — recalled once per run before `processInput`, saved once per step after
   * `processOutputStep`. A run that passes no per-call `memory` performs no memory I/O, so a
   * memory-configured agent keeps stateless runs available; the same instance may be shared by
   * several agents.
   */
  readonly memory?: DynamicArgument<Memory>;
  /**
   * The tracer this agent reports to, when one is attached (the composition root distributes it;
   * a standalone `new` may pass it explicitly). Absent = no span is ever created for its runs.
   */
  readonly tracer?: Tracer | undefined;
  /**
   * The processors of this agent's runs — the cross-cutting extension point (ADR-0005). Guardrails,
   * evals, redaction and
   * rate limiting live here, never in Agent fields. Hooks run in declaration order, each seeing the
   * previous one's rewrite; absent = no processor runs.
   *
   * Not a definition field: like `tracer`, this is cross-cutting wiring the composition root (or an
   * explicit `new`) hands in — the attachment point of the extension point itself.
   */
  readonly processors?: readonly Processor[] | undefined;
}

/**
 * The model-call settings a run may forward: everything the provider spec's call options accept
 * except the fields the framework owns — `prompt` (built from instructions + input),
 * `abortSignal` (from the run's `signal`), `providerOptions` (its own run option), and
 * `tools` / `toolChoice` / `responseFormat` (owned by their features).
 */
export type ModelSettings = Omit<
  ModelCallOptions,
  'prompt' | 'abortSignal' | 'providerOptions' | 'tools' | 'toolChoice' | 'responseFormat'
>;

/**
 * The context of one run, resolved per call (the definition surface): the
 * framework writes `signal` and `runId`, everything else is the user's per-call open bag. A plain
 * object — no `Map` class, no generic context parameter.
 *
 * Dynamic argument resolution and tool `ctx.requestContext` both read the same object; the
 * framework-written fields come last, so a per-call property cannot hijack them.
 */
export interface RequestContext {
  /** Cancellation of this run — the per-call `signal`, or a never-aborting signal when none was passed. */
  readonly signal: AbortSignal;
  /** Identity of this run (generated per run). */
  readonly runId: string;
  /** User per-call properties, passed through untouched. */
  readonly [key: string]: unknown;
}

/**
 * The shape every Agent config field accepts (the definition surface): the value
 * itself, or a resolver that answers per request context — each run resolves its fields again, so a
 * per-call context changes behavior without rebuilding the agent.
 *
 * A `T` that is itself a function cannot be passed as a static value: function values are read as
 * resolvers. No config field has a function as its static value.
 */
export type DynamicArgument<T> = T | ((ctx: RequestContext) => T | Promise<T>);

/**
 * The `model` field's accepted shapes: a model
 * instance satisfying the contract, an array of instances forming a fallback chain, or a resolver
 * that picks either per request context.
 *
 * A chain is tried in array order on every model call (`agent/loop.ts`): the call moves on to the
 * next candidate only while the current one has produced no chunk yet. A failure mid-stream
 * propagates — partial output has already reached the caller, and switching would splice two
 * models' answers together. When every candidate failed, the run fails with the original error if
 * there was only one, or with `ModelFallbackError` carrying the whole chain.
 */
export type ModelInput = DynamicArgument<Model | readonly Model[]>;

/**
 * The framework-owned run option fields — execution controls, never request context. They live
 * behind this closed interface so `keyof` can enumerate them: carried directly on
 * `AgentRunOptions`, the open index signature would make `keyof` collapse to `string` and the
 * exhaustiveness assertion below unwritable. `toRequestContext` (`agent.ts`) derives its exclusion
 * list from `AGENT_RUN_OPTION_KEYS`, which the assertion keeps in lockstep with this interface —
 * a field added here without its key there fails the build, naming the key.
 *
 * @internal
 */
export interface AgentRunOptionFields {
  /** Passthrough bag for the model call (temperature, maxOutputTokens, …). */
  readonly modelSettings?: ModelSettings;
  /** Provider-specific options, forwarded to the model call untouched. */
  readonly providerOptions?: ModelProviderOptions;
  /** Cancels the run — propagated to the model call, the tool loop and every tool context. */
  readonly signal?: AbortSignal;
  /**
   * The step cap: how many model calls one run may make (the agent loop). When the cap is reached
   * while the model still asks for tools, the terminal `finishReason` is `'tool-calls'`. Defaults
   * to 5.
   */
  readonly maxSteps?: number;
  /**
   * The trace to continue: the run's `agent-run` span attaches to a trace started elsewhere (an
   * incoming `traceparent`, a parent run — as-tool composition reads it from the tool context).
   * Absent = the run starts a fresh trace. An empty string is the tool context's "no trace"
   * encoding (`NoOpSpan` / no tracer) and counts as absent — the delegated run then starts its own
   * trace instead of hanging off a nonexistent parent. Only meaningful with an attached tracer.
   */
  readonly traceId?: string | undefined;
  /**
   * The parent span inside the continued trace; requires `traceId` (the tracer rejects one without
   * the other). Absent = the run's `agent-run` span hangs directly under the continued trace. An
   * empty string counts as absent, and so it does when the trace id is empty.
   */
  readonly parentSpanId?: string | undefined;
  /**
   * Erase `input` from every exported event of this run's trace, overriding the tracer-level
   * default for this run. Trace-level: decided on the run's root span, inherited by its children.
   */
  readonly hideInput?: boolean | undefined;
  /** Erase `output` from every exported event of this run's trace (see `hideInput`). */
  readonly hideOutput?: boolean | undefined;
  /**
   * Ask for a structured answer: the schema is sent to the model as JSON Schema (`responseFormat`
   * on every model call of the run), and the run's terminal text is parsed as JSON and validated
   * against it — strictly: an answer that is not JSON, or does not match the schema, fails the run
   * with `StructuredOutputError` (execution semantics). The validated value
   * settles the output object's `object`; absent = the run's answer is plain text, `object` is
   * `undefined`.
   */
  readonly structuredOutput?: StructuredOutputConfig | undefined;
  /**
   * The run's memory identity (the identity model): present = the run recalls
   * from and saves into the agent's `memory` for the named thread/resource; absent = the run does
   * no memory I/O. Passing the option to an agent that has no configured `memory` is an error, as
   * is omitting either field — the identity is explicit, never defaulted.
   */
  readonly memory?: AgentMemoryOptions | undefined;
  /**
   * The run's step-boundary wiring (the harness's relations to the other subsystems): the agent
   * loop's only harness extension point — the hook surface the durable approval gate
   * (`beforeToolCalls`) and the signals injector (`beforeNextStep`) hang on. Absent = the loop
   * runs untouched: no hook is consulted, nothing is copied, the bare agent's behavior is
   * unchanged (the harness spec's zero-overhead guarantee). Not request context — it is per-run
   * execution wiring, kept out of the context bag the tools see.
   */
  readonly stepBoundary?: AgentStepBoundary | undefined;
  /**
   * Continue a suspended run from its snapshot — the harness wrappers' re-entry (`AgentRunResume`).
   * With it, `input` is the suspended run's own
   * message list: the resumed run's prompt, used verbatim, so prompt assembly is skipped — no
   * instructions, no memory recall, no working memory, no `processInput` (the list already carries
   * what the suspended run saw, the input processors included). A resumed run's memory identity
   * therefore only records the continued step; nothing is recalled and no history is re-saved.
   */
  readonly resume?: AgentRunResume | undefined;
}

/**
 * Per-call execution options. The open bag below is the user's per-call request context
 * (`RequestContext`'s user properties): it is what dynamic arguments resolve against, and the very
 * same object is handed to tool contexts.
 */
export type AgentRunOptions = AgentRunOptionFields & {
  /** User per-call request context properties. */
  readonly [key: string]: unknown;
};

/**
 * The runtime mirror of `AgentRunOptionFields`: `toRequestContext` derives its exclusion list from
 * this array (the closed interface is the single source of truth, and the exhaustiveness assertion
 * below fails the build when the two drift apart).
 *
 * Internal seam — not exported from any entry.
 */
export const AGENT_RUN_OPTION_KEYS = [
  'modelSettings',
  'providerOptions',
  'signal',
  'maxSteps',
  'traceId',
  'parentSpanId',
  'hideInput',
  'hideOutput',
  'structuredOutput',
  'memory',
  'stepBoundary',
  'resume',
] as const;

/** Exact type identity (the `<T>() =>` trick — mutual assignability is not enough). */
type Equals<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

/** Constraint carrier of the exhaustiveness assertion (`AgentRunOptionKeysExhaustive`). */
type AssertExhaustive<Check extends [true, never, never]> = Check;

/**
 * The exclusion list's exhaustiveness assertion: `AGENT_RUN_OPTION_KEYS` must mirror
 * `keyof AgentRunOptionFields` exactly. On drift the tuple no longer satisfies the
 * `[true, never, never]` constraint, so the package fails to compile and the error names the
 * drifting key in the `Exclude<…>` slots (`[false, 'missedByKeys', 'extraInKeys']`) — a new
 * framework run option cannot silently leak into every dynamic resolver's and tool's
 * `ctx.requestContext`. Type-level only: nothing is emitted. Exported from the module so the
 * compiler evaluates it (an unused local alias would be flagged instead); not exported from any
 * entry.
 */
export type AgentRunOptionKeysExhaustive = AssertExhaustive<
  [
    Equals<keyof AgentRunOptionFields, (typeof AGENT_RUN_OPTION_KEYS)[number]>,
    Exclude<keyof AgentRunOptionFields, (typeof AGENT_RUN_OPTION_KEYS)[number]>,
    Exclude<(typeof AGENT_RUN_OPTION_KEYS)[number], keyof AgentRunOptionFields>,
  ]
>;

/**
 * The agent loop's step-boundary seam (signals and the harness's relations to the other
 * subsystems): the one loop change the harness spec allows — per-run wiring the harness wrappers
 * (`createDurableAgent` / `createSignals`) pass as `AgentRunOptions.stepBoundary`. Absent = the loop
 * runs exactly as before: no hook is consulted, nothing is copied, the bare agent's behavior is
 * unchanged (the zero-overhead-without-signals guarantee, verbatim for the approval gate).
 *
 * One seam, two phases, because both harness consumers hang the same region of the loop and no
 * earlier extension point reaches it: the processors' hooks all run after a step's tools have
 * executed, and wrapping `tool.execute` can only turn a suspension into an error tool result fed
 * back to the model — a gate has to hold the calls before they execute, an injector has to land
 * its messages before the next model call.
 *
 * - `beforeToolCalls` — after the step's model output has fully streamed (the caller has seen its
 *   finish chunk), before the framework executes the step's pending tool calls. The durable
 *   approval gate decides here. The event carries the snapshot surface the wrapper persists
 * (messages + stepIndex + trace continuation); a suspend decision ends the run at this boundary
 * — a normal terminal outcome, never an error. The loop itself keeps no snapshot — the wrapper
 *   builds one from the event.
 * - `beforeNextStep` — before every model call of the run, the first included. The signals
 *   injector drains its queue here; the messages it returns are appended to the prompt and take
 *   part in that model call (injected into the current run, taking effect at the next step).
 */
export interface AgentStepBoundary {
  /**
   * The approval point: after the step's tool calls are known, before any of them executes.
   * Called only for steps with at least one pending (framework-executed) call. Returning a
   * suspend decision ends the run with `finishReason: 'suspended'`; returning nothing lets the
   * calls execute exactly as before. May be synchronous or asynchronous.
   */
  beforeToolCalls?(
    event: AgentToolCallsBoundaryEvent,
  ): AgentStepBoundaryDecision | Promise<AgentStepBoundaryDecision | void> | void;
  /**
   * The injection point: before every model call of the run, the first included. The messages
   * returned are appended to the prompt — after the event's `messages` snapshot — and are what
   * that model call sees (and what the step span records as its input). Returning nothing injects
   * nothing. May be synchronous or asynchronous.
   */
  beforeNextStep?(
    event: AgentStepBoundaryEvent,
  ): readonly ModelMessage[] | Promise<readonly ModelMessage[] | void> | void;
}

/**
 * What both step-boundary phases observe: the run's message list at the boundary (a copy —
 * mutating it does not touch the run), the 0-based index of the step the boundary belongs to (=
 * the count of completed steps at that moment), and the run's trace continuation — the
 * `agent-run` span's ids, empty strings when the run is untraced (the same encoding `ToolContext`
 * carries: no tracer / `NoOpSpan`). The durable snapshot persists `traceId`; an injector hangs its
 * `isEvent` span under the live run span through the `traceId` + `spanId` pair.
 */
export interface AgentStepBoundaryEvent {
  /** The run's vendor-shaped message list at the boundary — pre-injection for `beforeNextStep`. */
  readonly messages: readonly ModelMessage[];
  /** The 0-based index of the step the boundary belongs to. */
  readonly stepIndex: number;
  /** The run's trace id — the `agent-run` span's, or `''` when the run is untraced. */
  readonly traceId: string;
  /** The `agent-run` span's id — where an injected event span hangs — or `''` when untraced. */
  readonly spanId: string;
}

/** The `beforeToolCalls` event: the boundary snapshot plus the calls the loop is about to execute. */
export interface AgentToolCallsBoundaryEvent extends AgentStepBoundaryEvent {
  /**
   * The step's pending tool calls — the ones the framework is about to execute, in call order.
   * Provider-executed calls are not here: they already carry their results in `messages`.
   */
  readonly pendingCalls: readonly ToolCallChunk[];
}

/**
 * The decision a `beforeToolCalls` hook returns to end the run at that boundary: the pending calls
 * do not execute, the step never completes (no processor hook, no memory save, nothing appended to
 * the prompt), and the run settles normally with `finishReason: 'suspended'` — suspension is a
 * terminal outcome, not an error (durable agents: the `agent-run` span ends normal under a
 * `status: 'suspended'` attribute). What is
 * persisted alongside — the snapshot, its `suspendPayload` — is the wrapper's own state: the hook
 * and the wrapper share a closure, and the loop keeps no snapshot of its own.
 */
export interface AgentStepBoundaryDecision {
  /** Ends the run at this boundary with `finishReason: 'suspended'`. */
  readonly suspend: true;
}

/**
 * The continue-from-snapshot seed (`AgentRunOptions.resume`): how a harness wrapper re-enters a
 * suspended run (the durable wrapper's `resume`).
 * The run's message list carries everything the suspended run saw; this seed replays the one thing
 * a message list cannot reconstruct — the calls the suspended step held back, and how each of them
 * is answered.
 *
 * Step numbering continues across a resume: `stepCount` is where the suspended run stopped, so the
 * resumed segment's steps, the `maxSteps` cap and every seam event that reports a step index all
 * keep counting one run. The resumed step itself makes no model call — its output already streamed
 * in the suspended run (its `finish` chunk reached that run's caller) — so it contributes its held
 * calls' results, not a second round trip.
 */
export interface AgentRunResume {
  /**
   * How many steps the suspended run had completed when it suspended (`AgentRunSnapshot.stepCount`).
   * The resumed run's prompt must end with that step's own assistant message — the held calls' text
   * and calls — which is also where the step's recorded output is read back from.
   */
  readonly stepCount: number;
  /**
   * The calls the suspended step held back, in call order (at least one). They execute exactly as
   * the loop's own calls do — same validation, error tool results, spans — except that the prompt
   * already ends with their assistant message, so only the resulting `tool` message is appended.
   */
  readonly toolCalls: readonly ToolCallChunk[];
  /**
   * Pre-supplied answers: a call whose id appears here is answered with the given result instead of
   * executing — the approval gate's user-rejected path. Calls without an answer execute.
   */
  readonly answers?: readonly ToolResultChunk[] | undefined;
}

/**
 * The per-call memory identity of a run (the identity model): the thread the
 * run reads history from and appends to, plus the resource that owns it. Both fields are required —
 * an identity missing one fails at call time, before any model call.
 */
export interface AgentMemoryOptions {
  /**
   * The thread of this run's history: an id, or an id plus the `title` / `metadata` a missing
   * thread is created with on the run's first save.
   */
  readonly thread: MemoryThreadRef;
  /**
   * The thread's owner (`resourceId`) — stamped on every message the run saves. Memory does no
   * access control: the application authorizes the caller against this resource itself.
   */
  readonly resource: string;
}

/**
 * The `structuredOutput` run option (execution semantics): the shape the model's
 * final answer must have, as a Standard Schema dual interface (ADR-0003).
 *
 * One schema, no other switches: the validation strategy of v1 is fixed at strict (a non-conforming
 * answer fails the run — there is no `errorStrategy`). The schema's type drives the output object's
 * `object` wherever it is statically known: `StructuredOutputConfig<TSchema>` makes `object`
 * `StandardSchemaV1.InferOutput<TSchema>`.
 */
export interface StructuredOutputConfig<TSchema extends StandardSchema = StandardSchema> {
  /** The shape the run's final answer must have (Standard Schema: validate + JSON Schema). */
  readonly schema: TSchema;
}

/**
 * One step of a run: a single model call and the chunks the chunk protocol carried for it
 * (the `steps[]` protocol). The step's tool calls are recorded as the protocol
 * saw them; the built-in loop executes the client-side ones and appends their results to this same
 * step (results belong to the step whose calls they answer, even though they arrive after its
 * `finish` chunk).
 */
export interface AgentStep {
  /** The text the step produced, concatenated across its text deltas. */
  readonly text: string;
  /** Tool calls the model requested in this step, with their inputs parsed to JSON. */
  readonly toolCalls: readonly ToolCallChunk[];
  /** Tool results reported for this step — provider-executed ones plus the framework-executed ones. */
  readonly toolResults: readonly ToolResultChunk[];
  /** Token usage the model reported for this step. */
  readonly usage: Usage;
}

/**
 * The output object returned by `stream()`: one run, two consumption styles, one chunk pass
 * (the output object).
 *
 * - `for await (const chunk of result)` yields the core's own chunk protocol — never an AI SDK
 *   stream format (ADR-0004). The chunk stream is single-consumption; leaving the loop early
 * (`break`) does not cancel the run, the terminal values still settle (cancellation is the
 *   per-call `signal`'s job).
 * - The terminal promises resolve with the run's final values. Reading one starts the run if it
 *   has not started yet; terminal values that are never read are never created, so a consumer
 *   that only iterates cannot be hit by unhandled rejections.
 *
 * `TObject` is the type of the run's structured output: the schema's output type when the run asks
 * for one (see the `stream()` overloads), `unknown` otherwise.
 */
export interface AgentStreamResult<TObject = unknown> extends AsyncIterable<Chunk> {
  /** Text of the run's final step (intermediate steps' text is in `steps`). */
  readonly text: Promise<string>;
  /**
   * The run's structured output: the final step's text parsed as JSON and validated against
   * `structuredOutput.schema` (execution semantics). Resolves `undefined` when
   * the run was not asked for one; rejects with `StructuredOutputError` when the answer is not JSON
   * or does not match the schema (strict), and with the run's own error when the run failed.
   */
  readonly object: Promise<TObject>;
  /** Tool calls the model requested over the whole run — `steps` flattened, in step order. */
  readonly toolCalls: Promise<readonly ToolCallChunk[]>;
  /** Tool results recorded over the whole run (framework- and provider-executed) — `steps` flattened. */
  readonly toolResults: Promise<readonly ToolResultChunk[]>;
  /** Per-step records: text, tool calls, tool results and usage of each model call. */
  readonly steps: Promise<readonly AgentStep[]>;
  /** Usage accumulated over the whole run. */
  readonly usage: Promise<Usage>;
  /** Why the last step stopped — the run's terminal reason. */
  readonly finishReason: Promise<FinishReason>;
}

/** The terminal result of `generate()`: `stream()`'s awaited terminal values. */
export interface AgentGenerateResult<TObject = unknown> {
  /** Text of the run's final step (intermediate steps' text is in `steps`). */
  readonly text: string;
  /**
   * The run's structured output — the schema's validated value (`structuredOutput.schema`), or
   * `undefined` when the run was not asked for one. A non-conforming answer never reaches here: it
   * fails the run with `StructuredOutputError` (strict).
   */
  readonly object: TObject;
  /** Tool calls the model requested over the whole run — `steps` flattened, in step order. */
  readonly toolCalls: readonly ToolCallChunk[];
  /** Tool results recorded over the whole run (framework- and provider-executed) — `steps` flattened. */
  readonly toolResults: readonly ToolResultChunk[];
  /** Usage accumulated over the whole run. */
  readonly usage: Usage;
  /** Why the model stopped: `'stop'` / `'length'` / `'tool-calls'` / `'error'`; `'suspended'` only
   *  when a `stepBoundary` gate suspended the run (the durable approval gate — bare runs never). */
  readonly finishReason: FinishReason;
  /** Per-step records: text, tool calls, tool results and usage of each model call. */
  readonly steps: readonly AgentStep[];
}
