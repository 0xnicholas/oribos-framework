import type { Chunk, FinishChunk, FinishReason, ToolCallChunk, ToolResultChunk, Usage } from '../model/chunks.js';
import type {
  JsonValue,
  Model,
  ModelCallOptions,
  ModelMessage,
  ModelPrompt,
  ModelTextPart,
  ModelToolCallPart,
  ModelToolResultOutput,
  ModelToolResultPart,
} from '../model/contract.js';
import { modelChainExhausted } from '../model/fallback.js';
import type { ModelFallbackFailure } from '../model/fallback.js';
import { normalizeStream } from '../model/normalize.js';
import { AGENT_STEP_SPAN, MEMORY_SAVE_SPAN, TOOL_CALL_SPAN } from '../observability/index.js';
import type { Span, Tracer } from '../observability/index.js';
import { withSpan } from '../observability/tracer.js';
import { formatIssues, messageOf, validateSchema } from '../standard-schema-runtime.js';
import type { Memory, MemoryThreadRef } from '../memory/index.js';
import type { Tool, ToolContext } from '../tools/index.js';
import { missingFinishError } from './stream.js';
import { runProcessError, runProcessOutputStep } from './processors.js';
import type { Processor } from './processors.js';
import { toStructuredObject } from './structured-output.js';
import type { AgentGenerateResult, AgentRunResume, AgentStep, AgentStepBoundary, AgentStepBoundaryEvent, RequestContext, StructuredOutputConfig } from './types.js';

/** How many model calls one run may make when the caller pins no `maxSteps` (execution semantics). */
export const DEFAULT_MAX_STEPS = 5;

/** Everything the built-in loop needs for one run. */
export interface AgentLoopOptions {
  /**
   * The run's fallback chain, in array order — at least one candidate (a run with a single model is
   * a one-element chain). Every model call walks it: a candidate is abandoned for the next one only
   * when it fails before producing a chunk (the accepted `model` shapes).
   */
  readonly models: readonly Model[];
  /** The run's initial prompt (instructions + input); the loop extends it with each round trip. */
  readonly prompt: ModelPrompt;
  /** Model call options without `prompt` — the loop writes the prompt of every step. */
  readonly callOptions: Omit<ModelCallOptions, 'prompt'>;
  /** The agent's tool container: key = tool name. */
  readonly tools: Record<string, Tool>;
  /** The step cap (≥ 1). */
  readonly maxSteps: number;
  /** The run's processors, in declaration order (`AgentConfig.processors`); empty = none. */
  readonly processors: readonly Processor[];
  /**
   * The run's memory wiring — present only when the run reads and writes memory (`AgentConfig.memory`
   * resolved plus the per-call identity). `undefined` = the loop does no memory I/O at all.
   */
  readonly memory?: AgentRunMemory | undefined;
  /** The run's request context — framework-written `signal` / `runId` plus the user's bag. */
  readonly requestContext: RequestContext;
  /**
   * The run's step-boundary seam (`AgentRunOptions.stepBoundary`) — the harness wrappers' single
   * loop extension point. Absent = the loop runs exactly as
   * before: the zero-overhead guarantee the harness spec pins on the bare agent.
   */
  readonly boundary?: AgentStepBoundary | undefined;
  /**
   * The run's resume seed (`AgentRunOptions.resume`, the harness wrappers' re-entry): the calls the
   * suspended step held back, replayed as the run's first step without a model call. The prompt the
   * run was handed already ends with that step's own assistant message — the loop reads its text,
   * calls and provider-executed echoes back from there. Step numbering starts at the seed's
   * `stepCount`, so a resumed segment is one run's continuation, not a fresh count.
   */
  readonly resume?: AgentRunResume | undefined;
  /**
   * The run's structured-output option (`AgentRunOptions.structuredOutput`), present only when the
   * run asked for one: the run's terminal text is parsed as JSON and validated against the schema,
   * strictly, and the validated value settles the run's `object` (execution semantics). The schema
   * is also what the run's model calls carry as `responseFormat` — built by the agent before the
   * loop starts.
   */
  readonly structuredOutput?: StructuredOutputConfig | undefined;
  /**
   * The run's observability wiring, present only when a tracer is attached (`AgentConfig.tracer`).
   * Absent = the whole observability subsystem stays out of the loop: no span object is created
   * anywhere in it. The wiring's root span is created by the agent (it has to exist before memory
   * recall); the loop hangs its own span boundaries — step, tool call, memory save — under it.
   */
  readonly tracing?: AgentTracing | undefined;
  /** The user's `modelSettings` passthrough, recorded on the step span as `parameters`. */
  readonly parameters?: Record<string, unknown> | undefined;
}

