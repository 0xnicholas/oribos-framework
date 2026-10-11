# cron-schedule

One cron expression, from the host's definition to a fired run: `@oribos/croner`'s `cron()` returns
exactly the `next` + `timezone` fragment `schedules.save()` takes, the occurrence function walks the
schedule as pure computation, and `tick` fires what is due and advances the record. Oribos is an
TypeScript agent framework with zero runtime dependencies — compose only what you use, run
anywhere.

The example is a single file (`src/index.ts`) with a fixed script — no interactive input, **no API
key and no network** (the reporting agent runs on a scripted model defined in the file). Five acts:

1. **Save: the fragment slots straight in.** `{ ...cron('0 9 * * *', { timezone: 'Asia/Shanghai' }),
   target }` is structurally the slice `ScheduleSaveInput` takes. The record comes back with
   `nextFireAt` at 01:00 UTC (09:00 Shanghai) and the timezone; the expression itself is asserted
   **absent from the record** — it lives here, in the host's definition.
2. **`next` advances as pure computation.** The occurrence function is asked for the first
   occurrence strictly after a moment and walks the schedule forward — no ticker, no timer, no
   long-lived process.
3. **`tick` fires when due.** A tick one millisecond early is a no-op. At the due instant the
   threadless target runs the agent (`agents['reporter'].generate(input)`) — one `agent-run` span,
   and no span for the tick itself — and the record re-anchors to the following occurrence (+24h).
4. **The failure face is the call site.** A bad expression (`TypeError`), a bad value (`RangeError`)
   and a bad IANA timezone all throw from `cron()`. The timezone is probed at construction because
   croner would defer it to the first `nextRun`; after construction `next` never throws.
5. **DST passes through as-is.** The pinned croner's spring-forward gap behavior (02:30 maps to
   03:30 CEST) and fall-back overlap behavior (only the first occurrence) are printed — recorded as
   observed, not compensated.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @oribos/core and @oribos/croner through their package exports (dist)
pnpm --filter @oribos/example-cron-schedule start
```

Expected output: the fragment's shape and the saved record, three occurrences walked from a fixed
`from`, two tick beats each firing one report run and advancing `nextFireAt` by one day, the three
error lines, and the two DST facts. The script **asserts its own payoff** — a record that carries
the expression, an occurrence off the 01:00 UTC mark, a tick that fires early or fails to advance,
an error that fails to surface at `cron()` — each exits non-zero instead of printing a happy face.

## Notes

- **The expression is not in the record.** `save()` stores `timezone` plus the computed
  `nextFireAt`; the pattern stays with the host, paired to the record by id in-process. Re-register
  your definitions at boot (one `save()` each) and the definition you hold is authoritative.
- **`tick` is the whole runtime.** In production the platform cron (Cloudflare Cron Triggers,
  Vercel Cron, …) hits an endpoint that calls `tick()`; `startTicker({ intervalMs })` is the
  optional in-process convenience. This example calls `tick({ now })` explicitly so the demo is
  deterministic on any machine.
- **Timezone default.** With no `timezone` option the expression is read in the process's own
  timezone (croner's default). The example always passes one so its output does not depend on where
  it runs.
- The script consumes `@oribos/croner` and `@oribos/core` through their built package exports — run
  `pnpm build` before `start`. Package docs: [`packages/croner`](../../packages/croner/) — the croner
  wrapper capability package.
