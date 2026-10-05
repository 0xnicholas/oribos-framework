/**
 * `@oribos/core/observability` — observability kernel.
 *
 * The kernel's own minimal span model (input/output first-class, seven framework type constants,
 * open `type` string), the tracer with its three-event bus (`span_started` / `span_updated` /
 * `span_ended` carrying `ExportedSpan`), root-only sampling with `NoOpSpan` propagation, the
 * synchronous spanProcessors shaping seam, `hideInput` / `hideOutput`, and the two built-in
 * exporters: console (development debugging) and memory (ring buffer, the assertion surface).
 * OTel mapping does not live here — it is a capability package (ADR-0009). The `Logger` contract
 * is not a kernel signal either: it types the composition root's logger channel (`createApp({
 * logger })`), the one designated path the spec reserves for logs.
 *
 * Decisions: ADR-0009.
 */
export { createTracer } from './tracer.js';
export type { Logger } from './logger.js';
export type { ParentSpanRef, Sampler, StartSpanOptions, Tracer, TracerConfig } from './tracer.js';
export type {
  ObservabilityExporter,
  SpanProcessor,
  TracingEvent,
} from './events.js';
export {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  MEMORY_RECALL_SPAN,
  MEMORY_SAVE_SPAN,
  NoOpSpan,
  TOOL_CALL_SPAN,
  WORKFLOW_RUN_SPAN,
  WORKFLOW_STEP_SPAN,
} from './span.js';
export type {
  AgentRunAttributes,
  AgentStepAttributes,
  ExportedSpan,
  MemoryRecallAttributes,
  MemorySaveAttributes,
  Span,
  SpanAttributes,
  SpanError,
  SpanFields,
  SpanType,
  SpanUpdate,
  ToolCallAttributes,
  WorkflowRunAttributes,
} from './span.js';
export { memoryExporter } from './exporters/memory.js';
export type { MemoryExporter, MemoryExporterOptions } from './exporters/memory.js';
export { consoleExporter } from './exporters/console.js';
export type { ConsoleExporterOptions } from './exporters/console.js';