/**
 * The run's memory wiring (the identity model and message history): the instance,
 * the thread/resource identity of the run, and the run's own input messages — persisted with the
 * first step's record, so a recall never loses what the user said. Assembled by the agent from
 * `AgentConfig.memory` and the per-call `memory` option; absent = no memory I/O.
 */
export interface AgentRunMemory {
  /** The memory instance this run recalls from and saves into. */
  readonly memory: Memory;
  /** The thread id of the run — recalled once, before the first input processor runs. */
  readonly threadId: string;
  /** The thread reference — `save` applies its `title` / `metadata` when creating the thread. */
  readonly thread: MemoryThreadRef;
  /** The thread's owner, stamped on every saved message. */
  readonly resource: string;
  /** The run's own input messages — saved with the first step's record. */
  readonly inputMessages: readonly ModelMessage[];
}

/**
 * The observability wiring of one run (automatic instrumentation): the tracer
 * plus the run's root span. The agent creates it before memory recall — the root span has to exist
 * for the recall span to hang under it — and owns its lifecycle (error / end) at the run boundary;
 * the loop hangs its step / tool / memory-save spans under it and reports the run's terminal output
 * on it. Grouped rather than flat so the loop's zero-overhead branch is a single presence check.
 */
export interface AgentTracing {
  /** The tracer injected into the agent; every child span of the run is started through it. */
  readonly tracer: Tracer;
  /** The run's root span (`agent-run`) — the parent every child span of the run hangs under. */
  readonly runSpan: Span;
}

