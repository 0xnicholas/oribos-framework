/**
 * The zero-cost face (`docs/architecture/observability.md` CUT-OBS2 保轴硬门): with no host
 * TracerProvider registered, the bridge is a silent no-op on the API's no-op tracer — opt-in,
 * nothing recorded, nothing thrown, no pipeline of its own. This file registers no provider.
 */
import { describe, expect, it } from 'vitest';
import { createOtelBridge } from '@oribos/otel-bridge';
import { createTracer } from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';

function testSpan(overrides: { [K in keyof ExportedSpan]?: ExportedSpan[K] | undefined } = {}): ExportedSpan {
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

describe('createOtelBridge: no host provider (zero-cost face)', () => {
  it('never throws with no provider — the API no-op tracer absorbs every event', () => {
    const bridge = createOtelBridge();
    const span = testSpan({ type: 'agent-run', name: 'desk', attributes: { agentName: 'desk' } });
    expect(() => bridge.export({ kind: 'span_started', span })).not.toThrow();
    expect(() => bridge.export({ kind: 'span_updated', span })).not.toThrow();
    expect(() => bridge.export({ kind: 'span_ended', span })).not.toThrow();
    // An isEvent span (ended with no started one) takes the same silent path.
    expect(() =>
      bridge.export({ kind: 'span_ended', span: testSpan({ isEvent: true, endTime: undefined }) }),
    ).not.toThrow();
  });

  it('carries no flush / shutdown — the host SDK owns the pipeline', () => {
    const bridge = createOtelBridge();
    expect(bridge.flush).toBeUndefined();
    expect(bridge.shutdown).toBeUndefined();
  });

  it('composes with the core tracer — tracer flush joins through a pipeline-free bridge', async () => {
    const tracer = createTracer({ exporters: [createOtelBridge()] });
    const span = tracer.startSpan({ name: 'desk', type: 'agent-run', attributes: { agentName: 'desk' } });
    span.end();
    await expect(tracer.flush()).resolves.toBeUndefined();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });
});
