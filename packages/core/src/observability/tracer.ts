import type { ObservabilityExporter, SpanProcessor, TracingEvent } from './events.js';
import { NoOpSpan } from './span.js';
import type { ExportedSpan, Span, SpanAttributes, SpanError, SpanType, SpanUpdate } from './span.js';
import { messageOf } from '../standard-schema-runtime.js';

/**
 * The parent a root span continues an existing trace from — `undefined` when the span starts a
 * fresh trace. Sampler functions receive it so a custom sampler can decide by what it continues.
 */
export interface ParentSpanRef {
  /** The trace being continued. */
  traceId: string;
  /** The parent span within that trace, when the continuer knows it. */
  parentSpanId?: string;
}

/**
 * The sampling modes: which roots are traced. Decided once
 * when a root span is created; every descendant inherits the decision, and a rejected root yields
 * `NoOpSpan` for the whole subtree.
 */
export type Sampler =
  | 'always'
  | 'never'
  | { ratio: number }
  | ((parent: ParentSpanRef | undefined) => boolean);

/**
 * What one manual span is started with. `parent` is explicit context propagation: the framework
 * passes the live parent span down the execution tree — no AsyncLocalStorage, and a user-created
 * span inside a tool does the same.
 */
export interface StartSpanOptions {
  /** Human-readable operation name. */
  name: string;
  /** Open span type; the framework's seven constants are exported by this entry. */
  type: SpanType;
  /** The live parent span, when this span hangs under another one. */
  parent?: Span;
  /**
   * The trace to continue, for a root span that attaches to a trace started elsewhere (an incoming
   * `traceparent`, a run option). Mutually exclusive with `parent`; absent on a fresh root the
   * tracer generates one. Descendants inherit it from their parent and cannot override it.
   */
  traceId?: string;
  /**
   * The parent span inside the continued trace (`traceId` is required with it). Mutually exclusive
   * with `parent`.
   */
  parentSpanId?: string;
  /** A point-in-time span: complete at creation, dispatched as a single `span_ended` (no duration). */
  isEvent?: boolean;
  /** What went in (prompt, tool arguments, …) — first-class, exported as-is. */
  input?: unknown;
  /** What came out (response, result, …) — first-class, exported as-is. */
  output?: unknown;
  /** Structured attributes, narrowed by type. */
  attributes?: SpanAttributes;
  /** The user's open bag. */
  metadata?: Record<string, unknown>;
  /**
   * Erase `input` from every event of this span's trace. Trace-level: only a root span may set it
   * (usually the M1-09 run option); descendants always inherit their parent's decision.
   */
  hideInput?: boolean;
  /** Erase `output` from every event of this span's trace (root-only, inherited by descendants). */
  hideOutput?: boolean;
}

/** The tracer. */
export interface Tracer {
  /** Starts a span and returns its live handle. */
  startSpan(options: StartSpanOptions): Span;
  /** Awaits the exports already in flight, then every exporter's own `flush`. */
  flush(): Promise<void>;
  /** `flush()`, then every exporter's `shutdown`. */
  shutdown(): Promise<void>;
}

/** The `createTracer` config. */
export interface TracerConfig {
  /** Where tracing events go. An empty list is allowed: the spans stay fully usable. */
  exporters: readonly ObservabilityExporter[];
  /** Which roots are traced; `'always'` (the default) traces every run. */
  sampler?: Sampler;
  /**
   * The synchronous per-event shaping seam, run in order before every export: each processor may
   * rewrite the event (in place or by returning a replacement) or return `undefined` to drop it.
   */
  spanProcessors?: readonly SpanProcessor[];
  /** Erase `input` from every exported event by default (per-span `hideInput` overrides). */
  hideInput?: boolean;
  /** Erase `output` from every exported event by default (per-span `hideOutput` overrides). */
  hideOutput?: boolean;
}

