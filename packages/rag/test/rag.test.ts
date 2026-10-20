import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { Memory, createInMemoryStore, supportsWorkingMemory } from '@oribos/core/memory';
import type {
  MemoryStore,
  SaveMessage,
  StoredMessage,
  WorkingMemoryStore,
} from '@oribos/core/memory';
import { z } from 'zod';
import {
  createInMemoryVectorIndex,
  createSemanticMemoryStore,
} from '@oribos/rag';
import type { Embedder, VectorEntry, VectorIndex } from '@oribos/rag';
import { fakeModel } from '@oribos/testing';
import { captureRejection, expectAssignable } from './helpers/assertions.js';

/**
 * `@oribos/rag` — RAG / 语义召回能力包(追赶面中层,CUT-MEM1;#182)。
 *
 * 承载缝 = `Memory.save → MemoryStore.saveMessages`:包装 store 在落库路径上把消息正文交给
 * 用户自带的 embedder 并写入向量索引,在 `listMessages`(recall 的底层缝)上把窗口外语义相关
 * 的旧消息并回结果——消息不可变与 recall 单入口两根钉子不动,核心零改动。断言只走公开面:
 * 包入口、`Memory` 公开方法、注入的 store / embedder / index(调用方自己的对象)与 fake model
 * 录制的 prompt(issue #21 测试决策)。
 */

// ── 测试抓手:确定性 embedder、假索引、消息构造 ────────────────────────────────────────────────

/** 关键词 → 4 维正交基:cat/sofa → e1,dog → e2,report → e3,其余 → 零向量。 */
function keywordEmbedding(text: string): number[] {
  const vector = [0, 0, 0, 0];
  if (/cat|sofa/.test(text)) vector[0] = 1;
  if (/dog/.test(text)) vector[1] = 1;
  if (/report/.test(text)) vector[2] = 1;
  return vector;
}

/** 录制型假 embedder:每次 doEmbed 记录 values,返回确定性 embedding。 */
function fakeEmbedder(
  embed: (text: string) => readonly number[] = keywordEmbedding,
): Embedder & { readonly calls: readonly (readonly string[])[] } {
  const calls: string[][] = [];
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'fake-embedder',
    calls,
    doEmbed: async (options) => {
      calls.push([...options.values]);
      return { embeddings: options.values.map((value) => [...embed(value)]) };
    },
  };
}

/** 录制型假索引:只记录 upsert / 查询 / 级联删除,查询恒返回空(增强路径另有真索引用例)。 */
function fakeIndex(): VectorIndex & {
  readonly upserts: readonly (readonly VectorEntry[])[];
  readonly queriedThreadIds: readonly (string | undefined)[];
  readonly deletedThreads: readonly string[];
} {
  const upserts: VectorEntry[][] = [];
  const queriedThreadIds: (string | undefined)[] = [];
  const deletedThreads: string[] = [];
  return {
    upserts,
    queriedThreadIds,
    deletedThreads,
    upsert: async (entries) => {
      upserts.push([...entries]);
    },
    query: async (_embedding, query) => {
      queriedThreadIds.push(query.threadId);
      return [];
    },
    deleteByThread: async (threadId) => {
      deletedThreads.push(threadId);
    },
  };
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

/** 消息正文(测试断言用):system 直取字符串,其余拼 text 部分。 */
function textOf(message: StoredMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** 无正文的 assistant 消息(纯工具调用):落库可,索引不可。 */
function toolCallOnlyMessage(): SaveMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: {} }],
  };
}

/** 会话底稿:cat / dog 两条事实在前,report 填充在后——窗口默认盖住填充、盖不住事实。 */
async function seedConversation(memory: Memory): Promise<{ catFact: StoredMessage; dogFact: StoredMessage }> {
  const [catFact] = await memory.save({
    thread: 'thread-1',
    resource: 'user-1',
    messages: [userMessage('The cat sleeps on the sofa.')],
  });
  const [dogFact] = await memory.save({
    thread: 'thread-1',
    resource: 'user-1',
    messages: [userMessage('The dog barks at the mail carrier.')],
  });
  for (const filler of ['File the quarterly report.', 'Review the quarterly report.', 'Publish the quarterly report.']) {
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage(filler)] });
  }
  expect(catFact).toBeDefined();
  expect(dogFact).toBeDefined();
  return { catFact: catFact!, dogFact: dogFact! };
}

