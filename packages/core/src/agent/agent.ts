import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '../model/contract.js';
import { assertModelChain } from '../model/fallback.js';
import { assertModel } from '../model/resolve.js';
import { assertMemoryTarget } from '../memory/identity.js';
import type { Memory, StoredMessage } from '../memory/index.js';
import { loadRunWorkingMemory } from '../memory/working-memory.js';
import type { RunWorkingMemory } from '../memory/working-memory.js';
import { AGENT_RUN_SPAN, MEMORY_RECALL_SPAN } from '../observability/index.js';
import type { Tracer } from '../observability/index.js';
import { materialize } from '../output-object.js';
import { NEVER_ABORTED } from '../run-context.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { Tool } from '../tools/index.js';
import { toModelTools } from '../tools/to-model-tools.js';
import { resolveDynamicArgument } from './dynamic.js';
import { toUserTextMessages } from './input.js';
import { DEFAULT_MAX_STEPS, runAgentLoop } from './loop.js';
import type { AgentRunMemory, AgentTracing } from './loop.js';
import { runProcessInput } from './processors.js';
import type { Processor } from './processors.js';
import { createAgentStream } from './stream.js';
import { toStructuredResponseFormat } from './structured-output.js';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentMemoryOptions,
  AgentRunOptions,
  AgentRunResume,
  AgentStreamResult,
  DynamicArgument,
  ModelInput,
  RequestContext,
  StructuredOutputConfig,
} from './types.js';

/**
 * The framework's execution unit: the config surface wrapped into an object that can `generate()`
 * and `stream()`. Independent `new Agent(...)` is first-class; nothing else has to be instantiated
 * (ADR-0002 / ADR-0005).
 */
