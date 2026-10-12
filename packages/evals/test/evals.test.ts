import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { scoreRun } from '@oribos/evals';
import { createScorerProcessor } from '@oribos/evals';
import type {
  RunScoreTarget,
  RunScorer,
  StepScorer,
  StepScorerOutcome,
  StepScoreTarget,
} from '@oribos/evals';

/**
 * `@oribos/evals` — Evals / scorers 能力包(追赶面首批,#176;CUT-AG1 承载缝:Processor 或
 * 独立 scorer 消费 run 结果,`steps` / `text` / `usage` 均公开面,核心零改动)。
 *
 * 两个消费点:scoreRun 事后整跑打分(generate() 终值与 stream() 输出对象同一入口——输出对象
 * 双消费);createScorerProcessor 把 per-step scorer 接进 live run(Processor 三钩唯一横切点,
 * 只观察不改写)。断言只走公开面与 fake model 抓手(issue #21 测试决策)。
 */

/** 记录所见 target 的计分器工厂:value 恒 1,故事由 target 内容讲。 */
function record(name: string, seen: RunScoreTarget[]): RunScorer {
  return {
    name,
    score: (target) => {
      seen.push(target);
      return { value: 1 };
    },
  };
}

describe('scoreRun:事后整跑打分(独立 scorer 半)', () => {
  it('消费 generate() 终值——target 即公开面 text/steps/usage/finishReason,outcome 按声明序', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolName: 'lookup', input: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: 'The answer is 42.', usage: { inputTokens: 20, outputTokens: 7 } },
    ]);
    const agent = new Agent({
      name: 'answerer',
      instructions: 'Answer with the lookup tool, then report.',
      model,
      tools: {
        lookup: createTool({
          description: 'Looks up the answer.',
          execute: () => ({ answer: 42 }),
        }),
      },
    });
    const result = await agent.generate('What is the answer?');

    const seen: RunScoreTarget[] = [];
    const outcomes = await scoreRun(result, [record('first', seen), record('second', seen)]);

    expect(outcomes).toEqual([
      { scorer: 'first', ok: true, score: { value: 1 } },
      { scorer: 'second', ok: true, score: { value: 1 } },
    ]);
    // target 逐字段对脚本事实:终态文本 / 终止理由 / 两步记录 / 累计 usage。
    for (const target of seen) {
      expect(target.text).toBe('The answer is 42.');
      expect(target.finishReason).toBe('stop');
      expect(target.steps).toHaveLength(2);
      expect(target.steps[0]?.toolCalls.map((call) => call.toolName)).toEqual(['lookup']);
      expect(target.usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
    }
  });

  it('消费 stream() 输出对象——promise 终值与 generate() 终值同一入口(输出对象双消费)', async () => {
    const model = fakeModel([{ text: 'Streamed answer.', usage: { inputTokens: 8, outputTokens: 4 } }]);
    const agent = new Agent({ name: 'streamer', instructions: 'Answer.', model });

    // 输出对象的流式消费照旧:先迭代 chunk,再把同一对象交给 scoreRun。
    const stream = agent.stream('Say something.');
    for await (const chunk of stream) {
      void chunk;
    }
    const seen: RunScoreTarget[] = [];
    const outcomes = await scoreRun(stream, [record('late', seen)]);

    expect(outcomes).toEqual([{ scorer: 'late', ok: true, score: { value: 1 } }]);
    expect(seen[0]?.text).toBe('Streamed answer.');
    expect(seen[0]?.finishReason).toBe('stop');
    expect(seen[0]?.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  });

  it('scorer 故障落 ok:false 条目且不殃及批次——抛错与非法 score 同构', async () => {
    const model = fakeModel([{ text: 'Fine.' }]);
    const agent = new Agent({ name: 'scored', instructions: 'Answer.', model });
    const result = await agent.generate('Hi.');
    const failure = new Error('judge unavailable');

    const outcomes = await scoreRun(result, [
      {
        name: 'throwing',
        score: () => {
          throw failure;
        },
      },
      { name: 'malformed', score: () => ({ value: Number.NaN }) },
      record('healthy', []),
    ]);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toEqual({ scorer: 'throwing', ok: false, error: failure });
    const malformed = outcomes[1];
    expect(malformed?.ok).toBe(false);
    if (malformed !== undefined && !malformed.ok) {
      expect(String(malformed.error)).toContain("scorer 'malformed' returned an invalid score");
    }
    expect(outcomes[2]).toEqual({ scorer: 'healthy', ok: true, score: { value: 1 } });
  });

  it('空 scorers 是合法空批——不记分、不报错', async () => {
    const model = fakeModel([{ text: 'Fine.' }]);
    const agent = new Agent({ name: 'idle', instructions: 'Answer.', model });
    await expect(scoreRun(await agent.generate('Hi.'), [])).resolves.toEqual([]);
  });
});

