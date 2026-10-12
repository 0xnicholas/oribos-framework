# `@oribos/evals`

Evals / scorers for [Oribos](https://github.com/0xnicholas/oribos-framework): scorers consume a
run's public result surface (`steps` / `text` / `usage` / `finishReason`) at the two points that
surface already offers — `scoreRun()` scores a settled run standalone, and
`createScorerProcessor()` wires per-step scorers into a live run through the
[Processor seam](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/agent.md),
the agent's only cross-cutting extension point. The core gains no seam.

```ts
import { createScorerProcessor, scoreRun } from '@oribos/evals';

const focusedStep = {
  name: 'focused-step',
  score: ({ step }) => ({ value: step.toolCalls.length <= 1 ? 1 : 0 }),
};

const desk = new Agent({
  // …name / instructions / model / tools…
  processors: [
    createScorerProcessor({
      scorers: [focusedStep], // every completed step, scored as it lands
      onScore: (outcome) => scoreboard.push(outcome),
    }),
  ],
});

const result = await desk.generate('Where is order A-1007?');
const outcomes = await scoreRun(result, [
  {
    name: 'names-the-order',
    score: ({ text }) => ({ value: text.includes('A-1007') ? 1 : 0 }),
  },
]);
```

- Spec: [`docs/architecture/agent.md`](https://github.com/0xnicholas/oribos-framework/blob/main/docs/architecture/agent.md)「扩展点:Processor」(CUT-AG1 承载缝)
- Decisions: [ADR-0005](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0005-agent-core-surface.md) (Processor as the only cross-cutting point; evals stay off the definition surface); [ADR-0002](https://github.com/0xnicholas/oribos-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)
- Example: [`examples/agent-evals`](https://github.com/0xnicholas/oribos-framework/blob/main/examples/agent-evals) — live wiring, post-hoc scoring, failure isolation, the stream

## Install

```bash
npm install @oribos/evals @oribos/core
```

The package depends on nothing. `@oribos/core` is a **peer** (`workspace:^`): scorers are built
from the core's public surface (`Processor`, the output object's terminal values), so the core
stays the single instance the host application owns.

## The scoring contract

- **A scorer is a plain object** — `name` plus `score(target)`, no factory required. The two
  target kinds are the two consumption points: `RunScorer` sees the run's terminal surface
  (`text` / `steps` / `usage` / `finishReason`, a `Pick` of `AgentGenerateResult`); `StepScorer`
  sees exactly what the `processOutputStep` hook is handed (`step`, `stepIndex`,
  `requestContext`), passed through untouched.
- **A score is `{ value: number, reason?: string }`.** The range is the scorer's own contract
  (0..1 by convention). A malformed return — a non-finite `value`, a non-string `reason` — is a
  scorer failure, reported exactly like a throw.
- **Every outcome is reported, discriminated by `ok`.** `{ scorer, ok: true, score }` or
  `{ scorer, ok: false, error }` — a scoreboard never confuses the two. Wired outcomes also carry
  the `stepIndex` they belong to.
- **Evals observe; they do not gate.** A scorer's failure never fails the run and never voids the
  batch: it lands as an `ok: false` outcome. A gate is a guardrail — a hand-written processor that
  rewrites or throws. The sink is user code: an `onScore` throw propagates as an ordinary
  processor failure (the run's failure).
- **One run, both consumption styles.** `scoreRun` accepts `generate()`'s settled result or the
  `stream()` output object as-is (`await` serves plain values and promise terminals alike) — the
  output object's dual consumption, one code path.
- **Zero core changes, zero runtime dependencies.** Everything here is composed over the public
  surface; an app that never installs the package pays nothing.
