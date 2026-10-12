# signal-webhook

Signal providers as a pattern, not a package: a thin webhook endpoint in front of `sendSignal`. A
carrier posts shipment events over HTTP; the endpoint validates and translates each post into a
typed signal, routes it through an application-owned registry, and the idle thread wakes with the
event in its prompt. Zero new seams, zero dependencies — the whole entry is `node:http` plus the
core's public signals surface. Oribos is a TypeScript agent framework with zero runtime
dependencies — compose only what you use, run anywhere.

The example is a single file (`src/index.ts`) with a scripted model stub — **no API key and no
network** (the server binds loopback on an ephemeral port; the script is its own client). Three
acts:

1. **A webhook wakes its thread.** `POST /webhooks/carrier` with a `shipment.status_changed` event
   answers `202 { delivered: true }` once the signal is delivered; the woken run's prompt ends with
   the rendered `[signal] {…}` message, and the reply lands in history after it.
2. **The registry routes.** The same event on a second account wakes that account's thread only —
   the first thread's history is untouched.
3. **The edge keeps junk off the signals surface.** An unsubscribed event type answers 202 with
   `delivered: false`, a malformed body answers 400, an unknown account answers 202 — and none of
   them wakes a run.

## The recipe

Three pieces, all application code:

- **The registry is yours.** A `Map` from the provider's account id to the thread target here; a
  table in your own database in a deployment. The framework ships no subscription registry — what
  "which thread does this event belong to" means is application domain.
- **Translate at the edge.** Validate the body, drop event types you never subscribed to, then
  render the typed signal. Junk never reaches `sendSignal`, so it never enters a prompt.
- **Delivery is one call.** `signals.sendSignal(target, payload)` renders the payload as one
  `[signal] {…}` user message and wakes the idle thread. Answer 202 once it is delivered — the
  woken run proceeds on its own, so watch it the way a deployment can: spans, history, or
  `subscribeToThread`.

Hardening a real provider entry stays in the same shape: signature verification (GitHub / Stripe
style) before parsing, idempotency keys on the event id, a poll variant as a scheduled `tick` that
diffs and signals (see [`cron-schedule`](../cron-schedule/)). None of it touches the framework —
the entry's shape is a deployment surface, deliberately not part of the spec.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-signal-webhook start
```

Expected output: both woken runs with their prompt tails, the routing proof, and the three junk
posts answering 202 / 400 / 202 with zero runs woken. The script **asserts its own payoff** — a
signal that never reached the woken run's prompt, a webhook routed to the wrong thread, or a junk
post that woke a run exits non-zero instead of printing a happy face.
