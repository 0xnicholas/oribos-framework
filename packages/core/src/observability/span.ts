import type { FinishReason, Usage } from '../model/chunks.js';

/**
 * The framework's span type constants — kebab-case, one vocabulary with the chunk protocol.
 *
 * `type` is an open string: users name their own spans freely. The framework writes exactly these
 * seven, each at its documented automatic-instrumentation boundary
 * (automatic instrumentation).
 */
export const AGENT_RUN_SPAN = 'agent-run';
export const AGENT_STEP_SPAN = 'agent-step';
export const TOOL_CALL_SPAN = 'tool-call';
export const WORKFLOW_RUN_SPAN = 'workflow-run';
export const WORKFLOW_STEP_SPAN = 'workflow-step';
export const MEMORY_RECALL_SPAN = 'memory-recall';
export const MEMORY_SAVE_SPAN = 'memory-save';

/** A span type: an open string. */
export type SpanType = string;

/**
 * Attributes of an `agent-run` span. The framework writes `runId` on every run root — fresh or
 * continued trace — so runId (execution identity) and traceId (observation identity) can look
 * each other up.
 */
export type AgentRunAttributes = {
  readonly agentName: string;
  readonly runId?: string;
};

/** Attributes of an `agent-step` span — one model call of a run. */
export type AgentStepAttributes = {
  readonly model: string;
  readonly provider: string;
  /** The model call settings the framework forwarded (temperature, maxOutputTokens, …). */
  readonly parameters?: Record<string, unknown>;
  readonly usage?: Usage;
  readonly finishReason?: FinishReason;
  /** Milliseconds from the step's start to its first chunk. */
  readonly timeToFirstChunk?: number;
};

/** Attributes of a `tool-call` span — one tool execution. */
export type ToolCallAttributes = {
  readonly toolCallId: string;
};

/** Attributes of a `workflow-run` span — one run's segment, start or resume to its terminal state. */
export type WorkflowRunAttributes = {
  readonly workflowId: string;
  /** The run's execution identity (the root span carries it so snapshot and span can find each other). */
  readonly runId?: string;
};

/**
 * Attributes of a `memory-recall` span — one run's recall from message history. The span's
 * `output` carries the messages the recall returned (storage envelope included).
 */
export type MemoryRecallAttributes = {
  readonly threadId: string;
};

/**
 * Attributes of a `memory-save` span — one step's save into a thread. The span's `input` carries
 * the batch handed to `save`, its `output` the messages as persisted (storage envelope included).
 */
export type MemorySaveAttributes = {
  readonly threadId: string;
  readonly resourceId: string;
};

/**
 * Span attributes, narrowed by type at the type level (zero runtime cost — the OTLP mapping
 * capability package reads them with type safety). `Record<string, unknown>` keeps the bag open
 * for user spans and for `workflow-step` (`{}` — its name is the step id).
 */
export type SpanAttributes =
  | AgentRunAttributes
  | AgentStepAttributes
  | ToolCallAttributes
  | WorkflowRunAttributes
  | MemoryRecallAttributes
  | MemorySaveAttributes
  | Record<string, unknown>;

/** How a span failed. `details` carries the original error object when there was one. */
export type SpanError = {
  readonly message: string;
  readonly details?: unknown;
};

/**
 * The data fields of a span (the span model) — id / traceId are
 * OTel-compatible hex, input/output are first-class citizens (a prompt is the main subject of LLM
 * debugging), `attributes` are narrowed by type and `metadata` is the user's open bag.
 */
export interface SpanFields {
  /** Span id — 16 hex characters. */
  id: string;
  /** Trace id — 32 hex characters. */
  traceId: string;
  /** The parent span this one hangs under; absent for a trace root. */
  parentSpanId?: string;
  /** Human-readable operation name. */
  name: string;
  /** Open span type; the framework's seven constants are exported by this entry. */
  type: SpanType;
  /** When the span started. */
  startTime: Date;
  /** When the span ended; absent while it is open, and absent for an `isEvent` span. */
  endTime?: Date;
  /** What went in — prompt for a model call, arguments for a tool call. */
  input?: unknown;
  /** What came out — the response, the result. */
  output?: unknown;
  /** Structured attributes, narrowed by type. */
  attributes?: SpanAttributes;
  /** The user's open bag. */
  metadata?: Record<string, unknown>;
  /** How the span failed, when it did. */
  error?: SpanError;
  /** A point-in-time span: no duration, complete at creation (one `span_ended`). */
  isEvent?: boolean;
}