/**
 * The built-in agent loop, as a generator over the
 * core's chunk protocol.
 *
 * One step at a time: call the model, yield its chunks, then — if the step asked for client-side
 * tools — execute them in call order and yield one `tool-result` chunk per call. The step is then
 * appended to the prompt in the vendor's own shape (assistant message with the step's text, its
 * tool calls and any provider-executed results; tool message with the framework-executed results)
 * and the next step begins. The loop stops when a step requests no client-side tool call, or when
 * `maxSteps` is reached; if the cap ends a run whose last step still asked for tools, that step's
 * `finish` chunk is reported as `'tool-calls'` — the terminal reason for a cap-truncated run
 * (`chunks.ts`).
 *
 * **Fallback chain** (the accepted `model` shapes): a step's model call walks
 * `models` in array order, and abandons a candidate for the next one only while it has produced no
 * chunk yet. A mid-stream failure propagates instead — partial output has already reached the
 * caller, and switching would splice two models' answers together — and so does the failure of a
 * run whose signal is already aborted: cancellation is the run's outcome, not a chain failure. A
 * step whose whole chain failed ends with the last attempt's error when there was only one, or with
 * a `ModelFallbackError` carrying every candidate's own error otherwise.
 *
 * Errors never abort a run (validation and error semantics): input validation
 * failures, `execute` throws, output validation failures and calls to tools the container does not
 * hold all become an `isError` tool result fed back to the model, which decides whether to recover
 * or give up.
 *
 * Provider-executed tool calls are not executed again: a call whose `toolCallId` already has a
 * result in the step (the provider executed it) is skipped.
 *
 * **Processors** (the Processor extension point): `processOutputStep` runs once per
 * completed step, after its tools, and the record it returns is the run's authoritative one — it is
 * what the next prompt is built from and what the generator's return value reports. `processError`
 * runs where an error would surface: a model-call failure that ends the step (never a cancelled run)
 * and every tool-line failure. Both chains run in declaration order; a replacement is threaded on.
 */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<Chunk, AgentGenerateResult, void> {
  const {
    models,
    callOptions,
    tools,
    maxSteps,
    requestContext,
    processors,
    structuredOutput,
    memory: loopMemory,
  } = options;
  const prompt: ModelMessage[] = [...options.prompt];
  /** The run's authoritative step records — the processors' rewrites included. */
  const steps: AgentStep[] = [];
  // The run's root span, created by the agent before memory recall; `undefined` without a tracer —
  // the loop's only zero-overhead branch, and no child span object is ever created below it.
  const runSpan = options.tracing?.runSpan;
  /**
   * The terminal reason of the step that ended the run — set by the step whose tools left nothing
   * pending, or by the cap's last step. The run's terminal values are built after the loop, outside
   * the step boundary: a structured run validates its terminal text there, so a text that does not
   * become the schema's value fails the run without marking the model call that produced it (the
   * call succeeded; the run's output contract did not — execution semantics).
   */
  let settled: FinishReason | undefined;

  // The resume seed (`AgentRunOptions.resume`): present only when this run continues a suspended
  // run, and then consumed by its first step — the suspended step's held calls, replayed in the
  // prompt whose tail is their own assistant message. Step numbering continues at the suspended
  // run's `stepCount`, so indices, the `maxSteps` cap and seam events count one run across a
  // resume; a run that does not resume starts at 0 and forgets the seed entirely.
  const resume = options.resume;
  /**
   * The pre-supplied answers of the held calls, by tool call id — a call with one never executes.
   * Built only for a resume: an ordinary run allocates nothing and the loop's lookup is a single
   * presence check against `undefined` (the seam's absent-cost discipline).
   */
  const answers =
    resume?.answers === undefined
      ? undefined
      : new Map(resume.answers.map((result) => [result.toolCallId, result]));

  for (let stepIndex = resume?.stepCount ?? 0; stepIndex < maxSteps; stepIndex += 1) {
    // The resumed step: the suspended run's held calls, replayed. Its model output — and with it
    // its `finish` chunk — already streamed in the suspended run, so this step makes no model call
    // and consults no injection hook (`beforeNextStep` is defined as the check before a model
    // call). Its record is read back from the prompt's tail, the step's own assistant message: its
    // text, its calls, and the results the provider had already executed itself.
    const resuming = resume !== undefined && stepIndex === resume.stepCount;
    /** The step's model output — from the model call below, or the resumed step's assistant message. */
    let stepSpan: Span | undefined;
    /** The step's text before the processors see it (the record's), `raw` marking that. */
    let rawText: string;
    /** The step's calls, in stream order — the resumed step's held calls. */
    let rawCalls: readonly ToolCallChunk[];
    /** Tool call ids that already have a result in this step (provider-executed). */
    let rawAnswered: ReadonlySet<string>;
    /** Results the provider executed itself, in stream order — echoed in the step's assistant message. */
    let rawProviderResults: readonly ToolResultChunk[];
    /** The step's finish — the model's own, or the synthesized one of a resumed step. */
    let finishChunk: FinishChunk;
    let firstChunkMs: number | undefined;

    if (resuming) {
      const assistant = prompt.at(-1);
      // The agent validated this at the run's boundary; the check is the loop's own contract.
      if (assistant === undefined || assistant.role !== 'assistant') {
        throw new Error(
          "A resumed run must carry the suspended step's assistant message as the last message of its prompt.",
        );
      }
      rawText = textOfAssistantMessage(assistant);
      rawCalls = resume === undefined ? [] : resume.toolCalls;
      rawAnswered = idsOfProviderResults(assistant);
      rawProviderResults = providerResultsOf(assistant);
      finishChunk = RESUMED_STEP_FINISH;
      // The resumed step makes no model call, so it has no step span: its tool calls hang under the
      // run span (see `startToolCallSpan` below).
      stepSpan = undefined;
    } else {
      // The injection half of the step-boundary seam (signals): the queue check at every step
      // boundary — before each model call of the run, the first included (injected into the current
      // run, taking effect at the next step). Absent seam = no call, no copy, no spread: the bare
      // loop's behavior is untouched. The messages a hook returns ride at the end of the prompt —
      // after the event's snapshot — so they take part in the model call this step is about to make,
      // and in the step span's recorded input, which copies the prompt below.
      const beforeNextStep = options.boundary?.beforeNextStep;
      if (beforeNextStep !== undefined) {
        const injected = await beforeNextStep(stepBoundaryEvent(prompt, stepIndex, runSpan));
        if (injected !== undefined) prompt.push(...injected);
      }
      const stepStartedAt = Date.now();
      let timeToFirstChunk: number | undefined;
      let finish: FinishChunk | undefined;
      const stepText: string[] = [];
      const toolCalls: ToolCallChunk[] = [];
      /** Tool call ids that already have a result in this step (provider-executed). */
      const answered = new Set<string>();
      /** Results the provider executed itself, in stream order — echoed in the step's prompt message. */
      const providerResults: ToolResultChunk[] = [];
      /** The candidates that failed before producing a chunk, in chain order. */
      const failures: ModelFallbackFailure[] = [];
      /**
       * The candidate that served this step, with its finish chunk. Set when a candidate completes
       * (its stream ended with a finish part); its span stays open until the step's tools have run.
       */
      let served: { readonly span: Span | undefined; readonly finish: FinishChunk } | undefined;

      // The step boundary: one span per model call, hanging under the run's root span — a fallback
      // chain's failed attempts get their own spans, so a switch is visible in the trace, and the
      // attempt that serves the step carries its usage / finishReason. Every attempt walks the
      // chain in array order. Tool calls of the step hang under the serving attempt's span, so that
      // span stays open until they are done too.
      for (const candidate of models) {
        const candidateSpan = startStepSpan(options, prompt, candidate);
        let producedChunk = false;

        try {
          const { stream } = await candidate.doStream({ ...callOptions, prompt });

          for await (const chunk of normalizeStream(stream)) {
            // Point of no return for this step: a chunk is on its way to the caller, so a later
            // failure must propagate — the next candidate would continue someone else's answer.
            producedChunk = true;
            if (timeToFirstChunk === undefined) timeToFirstChunk = Date.now() - stepStartedAt;
            switch (chunk.type) {
              case 'text-delta':
                stepText.push(chunk.textDelta);
                yield chunk;
                break;
              case 'tool-call':
                toolCalls.push(chunk);
                yield chunk;
                break;
              case 'tool-result':
                // A result already in the step's stream is provider-executed: it is echoed in the
                // assistant message and never executed by the framework.
                answered.add(chunk.toolCallId);
                providerResults.push(chunk);
                yield chunk;
                break;
              case 'finish':
                // The step ends here, but the decision needs the whole step: yield it below.
                finish = chunk;
                break;
            }
          }

          if (finish === undefined) {
            // A step's model stream without a finish part is a contract violation; failing here also
            // covers later steps, which must not settle the run on a previous step's finish chunk.
            throw missingFinishError();
          }

          served = { span: candidateSpan, finish };
          break;
        } catch (error) {
          // Cancellation is the run's outcome, not a chain failure and not a processor's business:
          // an aborted run surfaces its own reason untouched (`processError` is for provider errors).
          if (requestContext.signal.aborted) {
            candidateSpan?.error(error);
            throw error;
          }
          // A mid-stream failure cannot fall back — partial output has already reached the caller:
          // it surfaces through `processError`, which may replace the error the run ends with.
          if (producedChunk) {
            const surfaced = await runProcessError(
              processors,
              error,
              { source: 'model', stepIndex },
              requestContext,
            );
            candidateSpan?.error(surfaced);
            throw surfaced;
          }
          candidateSpan?.error(error);
          failures.push({ model: candidate, error });
        } finally {
          // A candidate that did not serve the step is over here: its span carries the failure (or
          // the abandoned attempt) and closes. The serving candidate's span stays open for its
          // tools, which hang under it.
          if (served === undefined) candidateSpan?.end();
        }
      }

      if (served === undefined) {
        // Every candidate failed before producing a chunk: the run ends here — with the original
        // error when there was nothing to fall back to, with the chain's context when there was.
        // The surfaced error walks the processors' error chain before it becomes the run's error.
        throw await runProcessError(
          processors,
          modelChainExhausted(failures),
          { source: 'model', stepIndex },
          requestContext,
        );
      }

      stepSpan = served.span;
      rawText = stepText.join('');
      rawCalls = toolCalls;
      rawAnswered = answered;
      rawProviderResults = providerResults;
      finishChunk = served.finish;
      firstChunkMs = timeToFirstChunk;
    }

    try {
      // The step is complete: its text is the run's output so far (the last step's text settles
      // the run's output — `stream()`'s `text` reads the same rule).
      stepSpan?.update({
        output: rawText,
        attributes: {
          usage: finishChunk.usage,
          finishReason: finishChunk.finishReason,
          ...(firstChunkMs === undefined ? {} : { timeToFirstChunk: firstChunkMs }),
        },
      });

      const pending = rawCalls.filter((call) => !rawAnswered.has(call.toolCallId));
      const lastStep = stepIndex + 1 >= maxSteps;
      // The step boundary comes before the framework-executed results: consumers see the model's
      // finish, then the results that answer the step's calls (results belong to that step).
      const terminalFinish: FinishChunk =
        pending.length > 0 && lastStep ? { ...finishChunk, finishReason: 'tool-calls' } : finishChunk;
      yield terminalFinish;

      // The approval half of the step-boundary seam (durable agents): after the step's model output
      // has fully streamed and before the framework
      // executes its pending calls — the only point where a gate can still hold them back. Absent
      // seam = the calls run exactly as before. The event's `messages` are the snapshot surface the
      // durable wrapper persists: the prompt plus this step's own vendor-shaped assistant message
      // (its text, its calls, any provider-executed results) — the same composition rule as a
      // completed step's messages, from the raw record: `processOutputStep` has not run, the step
      // is not authoritative yet. A resumed step consults no gate: the held calls were let through
      // (or answered) by the decision a resume carried, and re-deciding them would suspend the run
      // on the very calls it was resumed for.
      const beforeToolCalls = options.boundary?.beforeToolCalls;
      if (!resuming && pending.length > 0 && beforeToolCalls !== undefined) {
        const decision = await beforeToolCalls({
          ...stepBoundaryEvent(
            [
              ...prompt,
              ...toStepMessages(
                {
                  text: rawText,
                  toolCalls: rawCalls,
                  toolResults: rawProviderResults,
                  usage: finishChunk.usage,
                },
                rawAnswered,
              ),
            ],
            stepIndex,
            runSpan,
          ),
          pendingCalls: pending,
        });
        if (decision?.suspend === true) {
          // Suspension is a normal terminal outcome, never an error: the pending calls do not
          // execute, the step never completes — no processor hook,
          // no memory save, nothing appended to the prompt — and the run settles with the pre-wired
          // `'suspended'` reason (`chunks.ts`), its root span ending normal under a status
          // attribute. The snapshot itself is the wrapper's to build and persist; the loop keeps
          // none. The chunk stream above already carried the model's own finish for this step; the
          // run-level reason reports what the run did.
          runSpan?.update({ attributes: { status: 'suspended' } });
          settled = 'suspended';
          break;
        }
      }

      const results: ToolResultChunk[] = [];
      for (const call of pending) {
        const preAnswered = answers?.get(call.toolCallId);
        if (preAnswered !== undefined) {
          // Answered by a resume's decision instead of executing — the approval gate's
          // user-rejected path. The result is the wrapper's; the loop only carries it into the
          // record, the model
          // feedback and memory; nothing ran, so no tool span is created for it.
          results.push(preAnswered);
          yield preAnswered;
          continue;
        }
        // A resumed step has no step span (it made no model call): its tool calls hang under the
        // run span of the resumed segment, the same `agent-run` span the rest of it reports to.
        const toolSpan = startToolCallSpan(options, stepSpan ?? runSpan, call);
        const outcome = await executeToolCall(tools, call, requestContext, toolSpan);
        let result: ToolResultChunk;
        if ('result' in outcome) {
          result = outcome.result;
        } else {
          // The failure walks the processors' error chain before the error tool result is built;
          // the replacement is the error the model sees (and the span records).
          const failure = await runProcessError(
            processors,
            outcome.failure.error,
            { source: 'tool', stepIndex, toolCall: call },
            requestContext,
          );
          result = toolResult(call, outcome.failure.toMessage(failure), true);
          toolSpan?.error(failure);
        }
        toolSpan?.update({ output: result.output });
        toolSpan?.end();
        results.push(result);
        yield result;
      }

      // The step is over: its full record (text / tool calls / tool results / usage) goes through
      // the processors, and the record they return is the run's authoritative one — it settles
      // the run's terminal values and is what the next prompt (and memory) is built from.
      const record = await runProcessOutputStep(
        processors,
        {
          text: rawText,
          toolCalls: rawCalls,
          toolResults: [...rawProviderResults, ...results],
          usage: finishChunk.usage,
        },
        stepIndex,
        requestContext,
      );
      steps.push(record);
      // The run span carries the run's terminal text — the processed record, same as the output
      // object's `text` (automatic instrumentation; the step span keeps the model's response).
      runSpan?.update({ output: record.text });

      // Memory save (message-history timing): once per completed step, after
      // `processOutputStep` — a processor's rewrite (redaction) is what lands in storage — with
      // the run's own input messages carried by the first step's save. A run with no memory
      // wiring does no I/O here at all; with one, the save gets its own `memory-save` span under
      // the step's span (automatic instrumentation).
      if (loopMemory !== undefined) {
        const stepMessages = toStepMessages(record, rawAnswered);
        await saveStepMessages(
          loopMemory,
          stepIndex === 0 ? [...loopMemory.inputMessages, ...stepMessages] : stepMessages,
          stepSpan,
          options.tracing,
        );
      }

      if (pending.length === 0 || lastStep) {
        settled = terminalFinish.finishReason;
        break;
      }

      // Provider-executed results stay paired with their calls inside the assistant message;
      // framework-executed ones follow in the `tool` message (the vendor-shaped split, from the
      // processed record — a processor's rewrite is what the next model call sees). The prompt of a
      // resumed run already ends with the step's assistant message — it came from the snapshot — so
      // only the results are new there; every later step appends its whole pair as usual.
      if (resuming) {
        const feedback = toToolMessage(record, rawAnswered);
        if (feedback !== undefined) prompt.push(feedback);
      } else {
        prompt.push(...toStepMessages(record, rawAnswered));
      }
    } catch (error) {
      stepSpan?.error(error);
      throw error;
    } finally {
      stepSpan?.end();
    }
  }

  if (settled === undefined) {
    // Unreachable: `maxSteps` is at least 1, so the last iteration always takes the terminal
    // branch — its step set `settled`, or it ran that step's tools first and then did.
    throw new Error('The agent loop ended without settling its run.');
  }

  const outcome = await runOutcome(steps, settled, structuredOutput);
  // A structured run's span reports the structured result — it is what the caller consumes
  // (automatic instrumentation: agent-run output is the terminal text or the structured result).
  if (structuredOutput !== undefined) runSpan?.update({ output: outcome.object });
  return outcome;
}

