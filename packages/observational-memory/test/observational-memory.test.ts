import { describe, expect, it } from 'vitest';
import { Memory, createInMemoryStore, supportsWorkingMemory } from '@oribos/core/memory';
import type {
  MemoryStore,
  SaveMessage,
  StoredMessage,
  WorkingMemoryStore,
} from '@oribos/core/memory';
import type { Model, ModelCallOptions, ModelPrompt } from '@oribos/core/model';
import {
  createInMemoryObservationStore,
  createObservationalMemoryStore,
} from '@oribos/observational-memory';
import type {
  ObservationStore,
  ObservationalMemoryConfig,
  TokenCounter,
} from '@oribos/observational-memory';
import { fakeModel } from '@oribos/testing';
import { z } from 'zod';
import { captureRejection, expectAssignable } from './helpers/assertions.js';

/**
 * `@oribos/observational-memory` — OM 类压缩能力包(追赶面远层,CUT-MEM2;#196)。
 *
 * 承载缝 = `Memory.recall → MemoryStore.listMessages`(无游标窗口读):积压过阈在当次请求内跑
 * 最老一段 Observer、观察过阈跑 Reflector,观察块以一条 system 消息前置;分页透传零副作用,
 * 消息不可变与 recall 单入口两根钉子不动,核心零改动。断言只走公开面:包入口、`Memory` 公开
 * 方法、注入的 store / 模型(fake model)录制的 prompt(issue #21 测试决策)。
 */

// ── 测试抓手:平计数 token 估计、假观察存储、消息构造 ──────────────────────────────────────

/** 每条渲染文本计固定体积:阈值算术在用例里可读、可算。 */
function countEach(perText: number): TokenCounter {
  return (texts) => texts.map(() => perText);
}

/** 录制调动入参的计数器:断言 countTokens 收到的正是「每条消息一条渲染文本」。 */
function recordingCounter(
  perText: number,
): TokenCounter & { readonly calls: readonly (readonly string[])[] } {
  const calls: string[][] = [];
  const counter: TokenCounter = (texts) => {
    calls.push([...texts]);
    return texts.map(() => perText);
  };
  return Object.assign(counter, { calls });
}

function userMessage(text: string): SaveMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** 无工作记忆能力的 store:只实现 6 个必备方法(条件对缺席)。 */
function createPlainStore(): MemoryStore {
  const base = createInMemoryStore();
  return {
    getThreadById: (id) => base.getThreadById(id),
    saveThread: (thread) => base.saveThread(thread),
    deleteThread: (id) => base.deleteThread(id),
    listThreads: (query) => base.listThreads(query),
    listMessages: (query) => base.listMessages(query),
    saveMessages: (messages) => base.saveMessages(messages),
  };
}

/** 消息正文(断言用):system 直取字符串,其余拼 text 部分。 */
function textOf(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  const parts = message.content as readonly { type: string; text?: string }[];
  return parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/** prompt 的全文(断言 fake model 收到的输入用)。 */
function promptText(prompt: ModelPrompt): string {
  return prompt.map((message) => textOf(message)).join('\n');
}

/** 播种 n 条消息到 thread-1,返回按序的存储消息。 */
async function seed(memory: Memory, texts: readonly string[]): Promise<StoredMessage[]> {
  const saved: StoredMessage[] = [];
  for (const text of texts) {
    const [message] = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage(text)],
    });
    expect(message).toBeDefined();
    saved.push(message!);
  }
  return saved;
}

const TURNS = ['Turn 1', 'Turn 2', 'Turn 3', 'Turn 4', 'Turn 5', 'Turn 6', 'Turn 7', 'Turn 8'];

// ── 触发与注入:积压过阈 → 当次请求内观察,观察块前置 ─────────────────────────────────────

