/**
 * `@oribos/semconv` — the GenAI semantic-convention mapping leaf package.
 *
 * Stateless pure parts shared by the OTLP exporter (`@oribos/otlp`) and the OTel bridge: the
 * seven-type span mapping (name / kind / attributes), the message payload conversion, and the
 * attribute value-domain rules. Decisions: ADR-0002 (leaf package edge), ADR-0009.
 */
export { mapSpan } from './mapping.js';
export type { MappedSpan } from './mapping.js';
export { messagesToPromptPayload, outputToMessages } from './messages.js';
export type { PromptPayload, SemconvMessage, SemconvPart } from './messages.js';
export { collectAttribute, errorDetailsJson, jsonTextOrUndefined, toAttributes } from './values.js';
export type { AttributeCollection, CollectedAttribute } from './values.js';
