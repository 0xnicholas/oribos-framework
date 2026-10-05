import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { JsonValue, Model, ModelCallOptions } from '@oribos/core/model';

/**
 * 脚本化假模型 —— 框架测试的规范模型接缝(替代一切真实 LLM,见 issue #21 测试决策)。
 * 正本居本包(#120):core / ai-sdk / croner 的测试共用此一份,usage 记录形状与
 * finishReason 编码全仓唯一;离线 example 的教学桩自留(桩本身是教材),不消费本包。
 *
 * 实现真实 `@ai-sdk/provider` 的 LanguageModelV4 接口(编译期由该类型保证 spec 保真),
 * 同时结构上满足框架的 vendor 契约 `Model`:按脚本逐次回答,并记录每次调用的
 * call options,供测试断言"模型收到的 prompt"(instructions 动态解析、工具 schema 下发、
 * 三线错误回喂、maxSteps 截断、fallback 切换时机……)。
 */

/** 脚本中的一次工具调用。 */
export interface FakeToolCall {
  /** 工具调用 id;缺省按模型实例内顺序生成 `call-1` / `call-2` …… */
  toolCallId?: string;
  toolName: string;
  /** 调用参数;发流前字符串化为 JSON(与真实 provider 一致)。 */
  input: unknown;
  /** 覆盖字符串化输入(用于非法 JSON 等场景)。 */
  inputRaw?: string;
}

/** 脚本中的一次 provider 执行的工具结果(provider-executed tool call 的回执)。 */
export interface FakeToolResult {
  /** 对应的工具调用 id(必须与流内 tool-call part 一致,故显式给出)。 */
  toolCallId: string;
  toolName: string;
  /** 结果值;与 provider 契约的 `result` 字段同名。 */
  result: NonNullable<JsonValue>;
  /** 标记错误结果。 */
  isError?: boolean;
}

/** 脚本中的一次模型回答(即一次 doGenerate / doStream 调用)。 */
export interface FakeResponse {
  /** 文本增量;字符串按单个增量发送。 */
  text?: string | readonly string[];
  /** 推理增量;chunk 协议不承载,用于断言丢弃行为。 */
  reasoning?: string | readonly string[];
  /** 本次回答请求的工具调用。 */
  toolCalls?: readonly FakeToolCall[];
  /** 本次回答中 provider 自己执行并回报的工具结果(在 tool-call 之后下发)。 */
  toolResults?: readonly FakeToolResult[];
  /** unified finish reason;缺省为有工具调用时的 `'tool-calls'`,否则 `'stop'`。 */
  finishReason?: LanguageModelV4FinishReason['unified'];
  /** finish part 上报告的 token 数(唯一的 usage 记录形状)。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 以该值直接拒绝调用(尚无任何输出),用于 fallback 等场景。 */
  fail?: unknown;
  /** 在脚本输出之后追发 `error` part(流中途失败)。 */
  errorAfter?: unknown;
  /** 省略 finish part:模拟违背流契约的 provider(无 finish 也无 error)。 */
  omitFinish?: boolean;
  /** 回答的节拍:流式调用在首 part 前与每个 part 之后各等待这么久(keep-alive 等节奏测试)。 */
  delayMs?: number;
}

/** 假模型:除模型契约外,暴露录制的调用参数供断言。 */
export interface FakeModel extends Model {
  /** 按顺序录制的 doStream call options。 */
  readonly streamCalls: ModelCallOptions[];
  /** 按顺序录制的 doGenerate call options。 */
  readonly generateCalls: ModelCallOptions[];
}