describe('触发与注入:积压过阈 → 当次请求内观察,观察块前置', () => {
  it('过阈:Observer 收到最老一段 ≈ 阈值体量的转录,观察落库,结果 = 一条前置 system 观察块 + 窗口原样', async () => {
    const observer = fakeModel([{ text: 'Observed: turns 1-2.' }]);
    const observations = createInMemoryObservationStore();
    const counter = recordingCounter(10);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        observations,
        thresholds: { observation: 20 },
        countTokens: counter,
      }),
      lastMessages: 2,
    });
    const saved = await seed(memory, TURNS.slice(0, 6)); // 窗口 = 5,6;积压 = 1..4(体积 40 > 20)

    const recalled = await memory.recall({ threadId: 'thread-1' });

    // 一次 Observer 调用;输入 = system 指令 + 最老一段(turn 1、2)的渲染转录,不含 turn 3。
    expect(observer.generateCalls).toHaveLength(1);
    const call = observer.generateCalls[0] as ModelCallOptions;
    expect(call.prompt[0]?.role).toBe('system');
    const input = promptText(call.prompt);
    expect(input).toContain('user: Turn 1');
    expect(input).toContain('user: Turn 2');
    expect(input).not.toContain('user: Turn 3');

    // countTokens 收到的是「每条消息一条渲染文本」(role 前缀 + 正文)。
    expect(counter.calls).toHaveLength(1);
    expect(counter.calls[0]).toEqual(['user: Turn 1', 'user: Turn 2', 'user: Turn 3', 'user: Turn 4']);

    // 观察记录:标签、来源消息、资源与文本。
    const records = await observations.list('thread-1');
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe('observation');
    expect(record.threadId).toBe('thread-1');
    expect(record.resourceId).toBe('user-1');
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.sourceIds).toEqual([saved[0]!.id, saved[1]!.id]);
    expect(record.text).toBe('Observed: turns 1-2.');

    // 结果 = 派生 system 块在前,窗口原样在后(消息不可变:原消息逐字段相等)。
    expect(recalled).toHaveLength(3);
    expect(recalled[0]?.role).toBe('system');
    expect(textOf(recalled[0]!)).toContain('Observed: turns 1-2.');
    expect(recalled[0]?.id).not.toBe(saved[4]!.id);
    expect(recalled.slice(1)).toEqual([saved[4], saved[5]]);
  });

  it('未过阈:积压体积 ≤ 阈值 → 零模型调用,结果 = 窗口', async () => {
    const observer = fakeModel([]);
    const observations = createInMemoryObservationStore();
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        observations,
        thresholds: { observation: 100 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    const saved = await seed(memory, TURNS.slice(0, 6)); // 积压 40 ≤ 100

    const recalled = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(0);
    expect(recalled).toEqual([saved[4], saved[5]]);
    expect(await observations.list('thread-1')).toEqual([]);
  });

  it('无积压:窗口盖住全部历史 → 零模型调用', async () => {
    const observer = fakeModel([]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({ observer, countTokens: countEach(10) }),
      lastMessages: 10,
    });
    await seed(memory, TURNS.slice(0, 3));

    const recalled = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(0);
    expect(recalled).toHaveLength(3);
  });

  it('稳态再读:积压已清 → 零新调用,既有观察块照常前置', async () => {
    const observer = fakeModel([{ text: 'Observed: turns 1-2.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS.slice(0, 6));
    await memory.recall({ threadId: 'thread-1' });

    const again = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(1);
    expect(again[0]?.role).toBe('system');
    expect(textOf(again[0]!)).toContain('Observed: turns 1-2.');
  });

  it('空 thread:空历史 → 空结果、零调用、零记录', async () => {
    const observer = fakeModel([]);
    const observations = createInMemoryObservationStore();
    const memory = new Memory({
      storage: createObservationalMemoryStore({ observer, observations, countTokens: countEach(10) }),
    });

    const recalled = await memory.recall({ threadId: 'unknown-thread' });

    expect(recalled).toEqual([]);
    expect(observer.generateCalls).toHaveLength(0);
    expect(await observations.list('unknown-thread')).toEqual([]);
  });
});

// ── 游标逐段推进:一次一段,下一读接上 ────────────────────────────────────────────────────

describe('游标逐段推进:一次只观察最老一段,下一读接上', () => {
  it('召回 #1 观察 1-2,#2 观察 3-4(不重复),#3 余量不过阈不再观察;注入按时间序累加', async () => {
    const observer = fakeModel([{ text: 'Note: turns 1-2.' }, { text: 'Note: turns 3-4.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS); // 窗口 = 7,8;积压 = 1..6

    await memory.recall({ threadId: 'thread-1' });
    const second = await memory.recall({ threadId: 'thread-1' });
    const third = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(2);
    const firstInput = promptText((observer.generateCalls[0] as ModelCallOptions).prompt);
    const secondInput = promptText((observer.generateCalls[1] as ModelCallOptions).prompt);
    expect(firstInput).toContain('user: Turn 1');
    expect(firstInput).not.toContain('user: Turn 3');
    expect(secondInput).toContain('user: Turn 3');
    expect(secondInput).toContain('user: Turn 4');
    expect(secondInput).not.toContain('user: Turn 1');

    // 注入 = 两条观察块,按时间序(1-2 在前,3-4 在后);第三读余量(5-6,体积 20 ≤ 20)不观察。
    const content = textOf(second[0]!);
    expect(content).toContain('Note: turns 1-2.');
    expect(content.indexOf('Note: turns 1-2.')).toBeLessThan(content.indexOf('Note: turns 3-4.'));
    expect(textOf(third[0]!)).toContain('Note: turns 3-4.');
    expect(observer.generateCalls).toHaveLength(2);
  });
});

// ── 反思合并:观察累计过阈 → Reflector 合并为单块前置 ────────────────────────────────────

describe('反思合并:观察累计过阈 → Reflector 合并,反思块在观察块之前', () => {
  it('两次观察(合计过反思阈)合并为反思:被覆盖的观察不再单列;新观察随后追加在反思块之后', async () => {
    const observer = fakeModel([
      { text: 'Note: turns 1-2.' },
      { text: 'Note: turns 3-4.' },
      { text: 'Note: turns 5-6.' },
    ]);
    const reflector = fakeModel([{ text: 'Reflection: turns 1-4 condensed.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        reflector,
        thresholds: { observation: 20, reflection: 15 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS);

    await memory.recall({ threadId: 'thread-1' });
    const second = await memory.recall({ threadId: 'thread-1' }); // 观察到 3-4 后累计 20 > 15 → 反思

    expect(reflector.generateCalls).toHaveLength(1);
    const reflectorInput = promptText((reflector.generateCalls[0] as ModelCallOptions).prompt);
    expect(reflectorInput).toContain('New observations:');
    expect(reflectorInput).toContain('- Note: turns 1-2.');
    expect(reflectorInput).toContain('- Note: turns 3-4.');

    const secondContent = textOf(second[0]!);
    expect(secondContent).toContain('Reflection: turns 1-4 condensed.');
    expect(secondContent).not.toContain('Note: turns 1-2.'); // 被反思覆盖 → 不再单列
    expect(secondContent).not.toContain('[observation]');

    // 追加两条新消息:下一读观察 5-6,未过反思阈 → 反思块后接新观察块。
    await seed(memory, ['Turn 9', 'Turn 10']);
    const fourth = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(3);
    expect(reflector.generateCalls).toHaveLength(1);
    const fourthContent = textOf(fourth[0]!);
    expect(fourthContent).toContain('[reflection] Reflection: turns 1-4 condensed.');
    expect(fourthContent).toContain('Note: turns 5-6.');
    expect(fourthContent.indexOf('Reflection: turns 1-4 condensed.')).toBeLessThan(
      fourthContent.indexOf('Note: turns 5-6.'),
    );
  });

  it('未配 reflector:观察只累积、永不反思,全部观察按序注入', async () => {
    const observer = fakeModel([{ text: 'Note A.' }, { text: 'Note B.' }]);
    const observations = createInMemoryObservationStore();
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        observations,
        thresholds: { observation: 20, reflection: 15 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS);

    await memory.recall({ threadId: 'thread-1' });
    const second = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(2);
    const records = await observations.list('thread-1');
    expect(records.map((record) => record.kind)).toEqual(['observation', 'observation']);
    const content = textOf(second[0]!);
    expect(content).toContain('Note A.');
    expect(content).toContain('Note B.');
  });
});

// ── 分页透传:before 是原始回读路径,零副作用 ────────────────────────────────────────────

describe('分页透传:before 游标 = 原始回读路径', () => {
  it('分页结果与裸 store 完全一致,零模型调用、零记录写入、无注入', async () => {
    const rawStore = createInMemoryStore();
    const observer = fakeModel([]);
    const observations = createInMemoryObservationStore();
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        storage: rawStore,
        observer,
        observations,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 3,
    });
    const saved = await seed(memory, TURNS);

    const paged = await memory.recall({ threadId: 'thread-1', before: saved[7]!.id });
    const expected = await rawStore.listMessages({
      threadId: 'thread-1',
      limit: 3,
      order: 'asc',
      before: saved[7]!.id,
    });

    expect(paged).toEqual(expected);
    expect(observer.generateCalls).toHaveLength(0);
    expect(await observations.list('thread-1')).toEqual([]);
  });
});

// ── 同 thread 并发读去重 ─────────────────────────────────────────────────────────────────

describe('同 thread 并发读:进程内 at-most-one 压缩', () => {
  it('两读并发触发同一积压 → 一次 Observer 调用,两读都拿到观察块', async () => {
    const observer = fakeModel([{ text: 'Observed once.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS.slice(0, 6));

    const [first, second] = await Promise.all([
      memory.recall({ threadId: 'thread-1' }),
      memory.recall({ threadId: 'thread-1' }),
    ]);

    expect(observer.generateCalls).toHaveLength(1);
    expect(textOf(first[0]!)).toContain('Observed once.');
    expect(textOf(second[0]!)).toContain('Observed once.');
  });
});

// ── 呈现顺序:order desc 时派生块落在时间序首位(数组末尾) ───────────────────────────────

describe('呈现顺序:order 只翻窗口,派生块锚在时间序首位', () => {
  it('order desc:窗口保持倒序在前,派生块在数组末尾', async () => {
    const observer = fakeModel([{ text: 'Observed.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    const saved = await seed(memory, TURNS.slice(0, 6));

    const recalled = await memory.recall({ threadId: 'thread-1', order: 'desc' });

    expect(recalled).toHaveLength(3);
    expect(recalled[0]).toEqual(saved[5]);
    expect(recalled[1]).toEqual(saved[4]);
    expect(recalled[2]?.role).toBe('system');
    expect(textOf(recalled[2]!)).toContain('Observed.');
  });
});

// ── 与下层增强共存:积压边界 = 最新 limit 条(下层并回的旧消息仍可被观察) ─────────────────

describe('与下层增强共存:积压边界 = 最新 limit 条', () => {
  it('下层把窗口外的旧消息并回结果时,该消息仍算积压(不被当作窗口边缘)', async () => {
    // 裸 store 播种 4 条;包装层模拟 @oribos/rag:无游标读把窗口前一条旧消息并回结果。
    const base = createInMemoryStore();
    const seeder = new Memory({ storage: base });
    const saved = await seed(seeder, TURNS.slice(0, 4));
    const mergingStore: MemoryStore = {
      getThreadById: (id) => base.getThreadById(id),
      saveThread: (thread) => base.saveThread(thread),
      deleteThread: (id) => base.deleteThread(id),
      listThreads: (query) => base.listThreads(query),
      saveMessages: (messages) => base.saveMessages(messages),
      listMessages: async (query) => {
        const result = await base.listMessages(query);
        if (query.before !== undefined || result.length === 0) return result;
        const oldest = [...result].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
        if (oldest === undefined) return result;
        const older = await base.listMessages({
          threadId: query.threadId,
          limit: 1,
          before: oldest.id,
          order: 'asc',
        });
        const extra = older[0];
        return extra === undefined ? result : [extra, ...result];
      },
    };
    const observer = fakeModel([{ text: 'Observed the deep past.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        storage: mergingStore,
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 1,
    });

    // 窗口 limit=1 → 真窗口 = turn 4;下层另把 turn 3 并回。积压 = 1..3(30 > 20)→ 观察 1-2;
    // 若边界错取并回结果的边缘(turn 3),积压只剩 1..2(20 ≤ 20)→ 不会观察。
    const recalled = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(1);
    const input = promptText((observer.generateCalls[0] as ModelCallOptions).prompt);
    expect(input).toContain('user: Turn 1');
    expect(input).toContain('user: Turn 2');
    expect(input).not.toContain('user: Turn 3');
    expect(recalled).toHaveLength(3); // 派生块 + [并回的 turn 3,窗口 turn 4]
    expect(recalled[0]?.role).toBe('system');
    expect(recalled[1]).toEqual(saved[2]);
    expect(recalled[2]).toEqual(saved[3]);
  });
});

// ── 转录渲染:工具调用 / 结果进转录,reasoning 不进 ──────────────────────────────────────

describe('转录渲染:模型可见内容进转录,模型内部内容不进', () => {
  it('Observer 转录含 tool call 渲染,不含 reasoning,不含窗口内工具的 tool result', async () => {
    const observer = fakeModel([{ text: 'Observed the lookup request.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 15 },
        countTokens: countEach(10),
      }),
      lastMessages: 1,
    });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('Look it up')],
    });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'secret-thought' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { q: 'cat' } },
          ],
        },
      ],
    });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'lookup',
              output: { type: 'text', value: 'the answer 42' },
            },
          ],
        },
      ],
    });

    const recalled = await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(1);
    const input = promptText((observer.generateCalls[0] as ModelCallOptions).prompt);
    expect(input).toContain('user: Look it up');
    expect(input).toContain('[tool call: lookup({"q":"cat"})]');
    expect(input).not.toContain('secret-thought');
    expect(input).not.toContain('the answer 42'); // tool result 在窗口内,不在被观察段
    expect(recalled).toHaveLength(2);
  });
});

