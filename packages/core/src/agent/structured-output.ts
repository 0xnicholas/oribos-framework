import type { ModelCallOptions } from '../model/contract.js';
import type { StandardSchemaV1 } from '../standard-schema.js';
import { formatIssues, messageOf, toJsonSchema, validateSchema } from '../standard-schema-runtime.js';
import type { StructuredOutputConfig } from './types.js';

/**
 * The structured-output feature (execution semantics, run option
 * `structuredOutput: { schema }`): one schema does two jobs at the two ends of the run.
 *
 * - **Down**: the schema's JSON Schema (`~standard.jsonSchema`, the draft-07 target — the same
 *   conversion tool schemas go through) rides on **every** model call of the run as
 *   `responseFormat`, so the provider is told the shape to answer in.
 * - **Up**: the run's terminal text — the last step's authoritative record, processors' rewrites
 *   included — is parsed as JSON and validated, and the schema's value settles the run's `object`.
 *   Validation belongs to a completed run: a run suspended at a step boundary has no final answer
 *   yet, so it settles with `object: undefined` and skips validation (ADR-0019).
 *
 * Strict is the only strategy: an answer that is not JSON, or does not match the schema, fails the
 * run with `StructuredOutputError`. There is no `errorStrategy`, no repair round trip, no silent
 * fallback to raw text.
 */

/**
 * Thrown when a run asked for `structuredOutput` and its terminal text did not become the schema's
 * value — strict, the only validation strategy (execution semantics): a model
 * that ignores the requested shape fails the run instead of silently answering something else.
 *
 * The run's terminal text is kept unparsed (`text`), so the caller can see what the model actually
 * answered; `issues` carries the schema's issues when the text was JSON but did not match, and is
 * `undefined` when the text was not JSON at all (`cause` then holds the parse error).
 */
export class StructuredOutputError extends Error {
  /** The run's terminal text, unparsed — what the model actually answered. */
  readonly text: string;
  /** The schema's issues, when the text was valid JSON that did not match; else `undefined`. */
  readonly issues: readonly StandardSchemaV1.Issue[] | undefined;

  constructor(
    message: string,
    details: {
      /** The run's terminal text the validation rejected. */
      readonly text: string;
      /** The schema's issues of a text that was JSON but did not match. */
      readonly issues?: readonly StandardSchemaV1.Issue[] | undefined;
      /** The parse error, when the text was not JSON at all. */
      readonly cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'StructuredOutputError';
    this.text = details.text;
    this.issues = details.issues;
  }
}

/**
 * The `responseFormat` every model call of a structured run carries: the schema asked for its JSON
 * Schema (draft-07, like tool schemas) and passes it through unchanged (ADR-0003 — the core
 * neither rewrites nor re-validates schemas). How a provider turns that into its own
 * structured-output mode is the provider's business.
 */
export function toStructuredResponseFormat(
  config: StructuredOutputConfig,
): NonNullable<ModelCallOptions['responseFormat']> {
  return { type: 'json', schema: toJsonSchema(config.schema) };
}

/**
 * Turns the run's terminal text into its structured value: JSON parse, then schema validation. Both
 * failures are the same explicit error — the value of a structured run is the schema's output, so a
 * text that is not JSON is no more acceptable than a JSON object of the wrong shape.
 */
export async function toStructuredObject(
  config: StructuredOutputConfig,
  text: string,
): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StructuredOutputError(
      'The model\'s final answer is not valid JSON, so it cannot be validated against the ' +
        `structured output schema: ${messageOf(error)}.`,
      { text, cause: error },
    );
  }

  const validation = await validateSchema(config.schema, parsed);
  if ('issues' in validation) {
    throw new StructuredOutputError(
      `The model's final answer does not match the structured output schema: ${formatIssues(validation.issues)}.`,
      { text, issues: validation.issues },
    );
  }
  return validation.value;
}