export interface FakeModelOptions {
  /** provider id,缺省 `'fake'`。 */
  provider?: string;
  /** model id,缺省 `'fake-model'`。 */
  modelId?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 按脚本回答的假模型。脚本逐次消费,耗尽后再被调用会显式报错(暴露漏写脚本的测试)。
 */
export function fakeModel(
  script: readonly FakeResponse[],
  options: FakeModelOptions = {},
): FakeModel {
  const streamCalls: ModelCallOptions[] = [];
  const generateCalls: ModelCallOptions[] = [];
  let answered = 0;
  let toolCalls = 0;

  function takeResponse(kind: 'doGenerate' | 'doStream'): FakeResponse {
    const response = script[answered];
    if (response === undefined) {
      throw new Error(
        `fake model script exhausted: scripted ${script.length} response(s), ` +
          `but ${kind} was called ${answered + 1} time(s). Add another script entry.`,
      );
    }
    answered += 1;
    return response;
  }

  function resolveToolCall(call: FakeToolCall): {
    toolCallId: string;
    toolName: string;
    input: string;
  } {
    toolCalls += 1;
    return {
      toolCallId: call.toolCallId ?? `call-${toolCalls}`,
      toolName: call.toolName,
      input: call.inputRaw ?? JSON.stringify(call.input) ?? 'null',
    };
  }

  const doGenerate = async (call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    call.abortSignal?.throwIfAborted();
    generateCalls.push(call);
    const response = takeResponse('doGenerate');
    if (response.fail !== undefined) throw response.fail;
    if (response.delayMs !== undefined && response.delayMs > 0) await sleep(response.delayMs);
    return toGenerateResult(response, resolveToolCall);
  };

  const doStream = async (call: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> => {
    call.abortSignal?.throwIfAborted();
    streamCalls.push(call);
    const response = takeResponse('doStream');
    if (response.fail !== undefined) throw response.fail;
    return { stream: toStream(response, resolveToolCall) };
  };

  const contract: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: options.provider ?? 'fake',
    modelId: options.modelId ?? 'fake-model',
    supportedUrls: {},
    doGenerate,
    doStream,
  };

  return { ...contract, streamCalls, generateCalls };
}

function toDeltas(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

/** 把脚本里的工具调用解析为 provider 形状(id 分配 + 字符串化输入)。 */
interface ResolvedToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

type ResolveToolCall = (call: FakeToolCall) => ResolvedToolCall;

function finishReasonOf(response: FakeResponse): LanguageModelV4FinishReason {
  const unified =
    response.finishReason ?? (response.toolCalls?.length ? 'tool-calls' : 'stop');
  return { unified, raw: unified };
}

function toProviderUsage(
  usage: FakeResponse['usage'],
): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: usage?.inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function toGenerateResult(
  response: FakeResponse,
  resolveToolCall: ResolveToolCall,
): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [];

  const reasoning = toDeltas(response.reasoning).join('');
  if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning });

  const text = toDeltas(response.text).join('');
  if (text !== '') content.push({ type: 'text', text });

  for (const call of response.toolCalls ?? []) {
    content.push({ type: 'tool-call', ...resolveToolCall(call) });
  }

  for (const result of response.toolResults ?? []) {
    content.push({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: result.result,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    });
  }

  return {
    content,
    finishReason: finishReasonOf(response),
    usage: toProviderUsage(response.usage),
    warnings: [],
  };
}

function toStream(
  response: FakeResponse,
  resolveToolCall: ResolveToolCall,
): ReadableStream<LanguageModelV4StreamPart> {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];

  // 与真实 provider 的流一致的结构:每段内容有 start / delta… / end,工具参数先流式下发再落成 tool-call。
  const reasoning = toDeltas(response.reasoning);
  if (reasoning.length > 0) {
    parts.push({ type: 'reasoning-start', id: 'reasoning-0' });
    for (const delta of reasoning) {
      parts.push({ type: 'reasoning-delta', id: 'reasoning-0', delta });
    }
    parts.push({ type: 'reasoning-end', id: 'reasoning-0' });
  }

  const text = toDeltas(response.text);
  if (text.length > 0) {
    parts.push({ type: 'text-start', id: 'text-0' });
    for (const delta of text) {
      parts.push({ type: 'text-delta', id: 'text-0', delta });
    }
    parts.push({ type: 'text-end', id: 'text-0' });
  }

  for (const call of response.toolCalls ?? []) {
    const { toolCallId, toolName, input } = resolveToolCall(call);
    parts.push({ type: 'tool-input-start', id: toolCallId, toolName });
    parts.push({ type: 'tool-input-delta', id: toolCallId, delta: input });
    parts.push({ type: 'tool-input-end', id: toolCallId });
    parts.push({ type: 'tool-call', toolCallId, toolName, input });
  }

  for (const result of response.toolResults ?? []) {
    parts.push({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: result.result,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    });
  }

  if (response.errorAfter !== undefined) {
    // 流中途失败:已产出的部分照常下发,但没有 finish(与真实 provider 一致)。
    parts.push({ type: 'error', error: response.errorAfter });
  } else if (response.omitFinish !== true) {
    parts.push({
      type: 'finish',
      finishReason: finishReasonOf(response),
      usage: toProviderUsage(response.usage),
    });
  }

  // delayMs 节拍:首 part 前等待一次,之后每个 part 之间各等一次(keep-alive 测试的慢流)。
  const delayMs = response.delayMs ?? 0;
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      if (delayMs > 0) await sleep(delayMs);
      for (const part of parts) {
        controller.enqueue(part);
        if (delayMs > 0) await sleep(delayMs);
      }
      controller.close();
    },
  });
}