// ── 默认体量估计:字符启发式(无 countTokens 注入) ──────────────────────────────────────

describe('默认体量估计:字符启发式', () => {
  it('无 countTokens 时按 字符/4 估计:过阈即观察,段长由启发式决定', async () => {
    const observer = fakeModel([{ text: 'Observed the long first message.' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 1 },
      }),
      lastMessages: 1,
    });
    await seed(memory, ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)]);

    await memory.recall({ threadId: 'thread-1' });

    expect(observer.generateCalls).toHaveLength(1);
    const input = promptText((observer.generateCalls[0] as ModelCallOptions).prompt);
    expect(input).toContain('a'.repeat(50));
    expect(input).not.toContain('b'.repeat(10)); // 阈值 1 → 最老一段 = 只够一条
  });
});

// ── 端口语义与能力透传 ──────────────────────────────────────────────────────────────────

describe('端口语义与能力透传', () => {
  it('工作记忆条件对透传:包装后 WM 读写回环照常', async () => {
    const schema = z.object({ preference: z.string() });
    const store = createObservationalMemoryStore({
      observer: fakeModel([]),
      countTokens: countEach(10),
    });
    expect(supportsWorkingMemory(store)).toBe(true);
    const memory = new Memory({ storage: store, workingMemory: { schema } });

    await memory.updateWorkingMemory({ resource: 'user-1', patch: { preference: 'concise answers' } });
    expect(await memory.getWorkingMemory('user-1')).toEqual({ preference: 'concise answers' });
  });

  it('deleteThread 级联清该 thread 的观察记录与消息;重建同名 thread 不残留旧块', async () => {
    const observer = fakeModel([{ text: 'Observed.' }, { text: 'Observed again.' }]);
    const observations = createInMemoryObservationStore();
    const store = createObservationalMemoryStore({
      observer,
      observations,
      thresholds: { observation: 20 },
      countTokens: countEach(10),
    });
    const memory = new Memory({ storage: store, lastMessages: 2 });
    await seed(memory, TURNS.slice(0, 6));
    await memory.recall({ threadId: 'thread-1' });
    expect(await observations.list('thread-1')).toHaveLength(1);

    await store.deleteThread('thread-1');

    expect(await observations.list('thread-1')).toEqual([]);
    expect(await memory.recall({ threadId: 'thread-1' })).toEqual([]);
  });

  it('thread 记录面透传:经包装 saveThread 后 getThreadById 读回', async () => {
    const store = createObservationalMemoryStore({ observer: fakeModel([]) });
    const now = new Date();
    await store.saveThread({ id: 'thread-1', resourceId: 'user-1', createdAt: now, updatedAt: now });

    const thread = await store.getThreadById('thread-1');

    expect(thread).toMatchObject({ id: 'thread-1', resourceId: 'user-1' });
  });
});

