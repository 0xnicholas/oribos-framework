import type { DynamicArgument } from '../agent/types.js';
import type { WorkflowIterationSite } from './snapshot.js';
import type { Step, StepContext } from './step.js';

/**
 * The flat entry list (workflow definitions and the builder): every builder
 * operator pushes one `{ type, … }` entry, and the walker is a `for` loop over this array — there
 * is no DAG. The entries carry the definition's child steps; execution semantics live in the
 * walker (`walker.ts`), not here.
 *
 * Conditions and dynamic durations are authored against the current chain tip (typed at the
 * builder seam) and erased into these runtime entries; the walker calls them with the live
 * context.
 */

/**
 * A branch condition (control-flow operators): the same parameter bag a
 * step's `execute` receives, read-only in spirit; branches are evaluated in definition order and
 * the first truthy one runs.
 */
export type BranchCondition<TInputData = unknown> = (
  ctx: StepContext<TInputData>,
) => boolean | Promise<boolean>;

/**
 * A loop condition: the branch-condition bag plus `iterationCount` — the number of iterations
 * already completed — so a condition can cap the loop by throwing or by counting
 * (control-flow operators). Its `inputData` is the value of the checkpoint:
 * the pending input for `dowhile` (checked before each iteration), the last output for `dountil`
 * (checked after each iteration).
 */
export type LoopCondition<TInputData = unknown> = (
  ctx: StepContext<TInputData> & { readonly iterationCount: number },
) => boolean | Promise<boolean>;

/**
 * A sleep duration: milliseconds, or a `DynamicArgument` resolver — the framework's dynamic
 * argument convention, resolved once per sleep entry against the run's request context so the
 * `signal` reaches it. The tip is not visible to it: a delay consumes and
 * produces no value.
 */
export type SleepDuration = DynamicArgument<number>;

/** `.then(step)`: run the step; its output pipes to the next entry. */
export interface ThenEntry {
  readonly type: 'then';
  readonly step: Step;
}

/** `.parallel([a, b])`: run the steps concurrently (`Promise.all`), collect `{ [step.id]: output }`. */
export interface ParallelEntry {
  readonly type: 'parallel';
  readonly steps: readonly Step[];
}

/** One authored branch pair: `[condition, step]`. */
export type BranchPair = readonly [BranchCondition, Step];

/** `.branch([[cond, step], …])`: first truthy condition runs; the output is a keyed object with one value (`{}` when nothing matched). */
export interface BranchEntry {
  readonly type: 'branch';
  readonly branches: readonly BranchPair[];
}

/** `.foreach(step, { concurrency })`: run the step over the input array; `concurrency` defaults to 1. */
export interface ForeachEntry {
  readonly type: 'foreach';
  readonly step: Step;
  /**
   * Concurrency cap (gate width), resolved at definition time — `1` when the options were omitted;
   * the builder rejects a cap that is not an integer ≥ 1.
   */
  readonly concurrency: number;
}

/** `.dowhile(step, cond)`: condition before each iteration (false at the tip = zero iterations); output = the last iteration's output. */
export interface DowhileEntry {
  readonly type: 'dowhile';
  readonly step: Step;
  readonly cond: LoopCondition;
}

/** `.dountil(step, cond)`: condition after each iteration (so it runs at least once); output = the last iteration's output. */
export interface DountilEntry {
  readonly type: 'dountil';
  readonly step: Step;
  readonly cond: LoopCondition;
}

/** `.sleep(ms | fn)`: in-process `setTimeout` + `AbortSignal`, not durable. */
export interface SleepEntry {
  readonly type: 'sleep';
  readonly duration: SleepDuration;
}

/** The flat definition list a committed workflow walks. */
export type WorkflowEntry =
  | ThenEntry
  | ParallelEntry
  | BranchEntry
  | ForeachEntry
  | DowhileEntry
  | DountilEntry
  | SleepEntry;

