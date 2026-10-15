/**
 * TracerProvider interop (`docs/architecture/observability.md` CUT-OBS2 验证面): the bridge is
 * driven through its public `ObservabilityExporter` face and observed through a real host SDK —
 * `BasicTracerProvider` + `InMemorySpanExporter` (dev dependency; the bridge itself never touches
 * the SDK). The assertions read finished spans, not internals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { ROOT_CONTEXT, context, trace } from '@opentelemetry/api';
import { createOtelBridge } from '@oribos/otel-bridge';
import type { ExportedSpan, ObservabilityExporter, TracingEvent } from '@oribos/core/observability';

/** A hand-built span fixture with valid OTel-compatible hex ids and known timestamps. */
function testSpan(
  overrides: { [K in keyof ExportedSpan]?: ExportedSpan[K] | undefined } = {},
): ExportedSpan {
  return {
    id: 'aaaa00000000bbbb',
    traceId: 'cccc000000000000000000000000dddd',
    name: 'test-span',
    type: 'signal',
    startTime: new Date('2026-10-01T00:00:00.250Z'),
    endTime: new Date('2026-10-01T00:00:01.750Z'),
    ...overrides,
  } as ExportedSpan;
}

/** The host SDK face: one provider per file (global API), spans read from the memory exporter. */
const memory = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
trace.setGlobalTracerProvider(provider);

beforeEach(() => {
  memory.reset();
});
afterEach(() => {
  return provider.forceFlush();
});

/** Drives explicit tracing events through the bridge's exporter face. */
function drive(bridge: ObservabilityExporter, ...events: readonly (readonly [TracingEvent['kind'], ExportedSpan])[]): void {
  for (const [kind, span] of events) bridge.export({ kind, span });
}