// ── 包装表面:基础窗口契约与能力透传(ADR-0021)──────────────────────────────────────────

describe('包装表面:基础窗口契约与能力透传', () => {
  it('观察注入时,内层基础窗口的每条消息恰好一次且相对顺序不变(asc / desc)', async () => {
    const rawStore = createInMemoryStore();
    const observer = fakeModel([{ text: 'Observed: turns 1-2.' }]);
    const store = createObservationalMemoryStore({
      storage: rawStore,
      observer,
      thresholds: { observation: 20 },
      countTokens: countEach(10),
    });
    const memory = new Memory({ storage: store, lastMessages: 2 });
    await seed(memory, TURNS.slice(0, 6));

    for (const order of [undefined, 'asc', 'desc'] as const) {
      const query =
        order === undefined
          ? { threadId: 'thread-1', limit: 2 }
          : { threadId: 'thread-1', limit: 2, order };
      const baseWindow = await rawStore.listMessages(query);
      const recalled = await store.listMessages(query);

      const baseIds = baseWindow.map((message) => message.id);
      const recalledIds = recalled.map((message) => message.id);
      const extras = recalled.filter((message) => !baseIds.includes(message.id));

      // 基础窗口成员逐一保留、相对顺序不变;注入只增不删。
      expect(recalledIds.filter((id) => baseIds.includes(id))).toEqual(baseIds);
      expect(new Set(recalledIds).size).toBe(recalledIds.length);
      expect(extras).toHaveLength(1);
      expect(extras[0]?.role).toBe('system');
      expect(textOf(extras[0]!)).toContain('Observed: turns 1-2.');
      // order 缺省 = port 默认 desc:派生块锚在时间序首位(数组末尾);asc 才在前。
      expect(recalled[order === 'asc' ? 0 : recalled.length - 1]).toBe(extras[0]);
    }
  });

  it('before 精确透传内层结果:零模型调用、零观察存储写入', async () => {
    const rawStore = createInMemoryStore();
    const baseObservations = createInMemoryObservationStore();
    let writes = 0;
    const observations: ObservationStore = {
      list: (threadId) => baseObservations.list(threadId),
      save: async (record) => {
        writes += 1;
        await baseObservations.save(record);
      },
      deleteByThread: (threadId) => baseObservations.deleteByThread(threadId),
    };
    const observer = fakeModel([]);
    const store = createObservationalMemoryStore({
      storage: rawStore,
      observer,
      observations,
      thresholds: { observation: 20 },
      countTokens: countEach(10),
    });
    const memory = new Memory({ storage: store, lastMessages: 3 });
    const saved = await seed(memory, TURNS);

    const query = {
      threadId: 'thread-1',
      limit: 3,
      order: 'asc' as const,
      before: saved[7]!.id,
    };
    const expected = await rawStore.listMessages(query);
    const paged = await store.listMessages(query);

    expect(paged).toEqual(expected);
    expect(observer.generateCalls).toHaveLength(0);
    expect(writes).toBe(0);
    expect(await observations.list('thread-1')).toEqual([]);
  });

  it('supportsWorkingMemory 条件对:有能力 → true 且两方法都在;无能力 / 半实现 → false 且两方法都缺席', () => {
    const capable = createObservationalMemoryStore({ observer: fakeModel([]) });
    expect(supportsWorkingMemory(capable)).toBe(true);
    expect(typeof capable.getResource).toBe('function');
    expect(typeof capable.saveResource).toBe('function');

    const wrappedPlain = createObservationalMemoryStore({
      storage: createPlainStore(),
      observer: fakeModel([]),
    });
    expect(supportsWorkingMemory(wrappedPlain)).toBe(false);
    expect(wrappedPlain.getResource).toBeUndefined();
    expect(wrappedPlain.saveResource).toBeUndefined();

    // 半实现按缺席处理:包装后条件对成对不暴露。
    const half: MemoryStore = { ...createPlainStore(), getResource: async () => null };
    const wrappedHalf = createObservationalMemoryStore({
      storage: half,
      observer: fakeModel([]),
    });
    expect(supportsWorkingMemory(wrappedHalf)).toBe(false);
    expect(wrappedHalf.getResource).toBeUndefined();
    expect(wrappedHalf.saveResource).toBeUndefined();
  });

  it('公开重载:WorkingMemoryStore 入参返回 WorkingMemoryStore,MemoryStore 入参返回 MemoryStore', () => {
    const working = createObservationalMemoryStore({
      storage: createInMemoryStore(),
      observer: fakeModel([]),
    });
    const plain = createObservationalMemoryStore({
      storage: createPlainStore(),
      observer: fakeModel([]),
    });

    expectAssignable<WorkingMemoryStore>(working);
    expectAssignable<MemoryStore>(working);
    expectAssignable<MemoryStore>(plain);
  });
});

