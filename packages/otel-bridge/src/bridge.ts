/**
 * The three-event OTel bridge: each tracing event opens, updates, or closes a **real**
 * OpenTelemetry span through the host process's `TracerProvider` (`@opentelemetry/api` global
 * tracer). The bridge is just another exporter in the tracer's list — no provider, no processor,
 * no pipeline of its own: span lifetime belongs to the host SDK, and without a registered
 * provider every call lands on the API's no-op tracer (opt-in, zero cost, ADR-0001).
 *
 * Span identity is structural, not id-preserving: the API cannot force ids on a started span, so
 * the host SDK generates them. The oribos tree is mapped through the parent relation — an open
 * parent hangs the child under the parent's real OTel span; a parent that is not live (an
 * external continuation, or one already settled) hangs the child under a remote `SpanContext`
 * built from the oribos ids, so the child keeps the oribos trace identity.
 */
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api';
import type { Context, Span, SpanContext } from '@opentelemetry/api';
import type { ExportedSpan, ObservabilityExporter, TracingEvent } from '@oribos/core/observability';
import { mapSpan } from '@oribos/semconv';

/** The instrumentation scope every bridged span carries (no version — lockstep release). */
const INSTRUMENTATION_SCOPE = '@oribos/otel-bridge';

export function createOtelBridge(): ObservabilityExporter {
  const tracer = trace.getTracer(INSTRUMENTATION_SCOPE);
  /** Live spans by oribos id — the parent-relation seam between the oribos tree and OTel's. */
  const open = new Map<string, Span>();

  /**
   * The start context for one span: its live parent, or a remote parent built from the oribos
   * ids, or an explicit root (never the ambient context — a fresh oribos trace is a fresh OTel
   * trace even when the host application has its own active span).
   */
  function parentContextOf(span: ExportedSpan): Context {
    if (span.parentSpanId === undefined) return ROOT_CONTEXT;
    const parent = open.get(span.parentSpanId);
    if (parent !== undefined) return trace.setSpan(ROOT_CONTEXT, parent);
    const remote: SpanContext = {
      traceId: span.traceId,
      spanId: span.parentSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    return trace.setSpanContext(ROOT_CONTEXT, remote);
  }

  return {
    export(event: TracingEvent): void {
      const { kind, span } = event;
      if (kind === 'span_updated') {
        open.get(span.id)?.setAttributes(mapSpan(span).attributes);
        return;
      }
      if (kind === 'span_started') {
        const mapped = mapSpan(span);
        const otSpan = tracer.startSpan(
          mapped.name,
          { kind: mapped.kind, attributes: mapped.attributes, startTime: span.startTime },
          parentContextOf(span),
        );
        open.set(span.id, otSpan);
        return;
      }
      // span_ended. A live span gets its final attributes, status, and end time; without a
      // started one (an `isEvent` span, complete at creation) the span starts and ends here —
      // zero duration when no `endTime` was recorded.
      const otSpan = open.get(span.id);
      const mapped = mapSpan(span);
      const settled =
        otSpan ??
        tracer.startSpan(
          mapped.name,
          { kind: mapped.kind, attributes: mapped.attributes, startTime: span.startTime },
          parentContextOf(span),
        );
      if (otSpan !== undefined) open.delete(span.id);
      settled.setAttributes(mapped.attributes);
      if (span.error !== undefined) {
        settled.setStatus({ code: SpanStatusCode.ERROR, message: span.error.message });
      }
      settled.end(span.endTime ?? span.startTime);
    },
  };
}