/**
 * The exported form of a span: plain data, no live methods and no references to other spans (the
 * parent is described by `parentSpanId`, never by an object) — everything an exporter needs to
 * send the span out. `input` / `output` / `attributes` / `metadata` values are passed through as
 * they are given.
 */
export type ExportedSpan = SpanFields;

/**
 * A live span (`tracer.startSpan`): the span's data plus the three lifecycle methods. The data
 * fields are read-only through this interface — changes go through `update` / `error` / `end`, so
 * every change is dispatched to exporters.
 *
 * Lifecycle: creating the span dispatches `span_started`; `update` and `error` dispatch
 * `span_updated`; `end` dispatches `span_ended` exactly once. After `end`, further calls are
 * ignored (no second `span_ended`, no late updates).
 *
 * `error` is the recording method here, so the live handle does not carry the recorded failure as
 * a data field — the span model names both the field and the method `error`, and one property
 * cannot be both. The recorded failure is read on the exported form (`ExportedSpan.error`).
 */
export interface Span extends Readonly<Omit<SpanFields, 'error'>> {
  /** Ends the span and dispatches `span_ended`. Idempotent. */
  end(): void;
  /**
   * Updates the span and dispatches `span_updated`: `name` / `input` / `output` are set,
   * `attributes` / `metadata` are shallow-merged into what is already there. Omitted fields stay
   * untouched.
   */
  update(patch: SpanUpdate): void;
  /** Records a failure (`{ message, details }`) and dispatches `span_updated`. */
  error(error: unknown): void;
}

/** The fields `update` may touch. */
export interface SpanUpdate {
  /** New name; omitted → unchanged. */
  name?: string;
  /** New input value; omitted → unchanged. */
  input?: unknown;
  /** New output value; omitted → unchanged. */
  output?: unknown;
  /** Shallow-merged into the span's attributes. */
  attributes?: SpanAttributes;
  /** Shallow-merged into the span's metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * The no-op span: what the tracer returns when the sampler rejects a root, and what every
 * descendant of a rejected root gets — the whole rejected subtree shares this one frozen object,
 * so instrumentation code never branches on sampling (ADR-0009). All three methods do nothing and
 * the ids are empty strings, the same "no tracing here" signal the tool context uses.
 */
export const NoOpSpan: Span = Object.freeze({
  id: '',
  traceId: '',
  name: '',
  type: '',
  // A fresh date per read: the freeze is shallow, so a shared Date instance could be corrupted
  // through `NoOpSpan.startTime.setTime(…)` for every rejected trace.
  get startTime(): Date {
    return new Date(0);
  },
  end(): void {},
  update(_patch: SpanUpdate): void {},
  error(_error: unknown): void {},
});

/**
 * The one home of the empty-string rule for continuation pairs (`NoOpSpan`'s encoding):
 * empty-string continuation ids mean "no trace", not a parent with an empty id. The tool context
 * encodes an untraced call as `traceId: ''` / `spanId: ''` (`NoOpSpan` / no tracer), and an as-tool
 * delegation passes them through verbatim — such a run starts its own trace instead of hanging off
 * a nonexistent parent (multi-agent composition, ADR-0012).
 *
 * The rule: an empty trace id voids the whole pair (a parent outside a trace means nothing); an
 * empty parent id only drops the parent. The asymmetry is deliberate: a real parent id with a
 * *missing* trace id is not the "no trace" encoding but a caller bug, so the pair passes through
 * untouched for the tracer to reject loudly (`startSpan` requires `traceId` with `parentSpanId`).
 *
 * The returned bag omits its absent fields — spread-ready for a `startSpan` options literal.
 * Internal to the package (not re-exported from the observability entry); `startSpan`'s own
 * contract is unchanged — it still stores the ids it is given.
 */
export function normalizeTraceContinuation(
  traceId: string | undefined,
  parentSpanId: string | undefined,
): { traceId?: string; parentSpanId?: string } {
  if (traceId === '') return {};
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(parentSpanId === undefined || parentSpanId === '' ? {} : { parentSpanId }),
  };
}