export class Agent {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions, static or resolved per request context. */
  readonly instructions: DynamicArgument<string>;
  /** The model(s) of every run — an instance, a fallback chain, or a resolver that picks either per run. */
  readonly model: ModelInput;
  /** Tool container (key = tool name) — a static container, a per-run resolver, or `undefined`. */
  readonly tools: DynamicArgument<Record<string, Tool>> | undefined;
  /** Description shown to an upstream model when composed as a tool (static or per-context). */
  readonly description: DynamicArgument<string> | undefined;
  /**
   * The memory subsystem instance of the agent's runs — static, or resolved per run like every
   * other field. The per-call `memory` option names the thread/resource; without one the run does
   * no memory I/O (`AgentConfig.memory`).
   */
  readonly memory: DynamicArgument<Memory> | undefined;
  /**
   * The observability seam, kept off the instance surface: a cross-cutting dependency the
   * composition root (or an explicit `new`) hands in, not a config field. `undefined`
   * = no span object is ever created for this agent's runs.
   */
  #tracer: Tracer | undefined;
  /**
   * The run's processors, in declaration order — the cross-cutting extension point, kept off the
   * instance surface like `tracer` (`AgentConfig.processors`). Empty = no processor runs.
   */
  #processors: readonly Processor[];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    // Resolution-time hard assertion (ADR-0004): a static model of the wrong specification version
    // — or not a language model at all — fails here, before any run, and so does a bad candidate
    // of a static fallback chain. A resolver's pick is asserted when the run resolves it
    // (`resolveModels`), so both paths fail before a model call.
    this.model = typeof config.model === 'function' ? config.model : assertModelField(config.model);
    this.tools = config.tools;
    this.description = config.description;
    this.memory = config.memory;
    this.#tracer = config.tracer;
    this.#processors = config.processors ?? [];
  }

  /**
   * Runs the agent once and returns the output object: `for await` consumes the core's own chunk
   * protocol, while `text` / `toolCalls` / `usage` / `finishReason` / `steps` are awaitable
   * terminal values on the same object. The run starts on first consumption.
   *
   * `instructions` / `model` / `tools` are resolved against this run's request context before the
   * first model call (`AgentConfig` dynamic arguments) — a per-call context changes them without
   * rebuilding the agent. The resolution context is the very object tools receive as
   * `ctx.requestContext`. (`description` is not part of a run: as-tool composition resolves it at
   * wrapping time — `resolveDynamicArgument`.)
   *
   * The built-in loop executes the tool calls a step requests (in call order), feeds the results
   * back to the model and repeats until a step requests no tool call or `maxSteps` is reached;
   * per-call behavior is controlled through `AgentRunOptions`.
   *
   * `structuredOutput` asks for a structured answer: the model calls carry the schema as JSON
   * Schema and the run's terminal text must validate against it, strictly — the validated value is
   * the result's `object` (execution semantics).
   */
  stream<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): AgentStreamResult<StandardSchemaV1.InferOutput<TSchema>>;
  stream(input: string | ModelMessage[], options?: AgentRunOptions): AgentStreamResult;
  stream(input: string | ModelMessage[], options: AgentRunOptions = {}): AgentStreamResult {
    const model = this.model;
    const name = this.name;
    const instructions = this.instructions;
    const tools = this.tools;
    const memory = this.memory;
    const tracer = this.#tracer;
    const processors = this.#processors;
    return createAgentStream(async function* () {
      // The run's request context comes first: every dynamic field resolves against it, and the
      // tools of the run receive the very same object.
      const requestContext = toRequestContext(options);
      const [resolvedInstructions, resolvedModels, resolvedTools, resolvedMemory] =
        await Promise.all([
          resolveDynamicArgument(instructions, requestContext),
          resolveModels(model, requestContext),
          resolveDynamicArgument(tools, requestContext),
          resolveDynamicArgument(memory, requestContext),
        ]);
      const inputMessages = toUserTextMessages(input);
      // A resumed run's prompt is the list it was handed — the suspended run's own messages — so
      // nothing is assembled and nothing is recalled (see `toResumedPrompt`); its memory identity,
      // when it has one, carries no input messages: the suspended run's history was already saved.
      const resumedPrompt =
        options.resume === undefined ? undefined : toResumedPrompt(inputMessages, options.resume);
      // The run's step cap — an ordinary run's `maxSteps`, and a resumed run's as passed to the
      // resume: the cap is not part of the snapshot (its shape is frozen), so a caller that continues
      // a run whose steps already reached it is told here, rather than getting a run that cannot take
      // the step it was resumed for.
      const maxSteps = toMaxSteps(options.maxSteps);
      if (options.resume !== undefined && options.resume.stepCount >= maxSteps) {
        throw new Error(
          `maxSteps ${String(maxSteps)} is already reached at the suspended run's step count ` +
            `(${String(options.resume.stepCount)}) — resume with a higher maxSteps.`,
        );
      }
      const runMemory = toRunMemory(
        resolvedMemory,
        options.memory,
        resumedPrompt === undefined ? inputMessages : [],
      );
      // The run's root span is created before memory recall: the recall span hangs under it, so the
      // boundary has to exist first. The run owns the span's lifecycle from here — including the
      // exit paths that never reach the loop (recall, working-memory load and the input processors
      // all run below).
      const tracing = toTracing(tracer, options, name, requestContext.runId);
      const runSpan = tracing?.runSpan;
      try {
        // Message history is recalled once per run, before the input processors run: the history is
        // part of the prompt the model sees, and of what
        // `processInput` observes. A run with no memory identity recalls nothing. Working memory is
        // loaded at the same boundary — it is the other half of what a memory-enabled run injects.
        const [history, workingMemory] = await Promise.all([
          resumedPrompt !== undefined || runMemory === undefined
            ? []
            : recallWithSpan(runMemory, tracing),
          resumedPrompt !== undefined || runMemory === undefined
            ? undefined
            : loadRunWorkingMemory(runMemory.memory, runMemory.resource),
        ]);
        // Call options are built per run — they are part of the run, not of creating the object.
        // The run's tool container carries what the subsystems attach to it (working memory), and it
        // is the very same container the loop executes against — the model is never offered a tool
        // the loop does not hold. The prompt is built here too: instructions, working memory, recalled
        // history, then the run's own input.
        const runTools = withRunTools(resolvedTools, workingMemory);
        const prompt =
          resumedPrompt ??
          toPrompt(resolvedInstructions, workingMemory?.message, history, inputMessages);
        const callOptions = toCallOptions(runTools, options);
        // The processors' input hook runs once per run, before the first model call: the prompt it
        // returns is what the model sees. The root span records that prompt as its input — the span
        // existed before the recall, so the processed prompt lands as an update. A resumed run's
        // prompt is already the processed one (it is what the suspended run's loop held), so the
        // hook is not run a second time over it.
        const processedPrompt =
          resumedPrompt ?? (await runProcessInput(processors, prompt, requestContext));
        runSpan?.update({ input: processedPrompt });
        return yield* runAgentLoop({
          models: resolvedModels,
          prompt: processedPrompt,
          callOptions,
          tools: runTools ?? {},
          maxSteps,
          processors,
          requestContext,
          // The run's memory wiring: the loop saves once per step (the first save carries the run's
          // input messages). `undefined` = no memory I/O.
          memory: runMemory,
          // The run's step-boundary wiring (harness wrappers' loop seam) — kept out of the request
          // context bag above; `undefined` = the loop runs untouched.
          boundary: options.stepBoundary,
          // The resume seed, when this run continues a suspended one — the harness wrapper's
          // re-entry (`AgentRunOptions.resume`); `undefined` = an ordinary run.
          resume: options.resume,
          tracing,
          // The user's model call settings are recorded on the step span under this name.
          parameters: options.modelSettings,
          structuredOutput: options.structuredOutput,
        });
      } catch (error) {
        // A failed run leaves its root span carrying the error (a failed step also carries it on
        // its own step span; a structured-output failure has no failing step — the run did not meet
        // its output contract).
        runSpan?.error(error);
        throw error;
      } finally {
        // Ends the run span on every exit path — normal completion, a failed model call, a failed
        // recall, or the consumer abandoning the generator.
        runSpan?.end();
      }
    });
  }

  /**
   * Runs the agent once and returns the terminal result — literally `stream()` awaited to its end.
   *
   * `generate()` and `stream()` share the single code path, so their terminal values always agree.
   */
  async generate<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): Promise<AgentGenerateResult<StandardSchemaV1.InferOutput<TSchema>>>;
  async generate(input: string | ModelMessage[], options?: AgentRunOptions): Promise<AgentGenerateResult>;
  async generate(
    input: string | ModelMessage[],
    options: AgentRunOptions = {},
  ): Promise<AgentGenerateResult> {
    return materialize<AgentGenerateResult>(this.stream(input, options));
  }
}

