import type { Model } from './contract.js';
import { ModelContractError, assertModel } from './resolve.js';
import { messageOf } from '../standard-schema-runtime.js';

/**
 * The model fallback chain (the accepted `model` shapes): an array of models
 * tried in order, accepted anywhere the `model` field is — as a static value or returned by a
 * dynamic argument.
 *
 * The switching decision lives where the chunks are: the agent loop tries the chain in array order
 * on every model call, and abandons a candidate for the next one only when it fails before
 * producing any chunk. A failure mid-stream propagates instead — partial output has already
 * reached the caller, and switching would splice two models' answers together. Errors are kept per
 * link, so a chain that failed everywhere reports every candidate's own error.
 */

/**
 * Asserts that a fallback chain is usable and returns it unchanged: non-empty, and every element
 * satisfying the model contract. Runs at resolution time, like `assertModel` — a bad candidate
 * fails when the field is resolved, never mid-run.
 */
export function assertModelChain(chain: readonly Model[]): readonly Model[] {
  if (chain.length === 0) {
    throw new ModelContractError(
      'The model fallback chain is empty: an array model field must hold at least one language model.',
    );
  }
  for (const model of chain) assertModel(model);
  return chain;
}

/** One failed model attempt of a fallback chain: which candidate failed, and what it raised. */
export interface ModelFallbackFailure {
  /** The candidate that failed; `provider` / `modelId` identify it in the chain error's message. */
  readonly model: Model;
  /** The candidate's own error, untouched — its `cause` chain stays intact. */
  readonly error: unknown;
}

/**
 * Thrown when a model call failed on every candidate of the fallback chain, each candidate failing
 * before it produced any chunk.
 *
 * The chain's context is preserved twice over: the message names every candidate and its error,
 * and `failures` carries the original errors in chain order. `cause` is the last attempt's error —
 * the failure the run ultimately ended with.
 */
export class ModelFallbackError extends Error {
  /** Every failed attempt, in chain order. */
  readonly failures: readonly ModelFallbackFailure[];

  constructor(failures: readonly ModelFallbackFailure[]) {
    super(chainFailureMessage(failures), { cause: failures[failures.length - 1]?.error });
    this.name = 'ModelFallbackError';
    this.failures = failures;
  }
}

/**
 * The failure a model call ends with when it walked the whole chain without success: the original
 * error when there was nothing to fall back to (one candidate), the chain error when there was.
 */
export function modelChainExhausted(failures: readonly ModelFallbackFailure[]): unknown {
  const [only] = failures;
  return failures.length === 1 && only !== undefined ? only.error : new ModelFallbackError(failures);
}

function chainFailureMessage(failures: readonly ModelFallbackFailure[]): string {
  const links = failures
    .map((failure) => `${identify(failure.model)}: ${messageOf(failure.error)}`)
    .join('; ');
  return (
    `All ${failures.length} ${failures.length === 1 ? 'model' : 'models'} of the fallback chain ` +
    `failed before producing a chunk: ${links}.`
  );
}

function identify(model: Model): string {
  return `'${model.provider}/${model.modelId}'`;
}
