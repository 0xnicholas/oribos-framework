/**
 * `@oribos/evals` — the evals / scorers capability package (CUT-AG1, ADR-0005): scorers consume a
 * run's public result surface (`steps` / `text` / `usage` / `finishReason`), at the two points the
 * public surface already offers — never through a new core seam.
 *
 * - **Standalone** (`scoreRun`): score a settled run after the fact. The run is accepted in either
 *   consumption style of the output object — `generate()`'s awaited values or `stream()`'s promise
 *   terminals — one code path, the output object's dual consumption.
 * - **Wired** (`createScorerProcessor`): a plain `Processor` (the only cross-cutting seam) that
 *   scores each completed step live, as `processOutputStep` hands it over, and delivers every
 *   outcome to the caller's `onScore` sink. Observe-only: it never returns a rewrite.
 *
 * Evals observe; they do not gate (a gate is a guardrail — a hand-written processor that rewrites
 * or throws). So a scorer's own failure never fails the run and never voids the batch: it lands as
 * an `ok: false` outcome carrying the error. The sink is user code — an `onScore` throw propagates
 * as an ordinary processor failure (the run's failure, processors.ts semantics).
 *
 * Package face: [`scoreRun`], [`createScorerProcessor`], [`Scorer`], [`RunScorer`],
 * [`StepScorer`], [`Score`], [`RunScoreTarget`], [`StepScoreTarget`], [`ScorableRun`],
 * [`ScorerOutcome`], [`StepScorerOutcome`], [`ScorerProcessorConfig`].
 */
import type {
  AgentGenerateResult,
  AgentStep,
  ProcessOutputStepArgs,
  Processor,
} from '@oribos/core/agent';
import type { FinishReason, Usage } from '@oribos/core/model';

/**
 * What a scorer returns: the score itself plus an optional reason in the scorer's own words. The
 * value's range is the scorer's own contract (0..1 by convention); the package carries it
 * untouched. A return that is not a finite-number `value` (with a string `reason` when present) is
 * a scorer failure — it lands as an `ok: false` outcome, exactly like a throw.
 */
export interface Score {
  readonly value: number;
  readonly reason?: string;
}

/**
 * The scorer: one plain object parameterized by its target — a name plus `score`. Like a tool, a
 * handwritten literal needs no factory; the two target kinds below are the two consumption points
 * (a settled run, or one completed step inside a live run).
 */
export interface Scorer<TTarget> {
  /** Identity of the scorer — the `scorer` field of every outcome it produces. */
  readonly name: string;
  score(target: TTarget): Score | Promise<Score>;
}

/**
 * What a run scorer scores: the run's terminal public surface — final text, per-step records,
 * accumulated usage, and why the run stopped (a truncated run scores differently from a clean one).
 * Structurally a `Pick` of `AgentGenerateResult`, so a settled result is handed over as-is.
 */
export type RunScoreTarget = Pick<AgentGenerateResult, 'text' | 'steps' | 'usage' | 'finishReason'>;

/**
 * What a step scorer scores: exactly what the `processOutputStep` hook is handed — the completed
 * step's record, its position, and the run's request context. Nothing is re-shaped: the wiring
 * passes the hook's arguments through untouched.
 */
export type StepScoreTarget = ProcessOutputStepArgs;

/** A scorer of a settled run — the standalone half, run by [`scoreRun`]. */
export type RunScorer = Scorer<RunScoreTarget>;

/** A scorer of one completed step — the wired half, run by [`createScorerProcessor`]. */
export type StepScorer = Scorer<StepScoreTarget>;

/**
 * The run [`scoreRun`] accepts: the terminal surface in either consumption style of the output
 * object — `AgentGenerateResult`'s plain values or `AgentStreamResult`'s promise terminals
 * (`await` serves both). Extra properties (`object`, `toolCalls`, …) pass through ignored.
 */
export interface ScorableRun {
  readonly text: string | Promise<string>;
  readonly steps: readonly AgentStep[] | Promise<readonly AgentStep[]>;
  readonly usage: Usage | Promise<Usage>;
  readonly finishReason: FinishReason | Promise<FinishReason>;
}

