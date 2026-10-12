/**
 * `@oribos/core/model` — model layer.
 *
 * The model contract (a minimal vendor subset of the AI SDK provider spec) and the chunk protocol,
 * plus the thin normalization layer that turns a model-native stream into chunks of the core's own
 * vocabulary.
 *
 * Decisions: ADR-0004.
 */
export type {
  JsonObject,
  JsonSchema,
  JsonSchemaObject,
  JsonSchemaTypeName,
  JsonSchemaValue,
  JsonValue,
  Model,
  ModelCallOptions,
  ModelContent,
  ModelCustomContent,
  ModelCustomPart,
  ModelFileContent,
  ModelFileData,
  ModelFilePart,
  ModelFinishReason,
  ModelFunctionTool,
  ModelGenerateResult,
  ModelMessage,
  ModelPrompt,
  ModelProviderMetadata,
  ModelProviderOptions,
  ModelProviderReference,
  ModelProviderTool,
  ModelReasoningContent,
  ModelReasoningFileContent,
  ModelReasoningFilePart,
  ModelReasoningPart,
  ModelResponseMetadata,
  ModelSourceContent,
  ModelStreamPart,
  ModelStreamResult,
  ModelTextContent,
  ModelTextPart,
  ModelToolApprovalRequest,
  ModelToolApprovalResponsePart,
  ModelToolCallContent,
  ModelToolCallPart,
  ModelToolChoice,
  ModelToolResultContent,
  ModelToolResultOutput,
  ModelToolResultPart,
  ModelUsage,
  ModelWarning,
} from './contract.js';
export { MODEL_SPECIFICATION_VERSION, ModelContractError, ModelSpecificationVersionError, assertModel } from './resolve.js';
export { ModelFallbackError } from './fallback.js';
export type { ModelFallbackFailure } from './fallback.js';
export type {
  Chunk,
  DeltaEmission,
  FinishChunk,
  FinishReason,
  ReasoningDeltaChunk,
  TextDeltaChunk,
  ToolCallChunk,
  ToolInputDeltaChunk,
  ToolInputEndChunk,
  ToolInputStartChunk,
  ToolResultChunk,
  Usage,
} from './chunks.js';
export { normalizePart, normalizeStream } from './normalize.js';