/**
 * Persists one step's messages (message-history timing), wrapped in the
 * step's `memory-save` span (automatic instrumentation): the span hangs under
 * the span of the step that produced the messages — the explicit parent passed down, no
 * AsyncLocalStorage — carrying the batch as input and the messages as persisted (envelope
 * included) as output. The wrap-one-await lifecycle is `withSpan`'s skeleton: a failed save
 * records the error on the span and propagates, so the run fails with it; without a tracer the
 * save runs directly and no span object is created.
 */
async function saveStepMessages(
  loopMemory: AgentRunMemory,
  messages: readonly ModelMessage[],
  stepSpan: Span | undefined,
  tracing: AgentTracing | undefined,
): Promise<void> {
  await withSpan(
    tracing?.tracer,
    {
      name: loopMemory.threadId,
      type: MEMORY_SAVE_SPAN,
      ...(stepSpan === undefined ? {} : { parent: stepSpan }),
      input: messages,
      attributes: { threadId: loopMemory.threadId, resourceId: loopMemory.resource },
    },
    () =>
      loopMemory.memory.save({
        thread: loopMemory.thread,
        resource: loopMemory.resource,
        messages,
      }),
  );
}

/**
 * The shared event surface of a step boundary (`AgentStepBoundaryEvent`): the prompt copied (the
 * event must not hand out the loop's own array), the boundary's step index, and the run's trace
 * continuation — the root span's ids when a tracer is attached, empty strings otherwise (the same
 * encoding the tool context carries).
 */