/**
 * The discriminant of the walker's replay-builder table: the rebuild itself (which records a shape
 * reads and what it returns) lives there, beside the record reader. Every shape needs a rebuilder
 * (a new one is a compile error); every descriptor row picks one of these.
 */
export type ReplayShape = 'single' | 'parallel' | 'branch' | 'pass';

/**
 * One row of the per-kind table: every static fact about an entry kind, declared once. Execution —
 * which runner, which walk state, which span — deliberately stays in the walker; a row is data plus
 * the extraction function, never a walk.
 */
export interface EntryDescriptor<TEntry extends WorkflowEntry> {
  /** The steps the entry owns, in definition order — the record keys the entry can write. */
  readonly steps: (entry: TEntry) => readonly Step[];
  /** The replay shape the walker's rebuilders are keyed by — declared here, executed there. */
  readonly replayShape: ReplayShape;
  /**
   * The arrays commit freezes, nested ones before the array that holds them: `parallel`'s steps
   * array, `branch`'s branches array and each authored pair — nothing for the other five kinds
   * (`then` / `foreach` / `dowhile` / `dountil` / `sleep` own no array of their own).
   */
  readonly ownedArrays: (entry: TEntry) => readonly (readonly unknown[])[];
  /**
   * The iteration site a suspension inside this kind carries: `parallel` / `branch` / `foreach`
   * each name themselves, both loop kinds map to `loop` (their site payload differs, the kind does
   * not), and `then` / `sleep` carry none (a top-level suspension and a step-less entry have no
   * site). `checkIterationSite` compares a resumed snapshot's site against this column alone.
   */
  readonly iterationSiteKind: WorkflowIterationSite['kind'] | undefined;
  /**
   * Where this kind's loop condition is checked — `dowhile` before an iteration, `dountil` after
   * one, absent for the other five kinds. `runLoop` reads this column instead of branching on the
   * entry type.
   */
  readonly loopTiming: 'before' | 'after' | undefined;
}

/** The closed union's discriminant. */
type WorkflowEntryKind = WorkflowEntry['type'];

/** The entry type of one kind (the table's row type is keyed by the discriminant). */
type EntryOf<TKind extends WorkflowEntryKind> = Extract<WorkflowEntry, { readonly type: TKind }>;

/** One row per kind: `satisfies` makes a missing or mistyped row a compile error. */
type DescriptorTable = {
  readonly [TKind in WorkflowEntryKind]: EntryDescriptor<EntryOf<TKind>>;
};

/**
 * The per-kind facts, keyed by the closed union: the single source of truth for what a kind owns,
 * how it replays, which arrays it freezes, which iteration site it carries and when its loop
 * checks. `satisfies` over the mapped type makes an eighth kind without a row a compile error.
 */
const ENTRY_DESCRIPTORS = {
  then: {
    steps: (entry: ThenEntry) => [entry.step],
    replayShape: 'single',
    ownedArrays: () => [],
    iterationSiteKind: undefined,
    loopTiming: undefined,
  },
  parallel: {
    steps: (entry: ParallelEntry) => entry.steps,
    replayShape: 'parallel',
    ownedArrays: (entry: ParallelEntry) => [entry.steps],
    iterationSiteKind: 'parallel',
    loopTiming: undefined,
  },
  branch: {
    steps: (entry: BranchEntry) => entry.branches.map(([, step]) => step),
    replayShape: 'branch',
    ownedArrays: (entry: BranchEntry) => [
      ...entry.branches.map((pair) => pair),
      entry.branches,
    ],
    iterationSiteKind: 'branch',
    loopTiming: undefined,
  },
  foreach: {
    steps: (entry: ForeachEntry) => [entry.step],
    replayShape: 'single',
    ownedArrays: () => [],
    iterationSiteKind: 'foreach',
    loopTiming: undefined,
  },
  dowhile: {
    steps: (entry: DowhileEntry) => [entry.step],
    replayShape: 'single',
    ownedArrays: () => [],
    iterationSiteKind: 'loop',
    loopTiming: 'before',
  },
  dountil: {
    steps: (entry: DountilEntry) => [entry.step],
    replayShape: 'single',
    ownedArrays: () => [],
    iterationSiteKind: 'loop',
    loopTiming: 'after',
  },
  sleep: {
    steps: () => [],
    replayShape: 'pass',
    ownedArrays: () => [],
    iterationSiteKind: undefined,
    loopTiming: undefined,
  },
} satisfies DescriptorTable;

