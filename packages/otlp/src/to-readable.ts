/**
 * The `ReadableSpan` synthesis (the three-event OTLP bridge):
 * each ended span becomes a plain object structurally satisfying `ReadableSpan` — no SDK
 * Tracer/Provider/Span involved — and goes straight to `BatchSpanProcessor.onEnd()`. Timestamps
 * convert `Date` → `HrTime`; an `isEvent` span ends when it starts (zero duration); synthesized
 * spans always carry the SAMPLED flag (root sampling happened upstream).
 */
import { SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { SpanContext } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { ExportedSpan } from '@oribos/core/observability';
import { mapSpan } from '@oribos/semconv';

/** `instrumentationScope` without a version — the packages release in lockstep anyway. */
const INSTRUMENTATION_SCOPE = { name: '@oribos/otlp' };

/** Milliseconds → `HrTime` (UNIX seconds truncated, nanosecond remainder). */
function toHrTime(date: Date): [number, number] {
  const ms = date.getTime();
  return [Math.trunc(ms / 1000), (ms % 1000) * 1e6];
}

/** Synthesizes the `ReadableSpan` shape for one ended span. */
export function toReadableSpan(span: ExportedSpan, resource: Resource): ReadableSpan {
  const startTime = toHrTime(span.startTime);
  // An `isEvent` span has no lifecycle: it ends when it starts. Apart from that zero duration it
  // maps per type exactly like a lifecycle span.
  const endTime = span.endTime === undefined ? startTime : toHrTime(span.endTime);
  const durationNanos = (endTime[0] - startTime[0]) * 1e9 + (endTime[1] - startTime[1]);
  const mapped = mapSpan(span);
  const spanContext: SpanContext = {
    traceId: span.traceId,
    spanId: span.id,
    traceFlags: TraceFlags.SAMPLED,
  };
  return {
    name: mapped.name,
    kind: mapped.kind,
    spanContext: () => spanContext,
    ...(span.parentSpanId === undefined
      ? {}
      : {
          parentSpanContext: {
            traceId: span.traceId,
            spanId: span.parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
          } satisfies SpanContext,
        }),
    startTime,
    endTime,
    duration: [Math.trunc(durationNanos / 1e9), durationNanos % 1e9],
    status:
      span.error === undefined
        ? { code: SpanStatusCode.UNSET }
        : { code: SpanStatusCode.ERROR, message: span.error.message },
    attributes: mapped.attributes,
    events: [],
    links: [],
    droppedAttributesCount: mapped.droppedAttributesCount,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    resource,
    instrumentationScope: INSTRUMENTATION_SCOPE,
    ended: true,
  };
}