function stepBoundaryEvent(
  prompt: readonly ModelMessage[],
  stepIndex: number,
  runSpan: Span | undefined,
): AgentStepBoundaryEvent {
  return {
    messages: [...prompt],
    stepIndex,
    traceId: runSpan?.traceId ?? '',
    spanId: runSpan?.id ?? '',
  };
}

/**
 * Starts one step span (automatic instrumentation): one model call of the
 * run, hanging under the run's root span. Every attempt of a fallback chain gets its own span — a
 * failed attempt carries the failure, the attempt that serves the step carries its usage /
 * finishReason. The step's tool calls hang under the serving attempt's span, so that span stays
 * open until they have run too. Its prompt is copied — the loop appends to its own array, and a
 * recorded span must not mutate after the fact.
 */
function startStepSpan(
  options: AgentLoopOptions,
  prompt: readonly ModelMessage[],
  model: Model,
): Span | undefined {
  const tracing = options.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: model.modelId,
    type: AGENT_STEP_SPAN,
    parent: tracing.runSpan,
    input: [...prompt],
    attributes: {
      model: model.modelId,
      provider: model.provider,
      ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
    },
  });
}

/**
 * Starts one tool call's span (automatic instrumentation): a single tool
 * execution inside the step that requested it. The span is the source of the tool context's
 * `traceId` / `spanId`, so an as-tool delegation can hang its run under it (ADR-0012).
 */
