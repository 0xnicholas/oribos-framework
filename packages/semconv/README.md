# @oribos/semconv

GenAI semantic-convention mapping pure parts for [Oribos](https://github.com/0xnicholas/oribos-framework) —
the leaf package shared by the OTLP exporter (`@oribos/otlp`) and the OTel bridge
(`@oribos/otel-bridge`).

One job: turn an Oribos [`ExportedSpan`](https://github.com/0xnicholas/oribos-framework/blob/main/packages/core/src/observability/span.ts)
into its GenAI semconv shape — the rebuilt span `name`, the OTel `SpanKind`, and the assembled
attributes:

- `mapSpan` — the seven-type mapping contract (agent-run / agent-step / tool-call /
  workflow-run / workflow-step / memory-recall / memory-save, open types pass through),
  `{operation} {name}` naming, `gen_ai.operation.name` / `gen_ai.request.*` / `gen_ai.usage.*`
  attributes, and the `oribos.*` vocabulary.
- Message payload conversion — `ModelMessage[]` prompts split into `gen_ai.system_instructions`
  and `gen_ai.input.messages`, model output becomes `gen_ai.output.messages`.
- Attribute value-domain rules — OTel attributes carry primitives only; everything else
  best-effort JSON, with `droppedAttributesCount` accounting.

Stateless pure functions, no transport, no SDK: the leaf decides nothing about where spans go.
The only external dependency is `@opentelemetry/api` (for `SpanKind` / attribute types); the
core is a peer.

See `docs/architecture/observability.md`「映射契约(七类 + 兜底)」for the frozen contract this
package implements (ADR-0002 leaf package edge, ADR-0009 reversibility asymmetry).