/**
 * The `model` field's static shapes (`ModelInput`): a model instance, or a fallback chain (an array
 * of instances). Asserted at construction time and returned unchanged — the agent holds the very
 * value it was given.
 */
function assertModelField(value: unknown): Model | readonly Model[] {
  return Array.isArray(value) ? assertModelChain(value) : assertModel(value);
}

/**
 * Resolves the run's model fallback chain and asserts every candidate against the model contract
 * (ADR-0004): a model of the wrong specification version — or not a language model at all — fails
 * here, before the run's first model call, whichever shape picked it. (A static field was already
 * asserted when the agent was built; asserting it again per run keeps both paths on one rule.)
 *
 * A single model is a one-element chain: the loop then walks a chain of one, which is the same
 * behavior as not having a fallback at all.
 */
async function resolveModels(model: ModelInput, ctx: RequestContext): Promise<readonly Model[]> {
  const resolved = await resolveDynamicArgument(model, ctx);
  return Array.isArray(resolved) ? assertModelChain(resolved) : [assertModel(resolved)];
}

/**
 * The run's model call options: the tool container becomes the provider tool list, and the per-call
 * passthroughs ride along. Framework-owned fields (`abortSignal` / `providerOptions` / `tools`) are
 * written after the `modelSettings` spread, so settings cannot hijack them. An agent without tools
 * sends no `tools` field at all; the loop writes `prompt` for every step.
 */
function toCallOptions(
  tools: Record<string, Tool> | undefined,
  options: AgentRunOptions,
): Omit<ModelCallOptions, 'prompt'> {
  const callOptions: Omit<ModelCallOptions, 'prompt'> = { ...options.modelSettings };
  if (tools !== undefined && Object.keys(tools).length > 0) {
    callOptions.tools = toModelTools(tools);
  }
  // A structured run owns `responseFormat` on every model call: the schema tells the provider the
  // shape to answer in, so the run's terminal text can be validated (strict) instead of hoped for.
  // Written after the `modelSettings` spread like the other framework-owned fields.
  if (options.structuredOutput !== undefined) {
    callOptions.responseFormat = toStructuredResponseFormat(options.structuredOutput);
  }
  if (options.signal !== undefined) callOptions.abortSignal = options.signal;
  if (options.providerOptions !== undefined) callOptions.providerOptions = options.providerOptions;
  return callOptions;
}