/**
 * The observability entry point: one tracer per application
 * (or per composition root), injected into the subsystems that instrument. Subsystems never reach
 * for a global.
 */
export function createTracer(config: TracerConfig): Tracer {
  const exporters = [...config.exporters];
  const spanProcessors = [...(config.spanProcessors ?? [])];
  const sampler = toSampler(config.sampler);
  const hideInputByDefault = config.hideInput ?? false;
  const hideOutputByDefault = config.hideOutput ?? false;
  /** The effective hiding decision of every live span; descendants inherit their parent's. */
  const policies = new WeakMap<Span, HidePolicy>();
  /** Async exports in flight — joined by `flush` so nothing is cut off. */
  const pending = new Set<Promise<void>>();

  function startSpan(options: StartSpanOptions): Span {
    const parent = options.parent;
    assertContinuation(parent, options);
    assertRootHiding(parent, options);
    // A rejected trace propagates as the shared NoOpSpan; descendants never re-decide.
    if (parent === NoOpSpan) return NoOpSpan;
    // Sampling is decided once, when a root span is created (ADR-0009).
    const externalParent = toExternalParent(options);
    if (parent === undefined && !sampled(externalParent)) return NoOpSpan;

    const policy = toHidePolicy(parent, options);

    /** The recorded failure; `error` on the handle is the recording method, not the data field. */
    let spanError: SpanError | undefined;
    let ended = false;

    const span: LiveSpan = {
      id: randomHex(8),
      traceId: parent?.traceId ?? options.traceId ?? randomHex(16),
      ...(parent !== undefined
        ? { parentSpanId: parent.id }
        : options.parentSpanId !== undefined
          ? { parentSpanId: options.parentSpanId }
          : {}),
      name: options.name,
      type: options.type,
      startTime: new Date(),
      end(): void {
        if (ended) return;
        ended = true;
        span.endTime = new Date();
        emitSnapshot('span_ended', policy);
      },
      update(patch: SpanUpdate): void {
        if (ended) return;
        if (patch.name !== undefined) span.name = patch.name;
        if (patch.input !== undefined) span.input = patch.input;
        if (patch.output !== undefined) span.output = patch.output;
        if (patch.attributes !== undefined) {
          span.attributes = { ...span.attributes, ...patch.attributes };
        }
        if (patch.metadata !== undefined) {
          span.metadata = { ...span.metadata, ...patch.metadata };
        }
        emitSnapshot('span_updated', policy);
      },
      error(error: unknown): void {
        if (ended) return;
        spanError = { message: messageOf(error), details: error };
        emitSnapshot('span_updated', policy);
      },
    };
    policies.set(span, policy);

    /** Dispatches the span's snapshot right now under one of the three lifecycle event kinds. */
    function emitSnapshot(kind: TracingEvent['kind'], policy: HidePolicy): void {
      // The discriminated union cannot be built from a union-typed `kind` directly; every variant
      // has the same shape, so the assertion is the union distributor, not a widening.
      const event = { kind, span: toExportedSpan(span, spanError) } as TracingEvent;
      emit(event, policy);
    }

    if (options.input !== undefined) span.input = options.input;
    if (options.output !== undefined) span.output = options.output;
    if (options.attributes !== undefined) span.attributes = options.attributes;
    if (options.metadata !== undefined) span.metadata = options.metadata;

    if (options.isEvent === true) {
      // An event span is complete the moment it exists: no duration, exactly one span_ended.
      span.isEvent = true;
      ended = true;
      emitSnapshot('span_ended', policy);
      return span;
    }

    emitSnapshot('span_started', policy);
    return span;
  }

  /** Decides one root's fate. Called only for roots; descendants inherit through `NoOpSpan`. */
  function sampled(parent: ParentSpanRef | undefined): boolean {
    if (sampler === 'always') return true;
    if (sampler === 'never') return false;
    if (typeof sampler === 'function') return sampler(parent);
    return Math.random() < sampler.ratio;
  }

  /**
   * Runs one event through the export pipeline: the spanProcessors in order (a processor that
   * returns `undefined` drops the event), then the trace's hiding flags, then every exporter.
   *
   * Hiding runs after the processors on purpose: exporters never see a hidden field, even when a
   * processor put one back; processors still see the original values they may need to redact.
   */
  function emit(event: TracingEvent, policy: HidePolicy): void {
    let current: TracingEvent | undefined = event;
    for (const processor of spanProcessors) {
      current = processor(current);
      if (current === undefined) return;
    }
    dispatch(scrub(current, policy));
  }

  /**
   * The hiding decision of one span. Trace-level: a root decides it (its own option over the tracer
   * default), a descendant always inherits its parent's — a `WeakMap` rather than a public field,
   * so the policy stays out of the span surface. A foreign parent (another tracer's span) falls
   * back to this tracer's default.
   */
  function toHidePolicy(parent: Span | undefined, options: StartSpanOptions): HidePolicy {
    if (parent !== undefined) {
      const inherited = policies.get(parent);
      return {
        hideInput: inherited?.hideInput ?? hideInputByDefault,
        hideOutput: inherited?.hideOutput ?? hideOutputByDefault,
      };
    }
    return {
      hideInput: options.hideInput ?? hideInputByDefault,
      hideOutput: options.hideOutput ?? hideOutputByDefault,
    };
  }

  /**
   * Sends one event to every exporter, in order. Exporting must never break the traced code: a
   * throwing exporter is swallowed, and a rejected async export is not awaited here (the tracer's
   * `flush` is where pending work is joined).
   */
  function dispatch(event: TracingEvent): void {
    for (const exporter of exporters) {
      try {
        const result = exporter.export(event);
        if (result instanceof Promise) track(result);
      } catch {
        // Swallowed by design: observability failures are not the application's failures.
      }
    }
  }

  /** Keeps an in-flight async export around for `flush`, and never lets its rejection surface. */
  function track(result: Promise<void>): void {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  }

  async function flush(): Promise<void> {
    // Exports can still be added while joining (an export that starts another span), hence the loop.
    while (pending.size > 0) await Promise.all([...pending]);
    for (const exporter of exporters) await exporter.flush?.();
  }

  async function shutdown(): Promise<void> {
    await flush();
    for (const exporter of exporters) await exporter.shutdown?.();
  }

  return { startSpan, flush, shutdown };
}

