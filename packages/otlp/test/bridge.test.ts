/**
 * The three-event bridge: only `span_ended` reaches OTLP, synthesized as a `ReadableSpan`-shaped
 * object through the official BatchSpanProcessor (`docs/architecture/observability.md`
 * 「三事件 → OTLP 桥法」). Wire-level against a local capture endpoint, JSON protocol.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOtlpExporter } from '@oribos/otlp';
import type { ExportedSpan } from '@oribos/core/observability';
import {
  decodeSpans,
  exportAndFlush,
  saveOtelEnv,
  startCapture,
  testSpan,
} from './helpers.js';

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveOtelEnv();
});

afterEach(() => {
  restoreEnv();
});

/** Unix-nano string for a Date, the OTLP/JSON timestamp form. */
const nano = (date: Date): string =>
  String(Math.trunc(date.getTime() / 1000) * 1e9 + (date.getTime() % 1000) * 1e6);

describe('createOtlpExporter: span_ended bridge', () => {
  it('delivers one ended span as OTLP/JSON to the configured url', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      await exportAndFlush(exporter, { kind: 'span_ended', span: testSpan() });

      const request = (await capture.waitForRequests(1))[0]!;
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/traces');
      expect(request.headers['content-type']).toContain('application/json');

      const span = decodeSpans(request.body)[0]!;
      const fixture = testSpan();
      expect(span.traceId).toBe(fixture.traceId);
      expect(span.spanId).toBe(fixture.id);
      expect(span.name).toBe('test-span');
      expect(span.startTimeUnixNano).toBe(nano(fixture.startTime));
      expect(span.endTimeUnixNano).toBe(nano(fixture.endTime!));
    } finally {
      await capture.close();
    }
  });

  it('drops span_started and span_updated — only span_ended enters OTLP', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      const span = testSpan();
      await exportAndFlush(
        exporter,
        { kind: 'span_started', span },
        { kind: 'span_updated', span },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capture.requests).toHaveLength(0);
    } finally {
      await capture.close();
    }
  });

  it('carries the parent as parentSpanId and always sets the SAMPLED flag', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      const span = testSpan({ parentSpanId: 'eeee00000000ffff' });
      await exportAndFlush(exporter, { kind: 'span_ended', span });

      const decoded = decodeSpans((await capture.waitForRequests(1))[0]!.body)[0]!;
      expect(decoded.parentSpanId).toBe('eeee00000000ffff');
      expect(decoded.flags & 0x1).toBe(0x1);
    } finally {
      await capture.close();
    }
  });

  it('maps error to status ERROR with the message, success stays UNSET', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      await exportAndFlush(
        exporter,
        { kind: 'span_ended', span: testSpan({ name: 'ok' }) },
        {
          kind: 'span_ended',
          span: testSpan({ name: 'boom', error: { message: 'gateway down', details: {} } }),
        },
      );

      const [ok, boom] = decodeSpans((await capture.waitForRequests(1))[0]!.body);
      expect(ok!.name).toBe('ok');
      expect(ok!.status).toMatchObject({ code: 0 }); // UNSET
      expect(boom!.name).toBe('boom');
      expect(boom!.status).toMatchObject({ code: 2, message: 'gateway down' }); // ERROR
    } finally {
      await capture.close();
    }
  });

  it('synthesizes the resource (service.name oribos, no telemetry.sdk.*) and the scope', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      await exportAndFlush(exporter, { kind: 'span_ended', span: testSpan() });

      const span = decodeSpans((await capture.waitForRequests(1))[0]!.body)[0]!;
      expect(span.resource['service.name']).toBe('oribos');
      expect(Object.keys(span.resource).some((key) => key.startsWith('telemetry.sdk.'))).toBe(false);
      expect(span.scope.name).toBe('@oribos/otlp');
      expect(span.scope.version).toBeUndefined();
    } finally {
      await capture.close();
    }
  });

  it('maps an isEvent span to a zero-duration span ending when it starts', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      const start = new Date('2026-10-01T00:00:02.500Z');
      const span = testSpan({ isEvent: true, startTime: start, endTime: undefined });
      await exportAndFlush(exporter, { kind: 'span_ended', span });

      const decoded = decodeSpans((await capture.waitForRequests(1))[0]!.body)[0]!;
      expect(decoded.endTimeUnixNano).toBe(nano(start));
      expect(decoded.startTimeUnixNano).toBe(decoded.endTimeUnixNano);
    } finally {
      await capture.close();
    }
  });

  it('resolves the service name from options and env in the documented precedence', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_SERVICE_NAME = 'from-env';
      const envExporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      await exportAndFlush(envExporter, { kind: 'span_ended', span: testSpan() });
      const fromEnv = decodeSpans((await capture.waitForRequests(1))[0]!.body)[0]!;
      expect(fromEnv.resource['service.name']).toBe('from-env');

      // Explicit options outrank env; resourceAttributes outrank serviceName.
      const optionExporter = createOtlpExporter({
        protocol: 'json',
        url: capture.url,
        serviceName: 'from-option',
        resourceAttributes: { 'service.name': 'from-attrs', deploymentenvironment: 'test' },
      });
      await exportAndFlush(optionExporter, { kind: 'span_ended', span: testSpan() });
      const fromOptions = decodeSpans((await capture.waitForRequests(2))[1]!.body)[0]!;
      expect(fromOptions.resource['service.name']).toBe('from-attrs');
      expect(fromOptions.resource.deploymentenvironment).toBe('test');
    } finally {
      await capture.close();
    }
  });

  it('keeps OTEL_RESOURCE_ATTRIBUTES in the resource alongside the service name', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=prod,region=eu%2Dwest';
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      await exportAndFlush(exporter, { kind: 'span_ended', span: testSpan() });

      const span = decodeSpans((await capture.waitForRequests(1))[0]!.body)[0]!;
      expect(span.resource['service.name']).toBe('oribos');
      expect(span.resource['deployment.environment']).toBe('prod');
      expect(span.resource.region).toBe('eu-west');
    } finally {
      await capture.close();
    }
  });

  it('flush() delivers before the scheduled batch delay and shutdown() flushes what is left', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({
        protocol: 'json',
        url: capture.url,
        batch: { scheduledDelayMillis: 60_000 },
      });
      await exporter.export({ kind: 'span_ended', span: testSpan({ name: 'first' }) });
      await exporter.flush!();
      expect(capture.requests).toHaveLength(1);

      await exporter.export({ kind: 'span_ended', span: testSpan({ name: 'second' }) });
      await exporter.shutdown!();
      const requests = await capture.waitForRequests(2);
      const first = requests[0]!;
      const second = requests[1]!;
      expect(decodeSpans(first.body).map((span) => span.name)).toEqual(['first']);
      expect(decodeSpans(second.body).map((span) => span.name)).toEqual(['second']);
    } finally {
      await capture.close();
    }
  });

  it('never throws from export() — an unsynthesizable span is dropped silently', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
      const poison: ExportedSpan = {
        ...testSpan(),
        get endTime(): Date {
          throw new Error('poison');
        },
      } as unknown as ExportedSpan;
      expect(() => exporter.export({ kind: 'span_ended', span: poison })).not.toThrow();
      await exporter.export({ kind: 'span_ended', span: testSpan({ name: 'healthy' }) });
      await exporter.flush!();
      const request = (await capture.waitForRequests(1))[0]!;
      expect(decodeSpans(request.body).map((span) => span.name)).toEqual(['healthy']);
    } finally {
      await capture.close();
    }
  });
});