/**
 * One scorer's outcome: the score on success, the error on failure — discriminated by `ok`, so a
 * scoreboard never confuses the two. A scorer failure (a throw, or a malformed score) is reported
 * here, never thrown by the package's own machinery.
 */
export type ScorerOutcome =
  | { readonly scorer: string; readonly ok: true; readonly score: Score }
  | { readonly scorer: string; readonly ok: false; readonly error: unknown };

/** A wired outcome: the scorer's outcome plus the step it belongs to. */
export type StepScorerOutcome = ScorerOutcome & { readonly stepIndex: number };

/** `createScorerProcessor`'s config: the step scorers and the sink every outcome lands in. */
export interface ScorerProcessorConfig {
  /** The scorers each completed step is scored with, in declaration order. At least one. */
  readonly scorers: readonly StepScorer[];
  /**
   * Where every outcome lands, in declaration order per step. User code: a throw propagates as an
   * ordinary processor failure — the run's failure (evals observe, but the sink is the caller's).
   */
  readonly onScore: (outcome: StepScorerOutcome) => void | Promise<void>;
}

/** Runs one scorer over one target, framing whatever happens as an outcome. */
async function runScorer<TTarget>(
  scorer: Scorer<TTarget>,
  target: TTarget,
): Promise<ScorerOutcome> {
  try {
    return { scorer: scorer.name, ok: true, score: validateScore(scorer.name, await scorer.score(target)) };
  } catch (error) {
    return { scorer: scorer.name, ok: false, error };
  }
}

/** The score contract's runtime check — a malformed return is a scorer failure, not bad data. */
function validateScore(name: string, raw: Score): Score {
  const fail = (why: string): Error =>
    new Error(
      `scorer '${name}' returned an invalid score — a scorer returns \`{ value: number, ` +
        `reason?: string }\` with a finite value; ${why}.`,
    );
  if (typeof raw !== 'object' || raw === null || !Number.isFinite(raw.value)) {
    throw fail(`got ${typeof raw === 'object' && raw !== null ? `value ${String(raw.value)}` : String(raw)}`);
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    throw fail('`reason` must be a string when present');
  }
  return raw.reason === undefined ? { value: raw.value } : { value: raw.value, reason: raw.reason };
}

/**
 * Scores a settled run with every run scorer, in declaration order, and returns one outcome per
 * scorer. The run is consumed through its public terminal surface only — either consumption style
 * of the output object. Scorers run concurrently; a scorer's failure is captured in its outcome
 * (`ok: false`) and never voids the batch. An empty `scorers` scores nothing: `[]`.
 */
export async function scoreRun(
  run: ScorableRun,
  scorers: readonly RunScorer[],
): Promise<readonly ScorerOutcome[]> {
  const target: RunScoreTarget = {
    text: await run.text,
    steps: await run.steps,
    usage: await run.usage,
    finishReason: await run.finishReason,
  };
  return Promise.all(scorers.map((scorer) => runScorer(scorer, target)));
}

/**
 * Wires step scorers into a live run: a plain `Processor` for `AgentConfig.processors` whose
 * `processOutputStep` scores each completed step with every scorer (declaration order) and awaits
 * the sink per outcome. Observe-only — it returns no rewrite, so the run's records are untouched.
 * A scorer's failure lands in the sink as an `ok: false` outcome; the run continues.
 */
export function createScorerProcessor(config: ScorerProcessorConfig): Processor {
  if (config.scorers.length === 0) {
    throw new Error(
      'createScorerProcessor: `scorers` must name at least one scorer — a processor with none ' +
        'adds a hook that only observes.',
    );
  }
  if (typeof config.onScore !== 'function') {
    throw new Error(
      'createScorerProcessor: `onScore` must be a function — the sink every outcome lands in.',
    );
  }
  const { scorers, onScore } = config;
  return {
    processOutputStep: async (args) => {
      for (const scorer of scorers) {
        const outcome = await runScorer(scorer, args);
        await onScore({ ...outcome, stepIndex: args.stepIndex });
      }
    },
  };
}