function startToolCallSpan(
  options: AgentLoopOptions,
  stepSpan: Span | undefined,
  call: ToolCallChunk,
): Span | undefined {
  const tracing = options.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: call.toolName,
    type: TOOL_CALL_SPAN,
    ...(stepSpan === undefined ? {} : { parent: stepSpan }),
    input: call.input,
    attributes: { toolCallId: call.toolCallId },
  });
}

/**
 * Runs one tool call under the normalized error semantics:
 * never throws, always answers the call — with the tool's result, or with the failure an error tool
 * result will answer. The failure is not formatted here: the loop hands its error through
 * `processError` first, then builds the model-facing message with the failure's own recipe.
 *
 * Input validation runs before `execute` (the validated value is what the tool receives); output
 * validation runs after it (side effects already happened — repeat protection is the tool's
 * idempotency job, keyed by `toolCallId`). A tool without `inputSchema` is argument-less and gets
 * `undefined`; a tool without `outputSchema` returns whatever it returns.
 */
async function executeToolCall(
  tools: Record<string, Tool>,
  call: ToolCallChunk,
  requestContext: RequestContext,
  toolSpan: Span | undefined,
): Promise<ToolCallOutcome> {
  const tool = tools[call.toolName];
  if (tool === undefined) {
    const message = `Unknown tool '${call.toolName}': it is not in the agent's tool container.`;
    return { failure: { error: new Error(message), toMessage: messageOf } };
  }

  let input: unknown;
  if (tool.inputSchema !== undefined) {
    const validation = await validateSchema(tool.inputSchema, call.input);
    if ('issues' in validation) {
      const message = `Invalid input for tool '${call.toolName}': ${formatIssues(validation.issues)}`;
      return { failure: { error: new Error(message), toMessage: messageOf } };
    }
    input = validation.value;
  }

  let output: unknown;
  try {
    output = await tool.execute(input, toolContext(call, requestContext, toolSpan));
  } catch (error) {
    // The thrown error keeps its identity for `processError` / the span; the framework framing is
    // what turns it into the model-facing message (`Tool 'x' failed: <detail>`).
    return {
      failure: {
        error,
        toMessage: (replacement) => `Tool '${call.toolName}' failed: ${messageOf(replacement)}`,
      },
    };
  }

  if (tool.outputSchema !== undefined) {
    const validation = await validateSchema(tool.outputSchema, output);
    if ('issues' in validation) {
      const message = `Tool '${call.toolName}' returned an invalid output: ${formatIssues(validation.issues)}`;
      return { failure: { error: new Error(message), toMessage: messageOf } };
    }
    output = validation.value;
  }

  return { result: toolResult(call, output, false) };
}

