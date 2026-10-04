import type { JsonSchemaObject } from './model/contract.js';
import type { StandardSchema, StandardSchemaV1 } from './standard-schema.js';

/**
 * The runtime companion of the schema contract (`standard-schema.ts`, ADR-0003): every boundary
 * that validates with a Standard Schema — the agent loop's tool boundary, the run's structured
 * output — runs that validation through here, and every boundary that hands a schema to a model
 * asks this module for its JSON Schema. One implementation keeps the answer the same everywhere.
 *
 * Internal seam — not exported from any entry. Consumers: tool input / output schema validation
 * and structured output; `messageOf` also serves every boundary that reports a thrown value (the
 * tracer's span errors, the fallback chain's failure messages).
 */

/** A validation outcome: the schema's value, or the issues that rejected the input. */
export type Validation =
  | { readonly value: unknown }
  | { readonly issues: readonly StandardSchemaV1.Issue[] };

/**
 * Runs one Standard Schema validation. A vendor that throws instead of reporting issues becomes a
 * single issue carrying its message — the boundary reports a rejected input either way, never a
 * crash of the vendor's own making.
 */
export async function validateSchema(schema: StandardSchema, value: unknown): Promise<Validation> {
  try {
    const result = await schema['~standard'].validate(value);
    if (result.issues === undefined) return { value: result.value };
    return { issues: result.issues };
  } catch (error) {
    return { issues: [{ message: messageOf(error) }] };
  }
}

/**
 * The JSON Schema a model receives for a schema: asked for through the Standard JSON Schema
 * interface, the draft-07 target (the model contract's `JsonSchema` subset), and passed through
 * unchanged — the converter's `Record<string, unknown>` result is cast without a shape check,
 * because ADR-0003 makes emitting valid draft-07 the vendor's contract: the core neither rewrites
 * nor re-validates schemas, and an invalid schema fails at the provider, not here.
 */
export function toJsonSchema(schema: StandardSchema): JsonSchemaObject {
  return schema['~standard'].jsonSchema.input({ target: 'draft-07' }) as JsonSchemaObject;
}

/** One readable line per issue, path first: `city: expected string, received number`. */
export function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues.map(formatIssue).join('; ');
}

/** The message of a thrown value — one extraction for every failure message the core composes. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = issue.path
    ?.map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');
  return path === undefined || path === '' ? issue.message : `${path}: ${issue.message}`;
}