/**
 * The one table lookup. A hand-built definition cast past the types has no row — that is the
 * contract boundary and fails loudly, never silently as "owns no steps". The workflow id is
 * required here (the public answer function is the only caller that may not know it) so a new
 * internal call site cannot regress to an unnamed error.
 */
export function entryDescriptor(
  entry: WorkflowEntry,
  workflowId: string | undefined,
): EntryDescriptor<WorkflowEntry> {
  const descriptor = (
    ENTRY_DESCRIPTORS as Partial<Record<WorkflowEntryKind, EntryDescriptor<WorkflowEntry>>>
  )[entry.type];
  if (descriptor === undefined) {
    const { type } = entry as unknown as { readonly type: string };
    throw new Error(unknownEntryKindMessage(type, workflowId));
  }
  return descriptor;
}

/** The unknown-kind message at the one boundary that knows it: the kind always, the workflow when named. */
export function unknownEntryKindMessage(type: string, workflowId: string | undefined): string {
  const prefix = workflowId === undefined ? '' : `workflow "${workflowId}": `;
  return `${prefix}unknown workflow entry type "${type}"`;
}

/**
 * The steps an entry owns, in definition order — the one extraction every topology fact and every
 * record reader goes through: membership, replay, truncation, freezing and restart targeting.
 * A `sleep` owns none: it records nothing. `workflowId` only names the definition in the
 * unknown-kind error, which is why every internal caller passes it.
 */
export function steps(entry: WorkflowEntry, workflowId: string | undefined): readonly Step[] {
  return entryDescriptor(entry, workflowId).steps(entry);
}

/**
 * The step ids an entry owns — the record keys the entry can write. Restart targeting and
 * truncation both speak in this grain: the flat entry is the addressable unit (no path model), so
 * a step inside a block is reached through its entry, and truncating an entry drops every record
 * the entry owns.
 */
export function entryStepIds(
  entry: WorkflowEntry,
  workflowId: string | undefined,
): readonly string[] {
  return steps(entry, workflowId).map((step) => step.id);
}

/** The step with this id inside the entry, or `undefined` when the entry holds no such step. */
export function findStep(
  entry: WorkflowEntry,
  stepId: string,
  workflowId: string | undefined,
): Step | undefined {
  return steps(entry, workflowId).find((step) => step.id === stepId);
}

/**
 * The step id a runner should restart from when a snapshot's `position` points into this entry
 * list: the first step of the nearest entry at or before the position that owns one, or
 * `undefined` when there is none — the caller restarts from the beginning (not a failure).
 *
 * The position is clamped to `[0, entries.length - 1]`, so a terminal `success` snapshot
 * (`position === entries.length`) still answers. Scanning is backward: a crash right before a
 * trailing `sleep`, which owns no step, restarts from the nearest step-bearing entry. Step ids
 * shared across entries are not resolved here — the public `restart` names the first entry
 * holding the id, so restart re-executes more, never less. Snapshot status is not read; the
 * caller owns that reading. An unknown entry kind throws instead of answering "no target" —
 * naming the workflow (when its id is known) and the kind, never a `TypeError` and never silence.
 */
export function restartTargetAt(
  workflow: { readonly id?: string; readonly entries: readonly WorkflowEntry[] },
  position: number,
): string | undefined {
  const { entries } = workflow;
  if (entries.length === 0) return undefined;
  const start = Math.min(Math.max(position, 0), entries.length - 1);
  for (let index = start; index >= 0; index -= 1) {
    const stepId = steps(entries[index]!, workflow.id)[0]?.id;
    if (stepId !== undefined) return stepId;
  }
  return undefined;
}
