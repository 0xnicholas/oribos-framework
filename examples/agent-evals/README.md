# agent-evals

Scorers consuming a run's public result surface — the evals capability of `@oribos/evals` at both
of its consumption points: `createScorerProcessor` wires per-step scorers into a live run through
the Processor seam (observe-only), and `scoreRun` scores the settled run after the fact. Oribos is
a TypeScript agent framework with zero runtime dependencies — compose only what you use, run
anywhere.

The example is a single file (`src/index.ts`) with a scripted model stub — no interactive input,
**no API key and no network**. A support-desk agent answers an order-status question with its
`lookupOrder` tool. Four acts:

1. **Live per-step scoring.** Two step scorers (`focused-step`, `progressing-step`) wired via
   `createScorerProcessor` score every completed step as it lands; the run itself is untouched.
2. **Whole-run scoring after the fact.** `scoreRun` scores the settled `generate()` result —
   `names-the-order`, `clean-finish`, `frugal` read `text` / `finishReason` / `usage` off the
   public result.
3. **A brittle scorer is isolated.** A scorer that throws lands as an `ok: false` outcome carrying
   the error — the live run still finishes `'stop'`, and the post-hoc batch keeps its healthy
   scores.
4. **The stream scores too.** `scoreRun` accepts the `stream()` output object as-is: the output
   object's two consumption styles are one code path.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/* through their package exports (dist)
pnpm --filter @oribos/example-agent-evals start
```

Expected output: the four per-step live outcomes, the three whole-run scores, the isolated
`brittle-judge` failure next to an undisturbed run and batch, and the stream's scores. The script
**asserts its own payoff** — a scorer that misses the tool call, an outcome attributed to the wrong
step, a run disturbed by its observers, or a brittle scorer taking the batch down with it — each
exits non-zero instead of printing a happy face.

## Notes

- **A scorer is a plain object** — `name` plus `score(target)`. `RunScorer` sees the run's terminal
  surface (`text` / `steps` / `usage` / `finishReason`); `StepScorer` sees exactly what the
  `processOutputStep` hook is handed. No factory needed; both are consumed by the package's two
  entry points.
- **Evals observe; they do not gate.** A scorer's failure never fails the run — it lands in the
  sink as an `ok: false` outcome. A gate is a guardrail: a hand-written processor that rewrites or
  throws.
- **The package depends on nothing.** `@oribos/core` is a **peer** (`workspace:^`): everything here
  is composed over the core's public surface (`Processor`, the output object's terminal values), so
  the core stays the single instance the host application owns.
- The script consumes `@oribos/core` and `@oribos/evals` through their built package exports —
  run `pnpm build` before `start`.