// ── 构造校验与显式失败 ──────────────────────────────────────────────────────────────────

describe('构造校验与显式失败', () => {
  it('observer 缺失/非模型 → 构造期显式报错(点名角色)', async () => {
    const missing = await captureRejection(async () =>
      createObservationalMemoryStore({
        observer: undefined as unknown as ObservationalMemoryConfig['observer'],
      }),
    );
    expect(missing.message).toMatch(/observer/);
  });

  it('模型 spec 版本不符 → 构造期显式报错(不改造、不降级)', async () => {
    const wrong = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'wrong-generation',
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    } as unknown as Model;
    const error = await captureRejection(async () =>
      createObservationalMemoryStore({ observer: wrong }),
    );
    expect(error.message).toMatch(/specification version/);
  });

  it('阈值非正整数 / countTokens 非函数 / 观察存储缺方法 → 构造期显式报错', async () => {
    const badThreshold = await captureRejection(async () =>
      createObservationalMemoryStore({ observer: fakeModel([]), thresholds: { observation: 0 } }),
    );
    expect(badThreshold.message).toMatch(/thresholds\.observation/);

    const badCounter = await captureRejection(async () =>
      createObservationalMemoryStore({
        observer: fakeModel([]),
        countTokens: 42 as unknown as TokenCounter,
      }),
    );
    expect(badCounter.message).toMatch(/countTokens/);

    const badStore = await captureRejection(async () =>
      createObservationalMemoryStore({
        observer: fakeModel([]),
        observations: { list: async () => [] } as unknown as ObservationStore,
      }),
    );
    expect(badStore.message).toMatch(/list \/ save \/ deleteByThread/);
  });

  it('Observer 返回空文本 → 读显式拒绝(不静默降级)', async () => {
    const observer = fakeModel([{ text: '' }]);
    const memory = new Memory({
      storage: createObservationalMemoryStore({
        observer,
        thresholds: { observation: 20 },
        countTokens: countEach(10),
      }),
      lastMessages: 2,
    });
    await seed(memory, TURNS.slice(0, 6));

    const error = await captureRejection(() => memory.recall({ threadId: 'thread-1' }));

    expect(error.message).toMatch(/observer model returned no text/);
  });

  it('countTokens 计数与输入不符 / 计数非法 → 读显式拒绝', async () => {
    const wrongLength = new Memory({
      storage: createObservationalMemoryStore({
        observer: fakeModel([{ text: 'x' }]),
        thresholds: { observation: 20 },
        countTokens: () => [],
      }),
      lastMessages: 2,
    });
    await seed(wrongLength, TURNS.slice(0, 6));
    const lengthError = await captureRejection(() =>
      wrongLength.recall({ threadId: 'thread-1' }),
    );
    expect(lengthError.message).toMatch(/one per text/);

    const negative = new Memory({
      storage: createObservationalMemoryStore({
        observer: fakeModel([{ text: 'x' }]),
        thresholds: { observation: 20 },
        countTokens: (texts) => texts.map(() => -1),
      }),
      lastMessages: 2,
    });
    await seed(negative, TURNS.slice(0, 6));
    const negativeError = await captureRejection(() => negative.recall({ threadId: 'thread-1' }));
    expect(negativeError.message).toMatch(/non-negative/);
  });
});
