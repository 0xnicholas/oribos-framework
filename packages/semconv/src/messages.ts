/**
 * Prompt-payload mapping: `ModelMessage[]`
 * splits into `gen_ai.system_instructions` (system messages) and `gen_ai.input.messages`
 * (user / assistant / tool), both as the JSON-text form the span attributes allow; parts convert
 * to the GenAI semconv part vocabulary, unrecognized parts degrade to a text part of their JSON.
 */
/** One converted GenAI semconv message part (plain JSON — these live inside JSON-text strings). */
export interface SemconvPart {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** One converted message: a role plus its converted parts. */
export interface SemconvMessage {
  readonly role: string;
  readonly parts: SemconvPart[];
}

/** The split of one `ModelMessage[]` prompt. */
export interface PromptPayload {
  readonly systemInstructions?: string;
  readonly inputMessages?: string;
}

/** Arguments / outputs keep strings, everything else becomes its JSON text. */
function asTextOrJson(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Reduces one `ModelToolResultOutput` member to text or JSON text. */
function toolResultText(output: unknown): string {
  if (typeof output !== 'object' || output === null) return asTextOrJson(output);
  const { type, ...rest } = output as { type?: string; [field: string]: unknown };
  if (type === 'text' || type === 'error-text') {
    return String(rest.value ?? '');
  }
  if (type === 'json' || type === 'error-json') {
    return JSON.stringify(rest.value ?? null) as string;
  }
  return JSON.stringify(output);
}

/** Converts one prompt content part to the semconv vocabulary; unrecognized → JSON-text fallback. */
function convertPart(part: unknown): SemconvPart {
  if (typeof part !== 'object' || part === null) {
    return { type: 'text', content: asTextOrJson(part) };
  }
  const { type } = part as { type?: string };
  switch (type) {
    case 'text':
      return { type: 'text', content: String((part as { text?: unknown }).text ?? '') };
    case 'reasoning':
      return { type: 'reasoning', content: String((part as { text?: unknown }).text ?? '') };
    case 'tool-call': {
      const call = part as { toolCallId?: unknown; toolName?: unknown; input?: unknown };
      return {
        type: 'tool_call',
        id: asTextOrJson(call.toolCallId),
        name: asTextOrJson(call.toolName),
        arguments: asTextOrJson(call.input),
      };
    }
    case 'tool-result': {
      const result = part as { toolCallId?: unknown; toolName?: unknown; output?: unknown };
      return {
        type: 'tool_call_response',
        id: asTextOrJson(result.toolCallId),
        name: asTextOrJson(result.toolName),
        output: toolResultText(result.output),
      };
    }
    default:
      // file / custom / approval / source / anything unrecognized: one text part of its JSON.
      return { type: 'text', content: JSON.stringify(part) };
  }
}

/** Converts one message's content — a parts array, or a system message's plain string. */
function convertContent(content: unknown): SemconvPart[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [{ type: 'text', content: asTextOrJson(content) }];
  return content.map(convertPart);
}

/**
 * Splits a `ModelMessage[]` prompt into the two span attributes: system messages concatenate into
 * `gen_ai.system_instructions`, the rest become `gen_ai.input.messages` in order. Either side is
 * omitted when empty.
 */
export function messagesToPromptPayload(messages: readonly unknown[]): PromptPayload {
  const systemParts: SemconvPart[] = [];
  const inputMessages: SemconvMessage[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role === 'system') {
      systemParts.push(...convertContent(content));
    } else {
      inputMessages.push({ role: String(role ?? 'user'), parts: convertContent(content) });
    }
  }
  return {
    ...(systemParts.length === 0 ? {} : { systemInstructions: JSON.stringify(systemParts) }),
    ...(inputMessages.length === 0 ? {} : { inputMessages: JSON.stringify(inputMessages) }),
  };
}

/**
 * Final model text → `gen_ai.output.messages`: one assistant message with one text part. An empty
 * string emits nothing; a non-string value (a structured result object) becomes its JSON text.
 */
export function outputToMessages(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  if (text === '') return undefined;
  return JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: text }] }]);
}
