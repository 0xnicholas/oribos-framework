import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type { AgentRunOptions, AgentRunResume } from '@oribos/core/agent';
import { continueRun, createResumeLock } from '@oribos/core/agent-run';
import type { RunContinuation } from '@oribos/core/agent-run';
import type { ModelMessage, ToolCallChunk, ToolResultChunk } from '@oribos/core/model';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { assistantWithTools } from './helpers/agent.js';
import { captureRejection } from './helpers/assertions.js';

/**
 * `@oribos/core/agent-run` 的公开契约(ADR-0018):`continueRun` 从一个纯 `RunContinuation`
 * 记录构造 input / resume seed / traceId,调用包装器提供的 `start`,排空输出并物化终值;返回的
 * `output` 已 settle,包装器可读取自己的额外字段。`createResumeLock` 公开 join-in-flight 语义。
 * 断言只走公开入口(`@oribos/core/agent-run` / `@oribos/core/agent`)与假模型接缝。
 */

const CALL: ToolCallChunk = {
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'echo',
  input: 'hello',
};

const REJECTION: ToolResultChunk = {
  type: 'tool-result',
  toolCallId: 'call-1',
  toolName: 'echo',
  output: 'The user rejected the approval request.',
  isError: true,
};

/** 续跑段的 prompt:用户输入 + 挂起步自己的 assistant 消息(以 tool-call 结尾)。 */
const MESSAGES: readonly ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
  {
    role: 'assistant',
    content: [CALL],
  },
];

function echoAgent(execute: (input: string) => unknown = (input) => input): Agent {
  return assistantWithTools(
    fakeModel([{ text: 'Done.' }]),
    {
      echo: createTool({
        description: 'Echoes its input.',
        inputSchema: z.string(),
        execute,
      }),
    },
  );
}

interface Seen {
  readonly input: readonly ModelMessage[];
  readonly options: AgentRunOptions;
  readonly resume: AgentRunResume;
}

describe('continueRun:从纯记录构造续跑', () => {
  it('构造 input / seed / traceId,排空输出并物化终值;返回的 output 已 settle', async () => {
    const agent = echoAgent();
    const seen: Seen[] = [];
    const continuation: RunContinuation = {
      messages: MESSAGES,
      stepCount: 1,
      toolCalls: [CALL],
      traceId: 'a'.repeat(32),
    };

    const { output, result } = await continueRun(
      (input, options, resume) => {
        seen.push({ input, options, resume });
        return Object.assign(agent.stream(input, { ...options, resume }), { marker: 'extra' });
      },
      continuation,
      { maxSteps: 3 },
    );

    // 记录 → start 的映射:消息列表、全局 step 计数、持有调用;traceId 走 run option。
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toEqual(MESSAGES);
    expect(seen[0]?.input).not.toBe(MESSAGES);
    expect(seen[0]?.options).toMatchObject({ maxSteps: 3, traceId: 'a'.repeat(32) });
    expect(seen[0]?.resume).toEqual({ stepCount: 1, toolCalls: [CALL] });
    expect(seen[0]?.resume.toolCalls).not.toBe(continuation.toolCalls);

    // 排空 + materialize:终值是 start 那条 run 的终态记录(重放步 + 续跑步)。
    expect(result.text).toBe('Done.');
    expect(result.finishReason).toBe('stop');
    expect(result.steps).toHaveLength(2);
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'echo',
        output: 'hello',
        isError: false,
      },
    ]);

    // 返回的 output 就是包装器自己的对象(额外字段可读),且已排空。
    expect(output.marker).toBe('extra');
    expect(await output.text).toBe('Done.');
    expect(await output[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });

  it('answers 进入 resume seed:扣住的调用不执行,预置结果回喂模型', async () => {
    const execute = vi.fn(() => 'should not run');
    const agent = echoAgent(execute);
    const seen: Seen[] = [];
    const answers: readonly ToolResultChunk[] = [REJECTION];

    const { result } = await continueRun(
      (input, options, resume) => {
        seen.push({ input, options, resume });
        return agent.stream(input, { ...options, resume });
      },
      { messages: MESSAGES, stepCount: 1, toolCalls: [CALL], answers },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(seen[0]?.resume.answers).toEqual([REJECTION]);
    expect(seen[0]?.resume.answers).not.toBe(answers);
    expect(result.toolResults).toEqual([REJECTION]);
    expect(result.text).toBe('Done.');
  });

  it('没有 answers / traceId 时不构造空字段(trace 选项原样)', async () => {
    const agent = echoAgent();
    const seen: Seen[] = [];
    const runOptions: AgentRunOptions = { maxSteps: 2 };

    await continueRun(
      (input, options, resume) => {
        seen.push({ input, options, resume });
        return agent.stream(input, { ...options, resume });
      },
      { messages: MESSAGES, stepCount: 1, toolCalls: [CALL] },
      runOptions,
    );

    expect(seen[0]?.resume).not.toHaveProperty('answers');
    expect(seen[0]?.options).toEqual({ maxSteps: 2 });
    expect(seen[0]?.options).not.toBe(runOptions);
    expect(seen[0]?.options).not.toHaveProperty('traceId');
  });

  it('run 失败仍以 rejection 表达', async () => {
    const failure = new Error('model unavailable');
    const agent = assistantWithTools(fakeModel([{ fail: failure }]), {});
    const error = await captureRejection(() =>
      continueRun(
        (input, options, resume) => agent.stream(input, { ...options, resume }),
        { messages: MESSAGES, stepCount: 1, toolCalls: [CALL] },
      ),
    );

    expect(error).toBe(failure);
  });

  it('包装器 start 抛错时继续传播', async () => {
    const failure = new Error('no snapshot store');

    const error = await captureRejection(() =>
      continueRun(
        () => {
          throw failure;
        },
        { messages: MESSAGES, stepCount: 0, toolCalls: [CALL] },
      ),
    );

    expect(error).toBe(failure);
  });
});

describe('createResumeLock:公开的 in-flight 去重机制', () => {
  it('同一 (store, runId) 的并发调用合并为一次;settle 后条目清除', async () => {
    const lock = createResumeLock();
    const store = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;

    const first = lock.run(store, 'run-1', async () => {
      runs += 1;
      await gate;
      return 'first';
    });
    const second = lock.run(store, 'run-1', async () => {
      runs += 1;
      return 'second';
    });

    expect(second).toBe(first);
    release();
    expect(await first).toBe('first');
    expect(runs).toBe(1);

    // settle 即删:同一个身份可以再次恢复
    expect(await lock.run(store, 'run-1', async () => 'again')).toBe('again');
  });

  it('不同 store 或不同 runId 相互独立', async () => {
    const lock = createResumeLock();
    const store = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;

    const held = lock.run(store, 'run-1', async () => {
      runs += 1;
      await gate;
      return 'held';
    });
    // 同 store、不同 runId:Map 的键是 runId,不应合并
    const otherRunId = lock.run(store, 'run-2', async () => {
      runs += 1;
      return 'run-2';
    });
    // 不同 store、同 runId:WeakMap 的键是 store,不应合并
    const otherStore = lock.run({}, 'run-1', async () => {
      runs += 1;
      return 'store-2';
    });

    expect(await otherRunId).toBe('run-2');
    expect(await otherStore).toBe('store-2');
    expect(runs).toBe(3);
    release();
    expect(await held).toBe('held');
  });

  it('失败也清除条目', async () => {
    const lock = createResumeLock();
    const failure = new Error('load failed');

    await expect(
      lock.run({}, 'run-1', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await lock.run({}, 'run-1', async () => 'retried')).toBe('retried');
  });
});
