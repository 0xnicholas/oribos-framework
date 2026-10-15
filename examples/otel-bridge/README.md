# otel-bridge example

Agent runs become real OpenTelemetry spans in the host process's own `TracerProvider` — the
`@oribos/otel-bridge` capability package's whole story in one offline script (a scripted model,
an in-memory exporter, no external services, no API key).

## What it shows

1. **Zero cost without opt-in.** Before any provider is registered, a tracer carrying the bridge
   runs a full agent run — every event lands on the OpenTelemetry API's no-op tracer, nothing is
   recorded, nothing throws; the bridge is opt-in and carries no pipeline of its own.
2. **The host SDK receives real spans.** With a provider registered, the same one-line exporter
   choice turns the framework's automatic spans into genuine OTel spans — `invoke_agent` →
   `chat` (CLIENT kind) → `execute_tool`, mapped by the shared `@oribos/semconv` leaf
   (`gen_ai.*` request / usage / response, `oribos.span.type` / `oribos.run_id`) — and the
   oribos tree (run → step → tool) becomes a real OTel parent chain in the SDK-generated trace.
3. **An external trace is continued.** A run started with `{ traceId, parentSpanId }` (as from an
   incoming `traceparent` header) lands under a remote parent SpanContext — the run joins the
   caller's trace instead of starting its own.

## Run it

From the repo root, after `pnpm install && pnpm build`:

```sh
pnpm --filter @oribos/example-otel-bridge start
```

The script self-asserts (`node:assert/strict`) and exits 1 if a span is missing, the tree is
broken, or an attribute is unmapped. It is wired into the offline examples gate
(`pnpm check:examples`).