// ── 落库 hook 索引(save → embedder → 向量索引)─────────────────────────────────────────────

describe('落库 hook 索引:save 的消息正文进向量索引', () => {
  it('每批 save 一次 doEmbed,值 = 可索引消息正文(按序);索引条目带信封与整条消息', async () => {
    const embedder = fakeEmbedder();
    const index = fakeIndex();
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder, index }),
    });

    const saved = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('The cat sleeps on the sofa.'), toolCallOnlyMessage()],
    });

    // 纯工具调用消息无正文,不进 embedder 也不进索引;一批一次调用。
    expect(embedder.calls).toEqual([['The cat sleeps on the sofa.']]);
    expect(index.upserts).toHaveLength(1);
    const [entries] = index.upserts;
    const entry = entries?.[0];
    expect(entry?.id).toBe(saved[0]?.id);
    expect(entry?.threadId).toBe('thread-1');
    expect(entry?.resourceId).toBe('user-1');
    expect(entry?.embedding).toEqual([1, 0, 0, 0]);
    expect(entry?.message).toEqual(saved[0]);
  });

  it('全批无可索引正文 → 零 doEmbed、零 upsert', async () => {
    const embedder = fakeEmbedder();
    const index = fakeIndex();
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder, index }),
    });

    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [toolCallOnlyMessage()] });

    expect(embedder.calls).toHaveLength(0);
    expect(index.upserts).toHaveLength(0);
  });

  it('embedder 返回的 embeddings 数量与输入不符 → save 显式拒绝(先落库后索引,不吞错)', async () => {
    const embedder: Embedder = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'broken-embedder',
      doEmbed: async () => ({ embeddings: [] }),
    };
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder }),
    });

    const error = await captureRejection(() =>
      memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('index me')] }),
    );
    expect(error.message).toMatch(/embedding/i);
  });
});

// ── recall 语义增强(listMessages 缝)──────────────────────────────────────────────────────