/**
 * The request context of one run (the definition surface): the user's per-call
 * properties plus framework-written `signal` / `runId`, which are written last so a per-call
 * property cannot hijack them. The framework-owned run options (`maxSteps` / `modelSettings` /
 * `providerOptions` / `stepBoundary` / `resume`) are execution controls, not context, and are left
 * out of the bag. The run id is generated per run; without a per-call `signal` the context carries a
 * never-aborting one, so tools always receive an `AbortSignal`.
 *
 * One object per run serves both readers: every dynamic argument resolves against it, and tools
 * receive it as `ctx.requestContext`.
 */
function toRequestContext(options: AgentRunOptions): RequestContext {
  const {
    modelSettings: _modelSettings,
    providerOptions: _providerOptions,
    maxSteps: _maxSteps,
    traceId: _traceId,
    parentSpanId: _parentSpanId,
    hideInput: _hideInput,
    hideOutput: _hideOutput,
    structuredOutput: _structuredOutput,
    memory: _memory,
    stepBoundary: _stepBoundary,
    resume: _resume,
    signal,
    ...bag
  } = options;
  return {
    ...bag,
    signal: signal ?? NEVER_ABORTED,
    runId: crypto.randomUUID(),
  };
}

/** The step cap of a run: `maxSteps` when given, 5 (the documented default) otherwise. */
function toMaxSteps(maxSteps: number | undefined): number {
  const resolved = maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`maxSteps must be a positive integer, got ${String(resolved)}.`);
  }
  return resolved;
}

/**
 * The run's observability wiring: `undefined` without a tracer, so the run's only zero-overhead
 * branch is one presence check. Created before memory recall — the run's root span has to exist for
 * the recall span to hang under it — and handed to the loop, which hangs its step / tool /
 * memory-save spans under the root. The root's input is the processed prompt, which is only known
 * after `processInput` has run: it lands on the span as an update, not at creation.
 *
 * The trace continuation and hiding options (`AgentRunOptions.traceId` / `parentSpanId` /
 * `hideInput` / `hideOutput`) are consumed here, at root creation: only the tracer and the root span
 * travel on to the loop.
 *
 * Empty-string continuation ids mean "no trace", not a parent with an empty id: the tool context
 * encodes an untraced call as `traceId: ''` / `spanId: ''` (`NoOpSpan` / no tracer), and an as-tool
 * delegation passes them through verbatim — such a run starts its own trace instead of hanging off
 * a nonexistent parent (multi-agent composition). An empty trace id voids the
 * whole pair (a parent outside a trace means nothing); an empty parent id only drops the parent.
 * A real parent id without any trace id is still left for the tracer to reject loudly.
 */
function toTracing(
  tracer: Tracer | undefined,
  options: AgentRunOptions,
  agentName: string,
  runId: string,
): AgentTracing | undefined {
  if (tracer === undefined) return undefined;
  const traceId = options.traceId === '' ? undefined : options.traceId;
  const parentSpanId =
    options.traceId === '' || options.parentSpanId === '' ? undefined : options.parentSpanId;
  return {
    tracer,
    runSpan: tracer.startSpan({
      name: agentName,
      type: AGENT_RUN_SPAN,
      attributes: { agentName, runId },
      ...(traceId === undefined ? {} : { traceId }),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      ...(options.hideInput === undefined ? {} : { hideInput: options.hideInput }),
      ...(options.hideOutput === undefined ? {} : { hideOutput: options.hideOutput }),
    }),
  };
}

/**
 * The run's tool container, with what the memory subsystem attaches to it: when the run has a
 * memory identity and the instance enables working memory, the container gains the
 * `updateWorkingMemory` tool (`memory/working-memory.ts`). A name collision is an explicit run-time
 * error rather than a silent override — either winner would quietly change what the other tool was
 * for, and the user's container is the only side that can move.
 */
