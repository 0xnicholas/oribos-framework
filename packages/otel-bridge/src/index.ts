/**
 * `@oribos/otel-bridge` — the OTel bridge capability package.
 *
 * One `ObservabilityExporter` that opens real OpenTelemetry spans through the host process's
 * TracerProvider (`@opentelemetry/api` global tracer), reusing the `@oribos/semconv` GenAI
 * mapping. Decisions: ADR-0009, ADR-0002 (semconv leaf edge), CUT-OBS2.
 */
export { createOtelBridge } from './bridge.js';