describe('createOtelBridge: TracerProvider interop', () => {
  it('opens a real span on span_started and closes it on span_ended with the mapped shape', () => {
    const bridge = createOtelBridge();
    const span = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk', runId: 'run-1' },
      input: [{ role: 'user', content: 'hi' }],
      output: 'all set',
      metadata: { tenant: 'acme' },
    });
    drive(bridge, ['span_started', span], ['span_ended', span]);

    const [otSpan] = memory.getFinishedSpans();
    expect(otSpan).toBeDefined();
    expect(otSpan!.name).toBe('invoke_agent desk');
    expect(otSpan!.kind).toBe(0); // OTel API SpanKind.INTERNAL
    expect(otSpan!.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'desk',
      'oribos.run_id': 'run-1',
      'oribos.span.type': 'agent-run',
      'oribos.metadata': '{"tenant":"acme"}',
    });
    // 2026-10-01T00:00:00.250Z, the contract's Date → HrTime conversion.
    expect(otSpan!.startTime).toEqual([1_790_812_800, 250_000_000]);
    expect(otSpan!.endTime).toEqual([1_790_812_801, 750_000_000]);
    expect(otSpan!.duration).toEqual([1, 500_000_000]);
    expect(otSpan!.status.code).toBe(0); // UNSET
    expect(otSpan!.instrumentationScope.name).toBe('@oribos/otel-bridge');
  });

  it('hangs a child under its open parent — the oribos tree becomes the OTel tree', () => {
    const bridge = createOtelBridge();
    const parent = testSpan({ id: 'aaaa00000000bbbb', type: 'agent-run', name: 'desk', attributes: { agentName: 'desk' } });
    const child = testSpan({
      id: 'eeee00000000ffff',
      parentSpanId: parent.id,
      type: 'tool-call',
      name: 'refund',
      attributes: { toolCallId: 'call-1' },
    });
    drive(
      bridge,
      ['span_started', parent],
      ['span_started', child],
      ['span_ended', child],
      ['span_ended', parent],
    );

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const otParent = spans.find((span) => span.name === 'invoke_agent desk');
    const otChild = spans.find((span) => span.name === 'execute_tool refund');
    expect(otParent).toBeDefined();
    expect(otChild).toBeDefined();
    // The child hangs under the parent's OTel identity — same trace, real parent span id.
    expect(otChild!.spanContext().traceId).toBe(otParent!.spanContext().traceId);
    expect(otChild!.parentSpanContext?.spanId).toBe(otParent!.spanContext().spanId);
  });

  it('continues an external trace through a remote parent SpanContext', () => {
    const bridge = createOtelBridge();
    const root = testSpan({
      traceId: 'cccc000000000000000000000000dddd',
      parentSpanId: 'eeee00000000ffff',
    });
    drive(bridge, ['span_started', root], ['span_ended', root]);

    const [otSpan] = memory.getFinishedSpans();
    expect(otSpan).toBeDefined();
    // The host SDK honors the remote parent: same trace, parent = the given external span.
    expect(otSpan!.spanContext().traceId).toBe('cccc000000000000000000000000dddd');
    expect(otSpan!.parentSpanContext?.spanId).toBe('eeee00000000ffff');
  });

  it('a child whose parent already ended falls back to a remote parent in the oribos trace', () => {
    const bridge = createOtelBridge();
    const parent = testSpan({ type: 'agent-run', name: 'desk', attributes: { agentName: 'desk' } });
    const lateChild = testSpan({
      id: 'eeee00000000ffff',
      traceId: parent.traceId,
      parentSpanId: parent.id,
      type: 'tool-call',
      name: 'straggler',
    });
    drive(
      bridge,
      ['span_started', parent],
      ['span_ended', parent],
      ['span_started', lateChild],
      ['span_ended', lateChild],
    );

    const otChild = memory.getFinishedSpans().find((span) => span.name === 'execute_tool straggler');
    expect(otChild).toBeDefined();
    // The open-parent map only covers live spans: out of order, the child still points at the
    // parent — as a remote SpanContext built from the oribos ids (the bridge cannot force the
    // SDK-generated ids of a settled span), so the child keeps the oribos trace identity.
    expect(otChild!.parentSpanContext?.spanId).toBe(parent.id);
    expect(otChild!.spanContext().traceId).toBe(parent.traceId);
  });

  it('roots never attach to ambient context — a fresh oribos trace is a fresh OTel trace', () => {
    const bridge = createOtelBridge();
    const ambient = trace.getTracer('ambient').startSpan('ambient');
    return context.with(trace.setSpan(ROOT_CONTEXT, ambient), () => {
      drive(bridge, ['span_started', testSpan({ type: 'agent-run', name: 'desk', attributes: { agentName: 'desk' } })], [
        'span_ended',
        testSpan({ type: 'agent-run', name: 'desk', attributes: { agentName: 'desk' } }),
      ]);
      const [otSpan] = memory.getFinishedSpans();
      expect(otSpan).toBeDefined();
      // A root started under an ambient context would inherit the ambient trace; ours is its own.
      expect(otSpan!.parentSpanContext).toBeUndefined();
      expect(otSpan!.spanContext().traceId).not.toBe(ambient.spanContext().traceId);
    });
  });

  it('supplements attributes on span_updated — late output reaches the span', () => {
    const bridge = createOtelBridge();
    const started = testSpan({ type: 'agent-step', name: 'gpt-5', attributes: { model: 'gpt-5', provider: 'openai' } });
    const updated = testSpan({
      type: 'agent-step',
      name: 'gpt-5',
      attributes: { model: 'gpt-5', provider: 'openai' },
      output: 'all set',
    });
    drive(bridge, ['span_started', started], ['span_updated', updated], ['span_ended', updated]);

    const [otSpan] = memory.getFinishedSpans();
    expect(otSpan).toBeDefined();
    expect(otSpan!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: 'all set' }] },
      ]),
    });
  });

  it('records an error as status ERROR with the message', () => {
    const bridge = createOtelBridge();
    const span = testSpan({ name: 'boom', error: { message: 'gateway down', details: {} } });
    drive(bridge, ['span_started', span], ['span_ended', span]);

    const [otSpan] = memory.getFinishedSpans();
    expect(otSpan!.status.code).toBe(2); // ERROR
    expect(otSpan!.status.message).toBe('gateway down');
  });

  it('maps an isEvent span to a zero-duration span ending when it starts', () => {
    const bridge = createOtelBridge();
    const start = new Date('2026-10-01T00:00:02.500Z');
    drive(bridge, ['span_ended', testSpan({ isEvent: true, startTime: start, endTime: undefined })]);

    const [otSpan] = memory.getFinishedSpans();
    expect(otSpan).toBeDefined();
    expect(otSpan!.startTime).toEqual(otSpan!.endTime);
    expect(otSpan!.duration).toEqual([0, 0]);
  });
});