describe('createScorerProcessor:per-step scorer 接进 live run(Processor 接线半)', () => {
  it('每个完成的 step 按声明序打分,outcome 钉 stepIndex;只观察不改写', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolName: 'lookup', input: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: 'Done: 42.', usage: { inputTokens: 20, outputTokens: 7 } },
    ]);
    const outcomes: StepScorerOutcome[] = [];
    const seen: StepScoreTarget[] = [];
    const stepRecord = (name: string): StepScorer => ({
      name,
      score: (target) => {
        seen.push(target);
        return { value: target.stepIndex };
      },
    });
    const agent = new Agent({
      name: 'wired',
      instructions: 'Look up, then answer.',
      model,
      tools: { lookup: createTool({ description: 'Looks up.', execute: () => 42 }) },
      processors: [
        createScorerProcessor({
          scorers: [stepRecord('step-a'), stepRecord('step-b')],
          onScore: (outcome) => {
            outcomes.push(outcome);
          },
        }),
      ],
    });

    const result = await agent.generate('Answer?');

    // run 本身照常:文本、finishReason、两步记录——接线只观察。
    expect(result.text).toBe('Done: 42.');
    expect(result.finishReason).toBe('stop');
    expect(result.steps).toHaveLength(2);

    // 2 steps × 2 scorers,每个 step 内按声明序,outcome 钉着 stepIndex。
    expect(outcomes).toEqual([
      { scorer: 'step-a', ok: true, score: { value: 0 }, stepIndex: 0 },
      { scorer: 'step-b', ok: true, score: { value: 0 }, stepIndex: 0 },
      { scorer: 'step-a', ok: true, score: { value: 1 }, stepIndex: 1 },
      { scorer: 'step-b', ok: true, score: { value: 1 }, stepIndex: 1 },
    ]);

    // target 即 processOutputStep 入参原样:step 与 run 的权威记录一致,requestContext 带 runId。
    expect(seen).toHaveLength(4);
    expect(seen[0]?.step).toEqual(result.steps[0]);
    expect(seen[2]?.step).toEqual(result.steps[1]);
    expect(seen[0]?.step.toolCalls.map((call) => call.toolName)).toEqual(['lookup']);
    expect(seen[0]?.step.toolResults).toHaveLength(1);
    expect(seen[0]?.step.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(typeof seen[0]?.requestContext.runId).toBe('string');
  });

  it('scorer 故障不炸 run:ok:false 落 sink,其余 scorer 与 run 照常', async () => {
    const model = fakeModel([{ text: 'Still fine.' }]);
    const outcomes: StepScorerOutcome[] = [];
    const failure = new Error('heuristic blew up');
    const agent = new Agent({
      name: 'observed',
      instructions: 'Answer.',
      model,
      processors: [
        createScorerProcessor({
          scorers: [
            {
              name: 'brittle',
              score: () => {
                throw failure;
              },
            },
            { name: 'steady', score: (target) => ({ value: target.step.text.length }) },
          ],
          onScore: (outcome) => {
            outcomes.push(outcome);
          },
        }),
      ],
    });

    const result = await agent.generate('Hi.');

    expect(result.text).toBe('Still fine.');
    expect(result.finishReason).toBe('stop');
    expect(outcomes).toEqual([
      { scorer: 'brittle', ok: false, error: failure, stepIndex: 0 },
      { scorer: 'steady', ok: true, score: { value: 'Still fine.'.length }, stepIndex: 0 },
    ]);
  });

  it('sink 是用户代码:onScore 抛错即处理器失败,run 随之失败', async () => {
    const model = fakeModel([{ text: 'Never seen.' }]);
    const sinkFailure = new Error('scoreboard unavailable');
    const agent = new Agent({
      name: 'guarded',
      instructions: 'Answer.',
      model,
      processors: [
        createScorerProcessor({
          scorers: [{ name: 'any', score: () => ({ value: 1 }) }],
          onScore: () => {
            throw sinkFailure;
          },
        }),
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toBe(sinkFailure);
  });

  it('构造校验:空 scorers 与非函数 onScore 即报,点名字段', () => {
    expect(() => createScorerProcessor({ scorers: [], onScore: () => {} })).toThrowError(
      /createScorerProcessor: `scorers` must name at least one scorer/,
    );
    expect(() =>
      createScorerProcessor({
        scorers: [{ name: 'any', score: () => ({ value: 1 }) }],
        onScore: undefined as never,
      }),
    ).toThrowError(/createScorerProcessor: `onScore` must be a function/);
  });
});