/**
 * The wrap-one-await span idiom of the automatic instrumentation: runs `run` wrapped in one span —
 * an absent tracer short-circuits to the bare call (no span object is ever created), otherwise
 * `startSpan`, the awaited result lands as the span's `output`, a throw is recorded with `error`
 * and rethrown untouched, and `end` closes the span on every path. The error / rethrow / end
 * triple — the half of the skeleton that is easiest to get wrong — lives here exactly once.
 *
 * Not for spans that stay open across an unbounded region (a step span outliving its tool calls):
 * those keep their explicit `startSpan` / `end` pair at the call site.
 *
 * Internal to the package (not re-exported from the observability entry).
 */
export async function withSpan<T>(
  tracer: Tracer | undefined,
  options: StartSpanOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (tracer === undefined) return run();
  const span = tracer.startSpan(options);
  try {
    const result = await run();
    span.update({ output: result });
    return result;
  } catch (error) {
    span.error(error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * The external parent description a root continues — `undefined` for a fresh trace. Both ids come
 * from the caller (a `traceparent` header, a run option), so no id is synthesized here.
 */
function toExternalParent(options: StartSpanOptions): ParentSpanRef | undefined {
  if (options.traceId === undefined) return undefined;
  return options.parentSpanId === undefined
    ? { traceId: options.traceId }
    : { traceId: options.traceId, parentSpanId: options.parentSpanId };
}

/**
 * Rejects a descendant passing the trace-level hiding flags: only a root decides, children
 * inherit — attempting to change it is a mistake at the call site, not a silent override.
 */
function assertRootHiding(parent: Span | undefined, options: StartSpanOptions): void {
  if (parent !== undefined && (options.hideInput !== undefined || options.hideOutput !== undefined)) {
    throw new Error(
      'startSpan: `hideInput` / `hideOutput` are trace-level — set them on the root span; a child ' +
        "inherits the trace's decision and cannot change it.",
    );
  }
}

/**
 * Rejects continuation combinations that would produce a span tree nobody can make sense of:
 * a live parent and external ids together (which parent wins?), or an external parent span without
 * the trace that contains it. Failing here keeps the mistake at the call site.
 */
function assertContinuation(parent: Span | undefined, options: StartSpanOptions): void {
  if (parent !== undefined && (options.traceId !== undefined || options.parentSpanId !== undefined)) {
    throw new Error(
      'startSpan: `parent` and `traceId` / `parentSpanId` are mutually exclusive — pass the live ' +
        'parent span, or the ids of a parent in another trace, not both.',
    );
  }
  if (options.parentSpanId !== undefined && options.traceId === undefined) {
    throw new Error(
      'startSpan: `parentSpanId` requires `traceId` — a parent span means nothing outside its trace.',
    );
  }
}

/** The export-time hiding decision of one span, inherited by its descendants. */
interface HidePolicy {
  readonly hideInput: boolean;
  readonly hideOutput: boolean;
}

/** Erases the hidden fields from the event's snapshot; the snapshot is copied, not mutated. */
function scrub(event: TracingEvent, policy: HidePolicy): TracingEvent {
  if (!policy.hideInput && !policy.hideOutput) return event;
  const span: ExportedSpan = { ...event.span };
  if (policy.hideInput) delete span.input;
  if (policy.hideOutput) delete span.output;
  return { kind: event.kind, span };
}

/**
 * The live span object: `Span`'s fields are mutable here so the lifecycle methods can update
 * them; the recorded failure lives beside the object (`Span.error` is the recording method on the
 * handle, and `ExportedSpan.error` is the data field).
 */
type LiveSpan = { -readonly [K in keyof Span]: Span[K] };

/**
 * Copies the live span into its exported form. Explicit field by field on purpose: the copied
 * object carries no methods and no references to the live span, and never carries a field that was
 * not set.
 */
function toExportedSpan(span: LiveSpan, spanError: SpanError | undefined): ExportedSpan {
  const exported: ExportedSpan = {
    id: span.id,
    traceId: span.traceId,
    name: span.name,
    type: span.type,
    startTime: span.startTime,
  };
  if (span.parentSpanId !== undefined) exported.parentSpanId = span.parentSpanId;
  if (span.endTime !== undefined) exported.endTime = span.endTime;
  if (span.input !== undefined) exported.input = span.input;
  if (span.output !== undefined) exported.output = span.output;
  if (span.attributes !== undefined) exported.attributes = span.attributes;
  if (span.metadata !== undefined) exported.metadata = span.metadata;
  if (spanError !== undefined) exported.error = spanError;
  if (span.isEvent !== undefined) exported.isEvent = span.isEvent;
  return exported;
}

/** Random hex of `bytes` bytes — 32 hex for a trace id (16 bytes), 16 hex for a span id (8). */
function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let hex = '';
  for (const value of values) hex += value.toString(16).padStart(2, '0');
  return hex;
}

/** Validates the sampler once, at construction: a bad ratio fails loudly instead of mid-run. */
function toSampler(sampler: Sampler | undefined): Sampler {
  const resolved: Sampler = sampler ?? 'always';
  if (typeof resolved === 'object') {
    const { ratio } = resolved;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new RangeError(`sampler ratio must be a number between 0 and 1, got ${String(ratio)}.`);
    }
  }
  return resolved;
}