/** What one tool call produced: its result, or the failure an `isError` result will answer. */
type ToolCallOutcome =
  | { readonly result: ToolResultChunk }
  | { readonly failure: ToolFailure };

/**
 * A tool-line failure: the error handed to `processError`, plus the recipe for the model-facing
 * message of a (possibly replaced) error.
 *
 * Framework-generated lines (unknown tool, failed validation) carry their full message as the
 * error's message: the model sees that message whether or not a processor replaced the error. An
 * `execute` throw keeps the framework's `Tool 'x' failed:` framing, with the replacement supplying
 * the detail after it.
 */
interface ToolFailure {
  /** The error `processError` observes — the original object, untouched. */
  readonly error: unknown;
  /** Builds the model-facing message of the (possibly replaced) error. */
  readonly toMessage: (error: unknown) => string;
}

/**
 * The six-piece context of a tool call (the tool execution context). Trace ids come
 * from the call's span — real ids when a tracer is attached and the trace is sampled, empty strings
 * when there is no tracer or the sampler rejected the trace (`NoOpSpan` semantics); `toolCallId` is
 * the provider's real id.
 */
function toolContext(
  call: ToolCallChunk,
  requestContext: RequestContext,
  toolSpan: Span | undefined,
): ToolContext {
  return {
    signal: requestContext.signal,
    runId: requestContext.runId,
    toolCallId: call.toolCallId,
    requestContext,
    traceId: toolSpan?.traceId ?? '',
    spanId: toolSpan?.id ?? '',
  };
}

function toolResult(call: ToolCallChunk, output: unknown, isError: boolean): ToolResultChunk {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output,
    isError,
  };
}

/**
 * The messages one completed step contributes to history: the assistant message (its text, its
 * tool calls, and any provider-executed results — those stay paired with their calls) and, when
 * the framework executed tools, the `tool` message carrying their results — the vendor-shaped
 * split of the processed record. The same messages extend the next prompt and are persisted by a
 * memory save. A step that contributed nothing (no text, no calls, no results) contributes no
 * messages.
 */
function toStepMessages(record: AgentStep, answered: ReadonlySet<string>): ModelMessage[] {
  const echoes = record.toolResults.filter((entry) => answered.has(entry.toolCallId));
  const messages: ModelMessage[] = [];
  const assistant = toAssistantMessage(record.text, record.toolCalls, echoes);
  if (assistant.content.length > 0) messages.push(assistant);
  const feedback = toToolMessage(record, answered);
  if (feedback !== undefined) messages.push(feedback);
  return messages;
}

/**
 * The `tool` message of a step's framework-executed results — the second half of `toStepMessages`,
 * on its own for a resumed step (`AgentRunResume`): its prompt already ends with the assistant
 * message, so only the results are new. `undefined` when every result was provider-executed (the
 * framework has nothing to feed back).
 */
function toToolMessage(record: AgentStep, answered: ReadonlySet<string>): ModelMessage | undefined {
  const feedback = record.toolResults.filter((entry) => !answered.has(entry.toolCallId));
  return feedback.length === 0
    ? undefined
    : { role: 'tool', content: feedback.map(toModelToolResultPart) };
}

/**
 * The text of a step's own assistant message — a resumed step's model output, read back from the
 * snapshot's prompt tail (`AgentRunResume`): its text parts concatenated, the same reading the loop
 * performs while streaming.
 */
