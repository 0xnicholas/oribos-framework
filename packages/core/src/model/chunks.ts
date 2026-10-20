/**
 * The chunk protocol — the core's own streaming vocabulary.
 *
 * `stream()` output, processors, workflow step snapshots and observability all share this minimal
 * set of events. The core never surfaces the AI SDK stream format: model-native streams are
 * normalized into chunks by `normalizeStream`, and conversions to external formats live in
 * interoperability capability packages (ADR-0004).
 *
 * The minimal set is four chunk types (`text-delta` / `tool-call` / `tool-result` / `finish`).
 * Two delta families — reasoning deltas and tool-input deltas — are additive and opt-in
 * (`DeltaEmission`): a run that asks for neither streams exactly the minimal set.
 */

/**
 * Why a model step finished.
 *
 * `'tool-calls'` is also the terminal reason when the agent loop hits its step cap while the model
 * still asks for tools; `'suspended'` is produced only by the step-boundary seam's suspend
 * decision (`AgentRunOptions.stepBoundary` — the durable approval gate's mechanism, or an explicit
 * gate on a bare run). Without that seam a bare agent run never ends with it.
 */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'error' | 'suspended';

/** Token usage of a model step (or accumulated over a run). */
export type Usage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
};

/** A piece of text that the model has generated. */
export type TextDeltaChunk = {
  type: 'text-delta';
  textDelta: string;
};

/**
 * A piece of reasoning (thinking) the model produced on the way to its answer. Streams only when
 * the run opts in (`DeltaEmission.reasoning`). Block boundaries are not carried — as with text,
 * consecutive deltas form one block and a converter synthesizes the boundary frames.
 */
export type ReasoningDeltaChunk = {
  type: 'reasoning-delta';
  reasoningDelta: string;
};

/** A tool call's input starting to stream in. Streams only when the run opts in (`DeltaEmission.toolInput`). */
export type ToolInputStartChunk = {
  type: 'tool-input-start';
  toolCallId: string;
  toolName: string;
};

/**
 * A piece of a tool call's stringified JSON input as it streams in (opt-in,
 * `DeltaEmission.toolInput`). The parsed `tool-call` chunk still follows — the deltas are a
 * preview, never the record.
 */
export type ToolInputDeltaChunk = {
  type: 'tool-input-delta';
  toolCallId: string;
  inputDelta: string;
};

/** A tool call's input stream closing (opt-in, `DeltaEmission.toolInput`). */
export type ToolInputEndChunk = {
  type: 'tool-input-end';
  toolCallId: string;
};

/** A tool call that the model has requested, with its input parsed from stringified JSON. */
export type ToolCallChunk = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** The result of a tool call (framework-executed or provider-executed). */
export type ToolResultChunk = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
};

/** The end of a model step. */
export type FinishChunk = {
  type: 'finish';
  finishReason: FinishReason;
  usage: Usage;
};

/** One chunk of the core's streaming protocol. */
export type Chunk =
  | TextDeltaChunk
  | ReasoningDeltaChunk
  | ToolCallChunk
  | ToolInputStartChunk
  | ToolInputDeltaChunk
  | ToolInputEndChunk
  | ToolResultChunk
  | FinishChunk;

/**
 * The opt-in emission switches of the two delta families (`AgentRunOptions.deltas`, handed to
 * `normalizeStream`): reasoning deltas and tool-input deltas are additive to the minimal protocol
 * and both default off — a run that opts into neither streams exactly `text-delta` / `tool-call` /
 * `tool-result` / `finish`, and a consumer that ignores the opt-in chunks is unaffected.
 */
export type DeltaEmission = {
  /** Stream the model's reasoning (thinking) as `reasoning-delta` chunks. */
  readonly reasoning?: boolean;
  /**
   * Stream tool-call input as it arrives: `tool-input-start` / `tool-input-delta` /
   * `tool-input-end` chunks ahead of each parsed `tool-call`.
   */
  readonly toolInput?: boolean;
};
