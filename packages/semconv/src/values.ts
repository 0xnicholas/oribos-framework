/**
 * Value-domain rules: OTel attributes
 * only carry primitives — primitives pass, primitive arrays pass with null/undefined members
 * stripped (an array stripped empty drops the attribute), anything else JSON-serializes to the
 * same key; a serialization failure drops the value and counts in `droppedAttributesCount`.
 * `undefined` never emits an attribute.
 */
import type { AttributeValue, Attributes } from '@opentelemetry/api';

/** One attribute collected with its value-domain fate. */
export interface CollectedAttribute {
  readonly key: string;
  readonly value: AttributeValue;
}

/** How many attributes a collected batch had to drop. */
export interface AttributeCollection {
  readonly attributes: CollectedAttribute[];
  dropped: number;
}

/** A primitive in OTel's attribute value domain. */
function isPrimitive(value: unknown): value is string | number | boolean {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/**
 * Converts one value to the OTel domain. Primitives pass as-is; arrays of primitives pass with
 * null/undefined members stripped — stripped empty means the whole attribute is dropped; objects
 * and everything else become their JSON text; JSON failures drop and count.
 */
export function collectAttribute(
  collector: AttributeCollection,
  key: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (isPrimitive(value)) {
    collector.attributes.push({ key, value });
    return;
  }
  if (Array.isArray(value)) {
    // Primitive arrays pass with null/undefined members stripped; stripped empty drops the
    // attribute. Anything else an array holds makes it "any other value" → JSON text.
    const withoutHoles = value.filter((member) => member !== null && member !== undefined);
    if (withoutHoles.every(isPrimitive)) {
      if (withoutHoles.length === 0) return;
      // The API's `AttributeValue` models homogeneous arrays (string[] | number[] | boolean[]);
      // a mixed primitive array is valid OTLP — assert through the union.
      collector.attributes.push({ key, value: withoutHoles as AttributeValue });
      return;
    }
  }
  // Objects and other values: best-effort JSON text under the same key.
  try {
    collector.attributes.push({ key, value: JSON.stringify(value) });
  } catch {
    collector.dropped++;
  }
}

/** The collected attributes as an OTel `Attributes` record. */
export function toAttributes(collected: AttributeCollection): Attributes {
  const attributes: Attributes = {};
  for (const { key, value } of collected.attributes) attributes[key] = value;
  return attributes;
}

/** Best-effort JSON text, or `undefined` when the value will not serialize. */
export function jsonTextOrUndefined(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort JSON text for `oribos.error.details`: `{}` is worse than nothing (an Error's own
 * properties are not enumerable), so an empty object also returns `undefined`.
 */
export function errorDetailsJson(details: unknown): string | undefined {
  const text = jsonTextOrUndefined(details);
  if (text === undefined || text === '{}') return undefined;
  return text;
}
