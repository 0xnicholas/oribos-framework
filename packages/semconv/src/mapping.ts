/**
 * The seven-type mapping contract:
 * every mapped span's name is rebuilt from its template, carries `gen_ai.operation.name` where the
 * type has one and `oribos.span.type` always; `agent-step` alone is CLIENT kind and carries the
 * request/usage/response attributes. Open types pass their name through untouched. GenAI semconv
 * keys are written as string literals on purpose — the constants package is incubating-only
 * (ADR-0009's reversibility asymmetry: key drift changes this package, never the core).
 */
import { SpanKind } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  MEMORY_RECALL_SPAN,
  MEMORY_SAVE_SPAN,
  TOOL_CALL_SPAN,
  WORKFLOW_RUN_SPAN,
  WORKFLOW_STEP_SPAN,
} from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';
import { messagesToPromptPayload, outputToMessages } from './messages.js';
import {
  collectAttribute,
  errorDetailsJson,
  jsonTextOrUndefined,
  toAttributes,
  type AttributeCollection,
} from './values.js';

/** The `agent-step` parameters whitelist: `modelSettings` keys → `gen_ai.request.*`. */
const PARAMETER_KEYS: Readonly<Record<string, string>> = {
  temperature: 'gen_ai.request.temperature',
  topP: 'gen_ai.request.top_p',
  topK: 'gen_ai.request.top_k',
  maxOutputTokens: 'gen_ai.request.max_tokens',
  stopSequences: 'gen_ai.request.stop_sequences',
  presencePenalty: 'gen_ai.request.presence_penalty',
  frequencyPenalty: 'gen_ai.request.frequency_penalty',
  seed: 'gen_ai.request.seed',
};

/** One mapped span: the rebuilt name, its kind, and its assembled attributes. */
export interface MappedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
}

function newCollection(): AttributeCollection {
  return { attributes: [], dropped: 0 };
}