describe('recall 语义增强:窗口外的相关旧消息并回 recall 结果', () => {
  it('相关旧消息(cat)回到结果且按时间正序排在窗口前;不相关(dog)不出现', async () => {
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() }),
      lastMessages: 3,
    });
    const { catFact } = await seedConversation(memory);
    // 窗口(3)= 最新三条 report 填充;查询文本 = 窗口内最后一条 user 消息(report 系)→ 无相关命中。
    let window = await memory.recall({ threadId: 'thread-1' });
    expect(window.map((message) => message.id)).not.toContain(catFact.id);

    // 追问 cat:该消息本身进窗口,成为语义查询 → cat 事实被并回。
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('Where does the cat sleep?')] });
    window = await memory.recall({ threadId: 'thread-1' });

    const texts = window.map(textOf);
    expect(texts).toContain('The cat sleeps on the sofa.');
    expect(texts).not.toContain('The dog barks at the mail carrier.');
    // 时间正序:cat 事实(最旧)排第一,追问(最新)排最后。
    expect(texts[0]).toBe('The cat sleeps on the sofa.');
    expect(texts[window.length - 1]).toBe('Where does the cat sleep?');
    // 结果 ≤ 窗口 + topK。
    expect(window.length).toBeLessThanOrEqual(3 + 3);
  });

  it('窗口内已命中的条目不去重重复', async () => {
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() }),
      lastMessages: 3,
    });
    await seedConversation(memory);
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('Where does the cat sleep?')] });

    const window = await memory.recall({ threadId: 'thread-1' });
    const ids = window.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('before 游标分页不触发增强:零 embed 调用,结果与裸 store 完全一致', async () => {
    const embedder = fakeEmbedder();
    const rawStore = createInMemoryStore();
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: rawStore, embedder }),
      lastMessages: 3,
    });
    await seedConversation(memory);
    const [question] = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('Where does the cat sleep?')],
    });
    const callsBeforePaging = embedder.calls.length;

    const paged = await memory.recall({ threadId: 'thread-1', before: question?.id });

    expect(embedder.calls.length).toBe(callsBeforePaging);
    const expected = await rawStore.listMessages({
      threadId: 'thread-1',
      limit: 3,
      order: 'asc',
      ...(question === undefined ? {} : { before: question.id }),
    });
    expect(paged).toEqual(expected);
  });

  it('order: desc 的合并结果按时间倒序呈现', async () => {
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() }),
      lastMessages: 3,
    });
    await seedConversation(memory);
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('Where does the cat sleep?')] });

    const window = await memory.recall({ threadId: 'thread-1', order: 'desc' });
    const texts = window.map(textOf);
    expect(texts[0]).toBe('Where does the cat sleep?');
    expect(texts[texts.length - 1]).toBe('The cat sleeps on the sofa.');
  });

  it('空历史线程 recall → 空数组且零 embed 调用', async () => {
    const embedder = fakeEmbedder();
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder }),
    });

    const window = await memory.recall({ threadId: 'unknown-thread' });

    expect(window).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });

  it('thread 隔离:相似消息只在别的 thread 时,本 thread 的 recall 不并回任何东西', async () => {
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() }),
      lastMessages: 3,
    });
    // cat 消息只落 thread-2;thread-1 的窗口与 cat 式追问同前,但索引圈定 thread-1 → 无命中。
    await memory.save({ thread: 'thread-2', resource: 'user-1', messages: [userMessage('The cat sleeps on the sofa.')] });
    for (const filler of ['File the quarterly report.', 'Review the quarterly report.', 'Publish the quarterly report.']) {
      await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage(filler)] });
    }
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('Where does the cat sleep?')] });

    const window = await memory.recall({ threadId: 'thread-1' });

    expect(new Set(window.map((message) => message.threadId))).toEqual(new Set(['thread-1']));
    expect(window).toHaveLength(3); // 无命中:结果即窗口,thread-2 的相似消息没有跨过来
  });
});

// ── 端口语义与能力透传 ────────────────────────────────────────────────────────────────────

describe('端口语义与能力透传', () => {
  it('deleteThread 级联清掉该 thread 的索引条目', async () => {
    const index = fakeIndex();
    const store = createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder(), index });
    const memory = new Memory({ storage: store });
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('index me first.')] });

    await store.deleteThread('thread-1');

    expect(index.deletedThreads).toEqual(['thread-1']);
    expect(await memory.recall({ threadId: 'thread-1' })).toEqual([]);
  });

  it('工作记忆条件对透传:包装核心内存 store 后 WM 读写回环照常', async () => {
    const schema = z.object({ preference: z.string() });
    const store = createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() });
    expect(supportsWorkingMemory(store)).toBe(true);
    const memory = new Memory({ storage: store, workingMemory: { schema } });

    await memory.updateWorkingMemory({ resource: 'user-1', patch: { preference: 'concise answers' } });
    expect(await memory.getWorkingMemory('user-1')).toEqual({ preference: 'concise answers' });
  });

  it('thread 记录面透传:经包装 saveThread 后 getThreadById 读回', async () => {
    const store: MemoryStore = createSemanticMemoryStore({
      storage: createInMemoryStore(),
      embedder: fakeEmbedder(),
    });
    const now = new Date();
    await store.saveThread({ id: 'thread-1', resourceId: 'user-1', createdAt: now, updatedAt: now });

    const thread = await store.getThreadById('thread-1');

    expect(thread).toMatchObject({ id: 'thread-1', resourceId: 'user-1' });
  });
});

// ── 包装表面:基础窗口契约与能力透传(ADR-0021)──────────────────────────────────────────