function withRunTools(
  tools: Record<string, Tool> | undefined,
  workingMemory: RunWorkingMemory | undefined,
): Record<string, Tool> | undefined {
  if (workingMemory === undefined) return tools;
  for (const name of Object.keys(workingMemory.tools)) {
    if (tools !== undefined && name in tools) {
      throw new Error(
        `The agent's tool container already has a tool named '${name}' — working memory attaches its own update tool (AgentConfig.memory with working memory enabled); rename or drop the other one.`,
      );
    }
  }
  return { ...tools, ...workingMemory.tools };
}

/**
 * Builds the run's prompt (execution semantics): the resolved instructions as
 * the system message, then working memory and the recalled message history — themselves system and
 * prompt messages — then the run's own input: the order the model sees and the input processors may
 * rewrite. The instructions are a message of their own and are never folded into another one.
 */
function toPrompt(
  instructions: string,
  workingMemory: ModelMessage | undefined,
  history: readonly ModelMessage[],
  inputMessages: readonly ModelMessage[],
): ModelPrompt {
  return [
    { role: 'system', content: instructions },
    ...(workingMemory === undefined ? [] : [workingMemory]),
    ...history,
    ...inputMessages,
  ];
}

/**
 * The prompt of a resumed run (`AgentRunOptions.resume`): the message list the suspended run
 * stopped at, used verbatim. It already carries everything prompt assembly would rebuild — the
 * instructions, the recalled history, every completed step's messages and the suspended step's own
 * assistant message, which the loop reads back as that step's output. Validated here, at the run's
 * boundary, so a malformed resume fails loudly instead of inside the loop.
 */
function toResumedPrompt(
  inputMessages: readonly ModelMessage[],
  resume: AgentRunResume,
): ModelMessage[] {
  const tail = inputMessages.at(-1);
  if (tail === undefined || tail.role !== 'assistant' || resume.toolCalls.length === 0) {
    throw new Error(
      "A resumed run takes the suspended run's message list as its input — non-empty, ending " +
        "with that step's assistant message — plus that step's held tool calls.",
    );
  }
  return [...inputMessages];
}

/**
 * Resolves the run's memory wiring (`AgentConfig.memory` × the per-call `memory` option): no
 * instance and no option = a stateless run, no
 * instance but an option = a call-time error, instance plus option = the run's memory identity.
 * The identity itself is validated by the rule's one home (`memory/identity.ts`) — explicit,
 * never defaulted.
 */
function toRunMemory(
  memory: Memory | undefined,
  option: AgentMemoryOptions | undefined,
  inputMessages: readonly ModelMessage[],
): AgentRunMemory | undefined {
  if (memory === undefined) {
    if (option !== undefined) {
      throw new Error(
        'The run passed a memory option, but the agent has no memory configured (AgentConfig.memory).',
      );
    }
    return undefined;
  }
  if (option === undefined) return undefined;
  const threadId = assertMemoryTarget(
    'agent',
    option,
    'pass memory: { thread, resource } with both fields.',
  );
  return { memory, threadId, thread: option.thread, resource: option.resource, inputMessages };
}

/**
 * Recalls the run's message history, wrapped in its `memory-recall` span
 * (automatic instrumentation): once per run, before the input processors. The
 * span hangs under the run's root span — the explicit parent passed down the execution tree, no
 * AsyncLocalStorage — carrying the query as input and the recalled messages as output (storage
 * envelope included). A failed recall records the error on the span and propagates, so the run
 * fails with it; without tracing the recall runs directly and no span object is created.
 */
async function recallWithSpan(
  runMemory: AgentRunMemory,
  tracing: AgentTracing | undefined,
): Promise<StoredMessage[]> {
  const recall = () => runMemory.memory.recall({ threadId: runMemory.threadId });
  if (tracing === undefined) return recall();
  const span = tracing.tracer.startSpan({
    name: runMemory.threadId,
    type: MEMORY_RECALL_SPAN,
    parent: tracing.runSpan,
    input: { threadId: runMemory.threadId },
    attributes: { threadId: runMemory.threadId },
  });
  try {
    const messages = await recall();
    span.update({ output: messages });
    return messages;
  } catch (error) {
    span.error(error);
    throw error;
  } finally {
    span.end();
  }
}