function textOfAssistantMessage(message: ModelMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((part): part is ModelTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Tool call ids an assistant message already carries provider-executed results for. */
function idsOfProviderResults(message: ModelMessage): ReadonlySet<string> {
  return new Set(providerResultsOf(message).map((result) => result.toolCallId));
}

/**
 * The provider-executed results a step's assistant message echoes, back in chunk shape — a resumed
 * step's record carries them exactly like a streamed step's does. The value forms the loop itself
 * writes round-trip (`toModelToolResultOutput`); any other output shape a caller's own message
 * carried passes through as it is.
 */
function providerResultsOf(message: ModelMessage): ToolResultChunk[] {
  if (message.role !== 'assistant') return [];
  const results: ToolResultChunk[] = [];
  for (const part of message.content) {
    if (part.type !== 'tool-result') continue;
    results.push({
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: toChunkOutput(part.output),
      isError: part.output.type === 'error-text' || part.output.type === 'error-json',
    });
  }
  return results;
}

/** A message part's result output back in chunk shape: the value forms, or the output as given. */
function toChunkOutput(output: ModelToolResultOutput): unknown {
  switch (output.type) {
    case 'text':
    case 'json':
    case 'error-text':
    case 'error-json':
      return output.value;
    default:
      return output;
  }
}

/**
 * The assistant message of a finished step, appended to the prompt before the next model call: the
 * step's text (when it produced any), its tool calls, and the results the provider executed itself.
 * Framework-executed results are not here — they follow in the `tool` message. Echoing
 * provider-executed results inside the assistant message keeps every tool call paired with a
 * result in the vendor prompt shape (the AI SDK builds its response messages the same way).
 */
function toAssistantMessage(
  text: string,
  toolCalls: readonly ToolCallChunk[],
  providerResults: readonly ToolResultChunk[],
): ModelMessage {
  const content: Array<ModelTextPart | ModelToolCallPart | ModelToolResultPart> = [];
  if (text !== '') content.push({ type: 'text', text });
  for (const call of toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  for (const result of providerResults) content.push(toModelToolResultPart(result));
  return { role: 'assistant', content };
}

function toModelToolResultPart(result: ToolResultChunk): ModelToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    output: toModelToolResultOutput(result),
  };
}

/**
 * Maps a `tool-result` chunk onto the vendor prompt's result output (the same shape the AI SDK
 * produces): errors are `error-text`, string outputs are `text`, everything else is `json`.
 *
 * `json` values are run through a JSON round trip so the prompt only ever carries real JSON values
 * (`undefined` and non-serializable values become `null`) — providers stringify this shape.
 */
function toModelToolResultOutput(result: ToolResultChunk): ModelToolResultOutput {
  if (result.isError) return { type: 'error-text', value: messageOf(result.output) };
  if (typeof result.output === 'string') return { type: 'text', value: result.output };
  return { type: 'json', value: toJsonValue(result.output) };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
}

/**
 * The run's terminal values, built from its authoritative step records (processors' rewrites
 * included): the last step's text settles `text`, the records flatten into run-wide tool calls /
 * results, and usage accumulates across steps.
 *
 * A structured run (`structuredOutput`) also settles `object` here: the very text `text` reports is
 * parsed as JSON and validated against the schema — strictly, so a terminal text that does not
 * become the schema's value fails the run with `StructuredOutputError`
 * (execution semantics). Validating the processed record keeps one truth: what a
 * `processOutputStep` rewrote is both the run's text and the text the structured output is read from.
 */
async function runOutcome(
  steps: readonly AgentStep[],
  finishReason: FinishReason,
  structuredOutput: StructuredOutputConfig | undefined,
): Promise<AgentGenerateResult> {
  const text = steps.at(-1)?.text ?? '';
  return {
    text,
    object:
      structuredOutput === undefined
        ? undefined
        : await toStructuredObject(structuredOutput, text),
    toolCalls: steps.flatMap((step) => step.toolCalls),
    toolResults: steps.flatMap((step) => step.toolResults),
    usage: steps.reduce<Usage>((total, step) => addUsage(total, step.usage), UNKNOWN_USAGE),
    finishReason,
    steps,
  };
}

/** Usage before any step reported one: every field unknown. */
const UNKNOWN_USAGE: Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

/**
 * The synthesized finish of a resumed step (`AgentRunResume`): its model output — and with it its
 * real finish chunk — already streamed in the suspended run, so what remains to report is the step's
 * own reason (`'tool-calls'`: the calls it contributes) with usage the resumed segment never saw.
 */
const RESUMED_STEP_FINISH: FinishChunk = {
  type: 'finish',
  finishReason: 'tool-calls',
  usage: UNKNOWN_USAGE,
};

/**
 * Adds one step's usage onto the run total.
 *
 * Unknown stays unknown: a field no step reported stays `undefined` rather than collapsing to 0.
 * `totalTokens` is derived exactly like the normalization layer derives it per model part
 * (`normalize.ts` `toUsage`): input + output when both are known, unknown otherwise.
 */
function addUsage(total: Usage, stepUsage: Usage): Usage {
  const inputTokens = addTokens(total.inputTokens, stepUsage.inputTokens);
  const outputTokens = addTokens(total.outputTokens, stepUsage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : inputTokens + outputTokens,
  };
}

function addTokens(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}