describe('包装表面:基础窗口契约与能力透传', () => {
  it('语义召回并回旧消息时,内层基础窗口的每条消息恰好一次且相对顺序不变(asc / desc)', async () => {
    const rawStore = createInMemoryStore();
    const store = createSemanticMemoryStore({ storage: rawStore, embedder: fakeEmbedder() });
    const memory = new Memory({ storage: store, lastMessages: 3 });
    const { catFact } = await seedConversation(memory);
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('Where does the cat sleep?')],
    });

    for (const order of [undefined, 'asc', 'desc'] as const) {
      const query =
        order === undefined
          ? { threadId: 'thread-1', limit: 3 }
          : { threadId: 'thread-1', limit: 3, order };
      const baseWindow = await rawStore.listMessages(query);
      const recalled = await store.listMessages(query);

      const baseIds = baseWindow.map((message) => message.id);
      const recalledIds = recalled.map((message) => message.id);

      // 基础窗口成员逐一保留、相对顺序不变;合并只增不删。
      expect(recalledIds.filter((id) => baseIds.includes(id))).toEqual(baseIds);
      expect(new Set(recalledIds).size).toBe(recalledIds.length);
      expect(recalled.length).toBeGreaterThan(baseWindow.length);
      expect(recalledIds).toContain(catFact.id);
      // order 缺省 = port 默认 desc:最旧的并回项在末尾;asc 才在开头。
      expect(recalledIds[order === 'asc' ? 0 : recalledIds.length - 1]).toBe(catFact.id);
    }
  });

  it('before 精确透传内层结果:零 embedding、零索引查询 / 写入 / 删除', async () => {
    const rawStore = createInMemoryStore();
    const embedder = fakeEmbedder();
    const index = fakeIndex();
    const store = createSemanticMemoryStore({ storage: rawStore, embedder, index });
    const memory = new Memory({ storage: store, lastMessages: 3 });
    await seedConversation(memory);
    const [question] = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('Where does the cat sleep?')],
    });
    const embedCalls = embedder.calls.length;
    const upserts = index.upserts.length;
    const queries = index.queriedThreadIds.length;
    const deletions = index.deletedThreads.length;

    const query = { threadId: 'thread-1', limit: 3, before: question!.id };
    const expected = await rawStore.listMessages(query);
    const paged = await store.listMessages(query);

    expect(paged).toEqual(expected);
    expect(embedder.calls.length).toBe(embedCalls);
    expect(index.upserts.length).toBe(upserts);
    expect(index.queriedThreadIds.length).toBe(queries);
    expect(index.deletedThreads.length).toBe(deletions);
  });

  it('supportsWorkingMemory 条件对:有能力 → true 且两方法都在;无能力 / 半实现 → false 且两方法都缺席', () => {
    const capable = createSemanticMemoryStore({
      storage: createInMemoryStore(),
      embedder: fakeEmbedder(),
    });
    expect(supportsWorkingMemory(capable)).toBe(true);
    expect(typeof capable.getResource).toBe('function');
    expect(typeof capable.saveResource).toBe('function');

    const wrappedPlain = createSemanticMemoryStore({
      storage: createPlainStore(),
      embedder: fakeEmbedder(),
    });
    expect(supportsWorkingMemory(wrappedPlain)).toBe(false);
    expect(wrappedPlain.getResource).toBeUndefined();
    expect(wrappedPlain.saveResource).toBeUndefined();

    // 半实现按缺席处理:包装后条件对成对不暴露。
    const half: MemoryStore = { ...createPlainStore(), getResource: async () => null };
    const wrappedHalf = createSemanticMemoryStore({ storage: half, embedder: fakeEmbedder() });
    expect(supportsWorkingMemory(wrappedHalf)).toBe(false);
    expect(wrappedHalf.getResource).toBeUndefined();
    expect(wrappedHalf.saveResource).toBeUndefined();
  });

  it('公开重载:WorkingMemoryStore 入参返回 WorkingMemoryStore,MemoryStore 入参返回 MemoryStore', () => {
    const working = createSemanticMemoryStore({
      storage: createInMemoryStore(),
      embedder: fakeEmbedder(),
    });
    const plain = createSemanticMemoryStore({
      storage: createPlainStore(),
      embedder: fakeEmbedder(),
    });

    expectAssignable<WorkingMemoryStore>(working);
    expectAssignable<MemoryStore>(working);
    expectAssignable<MemoryStore>(plain);
  });
});

