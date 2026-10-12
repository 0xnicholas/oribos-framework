# agent-supervisor

One parent agent delegating to sub-agents wrapped as tools — the as-tool composition standardized
by `@oribos/supervisor`'s `createSupervisor`. Delegation is an ordinary tool call: the wrapper
constructs the delegated input (zero parent-context passthrough), passes `signal` and trace straight
through, and feeds the sub-run's terminal text back bare. Oribos is a TypeScript agent framework
with zero runtime dependencies — compose only what you use, run anywhere.

The example is a single file (`src/index.ts`) with scripted model stubs — no interactive input,
**no API key and no network**. A research desk (`createSupervisor`) coordinates a `researcher`
(with its own `lookup` tool) and a `writer`. Four acts:

1. **One delegation.** The researcher runs its own full loop (`lookup` included); the desk is fed
   back the sub-run's terminal text, bare. The researcher's recorded prompt shows the contract: its
   own instructions plus exactly one constructed user message.
2. **Two delegations in one step.** `researcher` and `writer` run as two calls of a single step, in
   call order (the default serial mode), and the desk composes both answers.
3. **One trace.** With a tracer on every agent, the delegated run's `agent-run` span hangs under
   the parent's `tool-call` span in the same trace — the observability tree does not break at a
   delegation boundary.
4. **A truncated delegation is visible.** `delegation: { maxSteps: 1 }` cuts a researcher that wants
   a second step; the desk is fed `{ text, finishReason: 'tool-calls' }` — a partial answer it can
   recognize as partial.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-agent-supervisor start
```

Expected output: one line per delegation (prompt in, result out), the three-span trace tree, the
truncated delegation's `{ text, finishReason }` payload, and the desk's final reports. The script
**asserts its own payoff** — a researcher that sees parent context, a delegation result that is not
bare text, a broken span tree, an invisible truncation — each exits non-zero instead of printing a
happy face.

## Notes

- **The supervisor is a plain `Agent`.** `createSupervisor` returns the real thing — composable as
  a tool itself, wrappable by the durable gate, driven by `stream()` / `generate()` as usual.
- **The tool name is the record key** in `agents`; the description is the sub-agent's
  `description` resolved per parent run (falling back to its `name`).
- **Delegation is stateless by default.** `delegation: { memory: { thread, resource } }` (or a
  function deriving the identity per call) opts a sub-agent's runs into its `Memory`; the thread
  policy stays the application's.
- **A failing sub-agent fails like any tool**: its error comes back as an error tool result and the
  parent's model replans — the run does not abort.
- The script consumes `@oribos/core` and `@oribos/supervisor` through their built package exports —
  run `pnpm build` before `start`.