/** `error.type`: the error object's `name` when there is one, `_OTHER` otherwise. */
function errorType(details: unknown): string {
  if (typeof details === 'object' && details !== null) {
    const name = (details as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return '_OTHER';
}

/** The failure attributes every errored span carries (status lives on the span, not here). */
function collectErrorAttributes(collector: AttributeCollection, span: ExportedSpan): void {
  if (span.error === undefined) return;
  collectAttribute(collector, 'error.type', errorType(span.error.details));
  const details = errorDetailsJson(span.error.details);
  if (details !== undefined) collectAttribute(collector, 'oribos.error.details', details);
}

/** The user's open bag: one `oribos.metadata` JSON-text attribute, never flattened. */
function collectMetadata(collector: AttributeCollection, span: ExportedSpan): void {
  if (span.metadata === undefined) return;
  const text = jsonTextOrUndefined(span.metadata);
  if (text === undefined || text === '{}') return;
  collectAttribute(collector, 'oribos.metadata', text);
}

/** Maps one span per the contract. */
export function mapSpan(span: ExportedSpan): MappedSpan {
  const collector = newCollection();
  const bag = (span.attributes ?? {}) as Record<string, unknown>;
  const consumed = new Set<string>();
  let name = span.name;
  let kind = SpanKind.INTERNAL;

  const bagString = (key: string, fallback: string): string => {
    consumed.add(key);
    const value = bag[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };

  switch (span.type) {
    case AGENT_RUN_SPAN: {
      name = `invoke_agent ${bagString('agentName', span.name)}`;
      collectAttribute(collector, 'gen_ai.operation.name', 'invoke_agent');
      collectAttribute(collector, 'gen_ai.agent.name', bagString('agentName', span.name));
      if (bag.runId !== undefined) {
        consumed.add('runId');
        collectAttribute(collector, 'oribos.run_id', bag.runId);
      }
      collectMessagePayload(collector, span, 'agent-run');
      break;
    }
    case AGENT_STEP_SPAN: {
      kind = SpanKind.CLIENT;
      name = `chat ${bagString('model', span.name)}`;
      collectAttribute(collector, 'gen_ai.operation.name', 'chat');
      collectAttribute(collector, 'gen_ai.provider.name', bagString('provider', ''));
      collectAttribute(collector, 'gen_ai.request.model', bagString('model', span.name));
      // Every model attempt streams (`doStream` is the loop's only path) — always say so.
      collectAttribute(collector, 'gen_ai.request.stream', true);
      const parameters = (consumed.add('parameters'), bag.parameters) as Record<string, unknown> | undefined;
      if (parameters !== undefined && typeof parameters === 'object') {
        for (const [key, value] of Object.entries(parameters)) {
          const mapped = PARAMETER_KEYS[key];
          if (mapped !== undefined) {
            collectAttribute(collector, mapped, value);
          } else if (value !== undefined) {
            collectAttribute(collector, `oribos.request.${key}`, value);
          }
        }
      }
      const usage = (consumed.add('usage'), bag.usage) as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      if (usage !== undefined && typeof usage === 'object') {
        if (usage.inputTokens !== undefined) {
          collectAttribute(collector, 'gen_ai.usage.input_tokens', usage.inputTokens);
        }
        if (usage.outputTokens !== undefined) {
          collectAttribute(collector, 'gen_ai.usage.output_tokens', usage.outputTokens);
        }
      }
      const finishReason = (consumed.add('finishReason'), bag.finishReason);
      if (finishReason !== undefined) {
        collectAttribute(collector, 'gen_ai.response.finish_reasons', [finishReason]);
      }
      const ttfc = (consumed.add('timeToFirstChunk'), bag.timeToFirstChunk);
      if (typeof ttfc === 'number') {
        collectAttribute(collector, 'gen_ai.response.time_to_first_chunk', ttfc / 1000);
      }
      collectMessagePayload(collector, span, 'agent-step');
      break;
    }
    case TOOL_CALL_SPAN: {
      name = `execute_tool ${span.name}`;
      collectAttribute(collector, 'gen_ai.operation.name', 'execute_tool');
      collectAttribute(collector, 'gen_ai.tool.name', span.name);
      collectAttribute(collector, 'gen_ai.tool.call.id', bagString('toolCallId', ''));
      const argumentsJson = jsonTextOrUndefined(span.input);
      if (argumentsJson !== undefined) {
        collectAttribute(collector, 'gen_ai.tool.call.arguments', argumentsJson);
      }
      // The result only ships on success — failures speak through error.type / status.
      if (span.error === undefined) {
        const resultJson = jsonTextOrUndefined(span.output);
        if (resultJson !== undefined) {
          collectAttribute(collector, 'gen_ai.tool.call.result', resultJson);
        }
      }
      break;
    }
    case WORKFLOW_RUN_SPAN: {
      name = `invoke_workflow ${bagString('workflowId', span.name)}`;
      collectAttribute(collector, 'gen_ai.operation.name', 'invoke_workflow');
      collectAttribute(collector, 'gen_ai.workflow.name', bagString('workflowId', span.name));
      if (bag.runId !== undefined) {
        consumed.add('runId');
        collectAttribute(collector, 'oribos.run_id', bag.runId);
      }
      collectFallbackPayload(collector, span);
      break;
    }
    case WORKFLOW_STEP_SPAN: {
      name = `workflow-step ${span.name}`;
      collectFallbackPayload(collector, span);
      break;
    }
    case MEMORY_RECALL_SPAN: {
      name = `memory-recall ${bagString('threadId', span.name)}`;
      collectAttribute(collector, 'oribos.thread_id', bagString('threadId', span.name));
      collectFallbackPayload(collector, span);
      break;
    }
    case MEMORY_SAVE_SPAN: {
      name = `memory-save ${bagString('threadId', span.name)}`;
      collectAttribute(collector, 'oribos.thread_id', bagString('threadId', span.name));
      collectAttribute(collector, 'oribos.resource_id', bagString('resourceId', ''));
      collectFallbackPayload(collector, span);
      break;
    }
    default:
      // Open type: the framework's name passes through untouched.
      collectFallbackPayload(collector, span);
      break;
  }

  // Framework-type marker on every span, then the attributes bag's unmapped keys under their own
  // names (whitelist-mapped keys do not repeat).
  collectAttribute(collector, 'oribos.span.type', span.type);
  for (const [key, value] of Object.entries(bag)) {
    if (!consumed.has(key)) collectAttribute(collector, key, value);
  }
  collectMetadata(collector, span);
  collectErrorAttributes(collector, span);

  return {
    name,
    kind,
    attributes: toAttributes(collector),
    droppedAttributesCount: collector.dropped,
  };
}

/** Message semantics (agent-run / agent-step): prompt split + model-text output. */
function collectMessagePayload(
  collector: AttributeCollection,
  span: ExportedSpan,
  _type: 'agent-run' | 'agent-step',
): void {
  if (Array.isArray(span.input)) {
    const payload = messagesToPromptPayload(span.input);
    if (payload.systemInstructions !== undefined) {
      collectAttribute(collector, 'gen_ai.system_instructions', payload.systemInstructions);
    }
    if (payload.inputMessages !== undefined) {
      collectAttribute(collector, 'gen_ai.input.messages', payload.inputMessages);
    }
  } else if (span.input !== undefined) {
    const json = jsonTextOrUndefined(span.input);
    if (json !== undefined) collectAttribute(collector, 'oribos.input', json);
  }
  const output = outputToMessages(span.output);
  if (output !== undefined) collectAttribute(collector, 'gen_ai.output.messages', output);
}

/** Non-message semantics fallback: best-effort JSON text on `oribos.input` / `oribos.output`. */
function collectFallbackPayload(collector: AttributeCollection, span: ExportedSpan): void {
  const input = jsonTextOrUndefined(span.input);
  if (input !== undefined) collectAttribute(collector, 'oribos.input', input);
  const output = jsonTextOrUndefined(span.output);
  if (output !== undefined) collectAttribute(collector, 'oribos.output', output);
}