// ── 内存向量索引(包自带的零依赖默认)─────────────────────────────────────────────────────

describe('createInMemoryVectorIndex:cosine 排序与过滤', () => {
  it('按 cosine 相似度降序返回 topK;threadId 过滤;同 id upsert 替换', async () => {
    const index = createInMemoryVectorIndex();
    const message = (id: string): StoredMessage => ({
      role: 'user',
      content: [{ type: 'text', text: id }],
      id,
      threadId: 'thread-1',
      resourceId: 'user-1',
      createdAt: new Date(0),
    });
    await index.upsert([
      { id: 'e1', threadId: 'thread-1', resourceId: 'user-1', embedding: [1, 0, 0, 0], message: message('e1') },
      { id: 'e2', threadId: 'thread-1', resourceId: 'user-1', embedding: [0.6, 0.8, 0, 0], message: message('e2') },
      { id: 'e3', threadId: 'thread-1', resourceId: 'user-1', embedding: [0, 0, 1, 0], message: message('e3') },
      { id: 'e4', threadId: 'thread-2', resourceId: 'user-1', embedding: [1, 0, 0, 0], message: message('e4') },
    ]);

    const ranked = await index.query([1, 0, 0, 0], { topK: 3, threadId: 'thread-1' });

    expect(ranked.map((hit) => hit.entry.id)).toEqual(['e1', 'e2', 'e3']);
    expect(ranked[0]?.score).toBeCloseTo(1);
    expect(ranked[1]?.score).toBeCloseTo(0.6);

    // 同 id 替换:方向反转后 e1 掉到无关位;同分平手按 upsert 顺序(e1 仍先于 e3 插入)。
    await index.upsert([
      { id: 'e1', threadId: 'thread-1', resourceId: 'user-1', embedding: [0, 0, 0, 1], message: message('e1') },
    ]);
    const reranked = await index.query([1, 0, 0, 0], { topK: 3, threadId: 'thread-1' });
    expect(reranked.map((hit) => hit.entry.id)).toEqual(['e2', 'e1', 'e3']);
  });
});

// ── agent 集成:增强历史进模型 prompt ─────────────────────────────────────────────────────

describe('agent 集成:窗口外的相关旧消息进模型 prompt', () => {
  it('第二次 run 的 prompt 含第一次 run 之前落库的 cat 事实(recall 缝的端到端证据)', async () => {
    const memory = new Memory({
      storage: createSemanticMemoryStore({ storage: createInMemoryStore(), embedder: fakeEmbedder() }),
      lastMessages: 3,
    });
    await seedConversation(memory);
    const model = fakeModel([{ text: 'on the sofa' }, { text: 'still on the sofa' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model, memory });

    // run 1:问题落库(此刻窗口全是 report,无相关命中,照常回答)。
    await agent.generate('Where does the cat sleep?', { memory: { thread: 'thread-1', resource: 'user-1' } });
    // run 2:窗口 = report 填充 + 问答对;查询文本 = 窗口内最后一条 user 消息(cat 追问)。
    await agent.generate('Anything else about naps?', { memory: { thread: 'thread-1', resource: 'user-1' } });

    const prompt = model.streamCalls[1]?.prompt ?? [];
    const texts = prompt.map((message) => textOf(message as StoredMessage));
    expect(texts).toContain('The cat sleeps on the sofa.');
    // 时间正序:cat 事实在 instructions 之后、本次输入之前。
    expect(texts.indexOf('The cat sleeps on the sofa.')).toBeGreaterThan(0);
    expect(texts.indexOf('The cat sleeps on the sofa.')).toBeLessThan(texts.length - 1);
  });
});
