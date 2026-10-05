import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { createTool } from '@oribos/core/tools';
import { createDurableAgent } from '@oribos/core/durable-agent';
import type { ModelPrompt } from '@oribos/core/model';
import { createChatRoute } from '@oribos/ai-sdk';
import { fakeModel } from '@oribos/testing';
import type { FakeResponse } from '@oribos/testing';

/** A POST the way `useChat`'s DefaultChatTransport sends it. */
function chatRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function userMessage(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** Decodes an SSE body into its data payloads; `[DONE]` stays verbatim, comments included raw. */
function sseData(body: string): string[] {
  return body
    .split('\n\n')
    .filter((event) => event !== '')
    .map((event) => {
      const data = event.startsWith('data: ') ? event.slice('data: '.length) : event;
      return data;
    });
}

function sseFrames(body: string): unknown[] {
  return sseData(body)
    .filter((data) => data !== '[DONE]' && !data.startsWith(':'))
    .map((data) => JSON.parse(data));
}

function agent(script: readonly FakeResponse[], tools?: Record<string, ReturnType<typeof createTool>>) {
  return new Agent({
    name: 'desk',
    instructions: 'You are concise.',
    model: fakeModel(script),
    memory: new Memory(),
    ...(tools === undefined ? {} : { tools }),
  });
}

const IDENTITY = () => ({ resource: 'customer-1' });

describe('createChatRoute', () => {
  it('rejects non-POST methods with 405 and an Allow header', async () => {
    const route = createChatRoute({ agent: agent([]), identity: IDENTITY });
    const response = await route(new Request('http://localhost/api/chat', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({ error: expect.stringContaining('POST') });
  });

  it('rejects invalid JSON with a 400 naming the reason', async () => {
    const route = createChatRoute({ agent: agent([]), identity: IDENTITY });
    const response = await route(chatRequest('{not json'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('JSON') });
  });

  it('rejects a body whose messages do not end in a user message', async () => {
    const route = createChatRoute({ agent: agent([]), identity: IDENTITY });
    const response = await route(
      chatRequest({ id: 't1', messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('user') });
  });

  it('rejects unsupported part types in the tail user message', async () => {
    const route = createChatRoute({ agent: agent([]), identity: IDENTITY });
    const response = await route(
      chatRequest({
        id: 't1',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'reasoning', text: 'hm' } as never] }],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('part') });
  });

  it('rejects a request with neither a thread from identity nor a body id', async () => {
    const route = createChatRoute({ agent: agent([]), identity: () => ({ resource: 'customer-1' }) });
    const response = await route(chatRequest({ messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('id') });
  });

  it('streams a run: official headers, start without messageId, body frames, finish with usage, [DONE]', async () => {
    const model = fakeModel([
      { text: ['Hel', 'lo!'], usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
    });
    const response = await route(
      chatRequest({
        id: 't1',
        messages: [userMessage('u1', 'hi')],
        trigger: 'submit-message',
        messageId: 'u1',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const body = await response.text();
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(sseFrames(body)).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hel' },
      { type: 'text-delta', id: 'text-0', delta: 'lo!' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
      {
        type: 'finish',
        finishReason: 'stop',
        messageMetadata: { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
      },
    ]);
    // The run ran memory-authoritatively against the thread named by the body id.
    expect(model.streamCalls.length).toBe(1);
  });

  it('feeds the model the tail user message only — client-sent history is never replayed', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
    });
    const response = await route(
      chatRequest({
        id: 't1',
        messages: [
          userMessage('u0', 'older client-side message'),
          { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'older answer' }] },
          userMessage('u1', 'the live question'),
        ],
      }),
    );
    expect(response.status).toBe(200);
    const prompt = model.streamCalls[0]!.prompt as ModelPrompt;
    const userTurns = prompt.filter((message) => message.role === 'user');
    expect(userTurns.length).toBe(1);
    expect(JSON.stringify(userTurns)).not.toContain('older client-side message');
    expect(JSON.stringify(userTurns)).toContain('the live question');
  });

  it('decodes data-URL file parts of the tail user message into model file parts', async () => {
    const model = fakeModel([{ text: 'seen' }]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
    });
    const response = await route(
      chatRequest({
        id: 't1',
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [
              { type: 'file', url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'note.txt' },
              { type: 'text', text: 'what does it say?' },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const prompt = model.streamCalls[0]!.prompt as ModelPrompt;
    const content = prompt.find((message) => message.role === 'user')!.content as unknown as Array<{
      type: string;
      data?: { type: string; data?: Uint8Array };
      filename?: string;
      mediaType?: string;
    }>;
    const file = content.find((part) => part.type === 'file')!;
    expect(file.data?.type).toBe('data');
    expect(Buffer.from(file.data!.data as Uint8Array).toString()).toBe('hi');
    expect(file.filename).toBe('note.txt');
    expect(file.mediaType).toBe('text/plain');
  });

  it('expresses a durable suspension as finishReason "other" with suspended metadata', async () => {
    const gated = createTool({
      description: 'Moves money; needs approval.',
      execute: () => ({ moved: true }),
    });
    const durable = createDurableAgent({
      agent: agent([{ toolCalls: [{ toolName: 'moveMoney', input: { amount: 129 } }] }], { moveMoney: gated }),
      approval: { tools: ['moveMoney'] },
    });
    const route = createChatRoute({ agent: durable, identity: IDENTITY });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'move it')] }));
    expect(response.status).toBe(200);
    const body = await response.text();
    const frames = sseFrames(body) as Array<{ type: string; [key: string]: unknown }>;
    const finish = frames.at(-1)!;
    expect(finish.type).toBe('finish');
    expect(finish.finishReason).toBe('other');
    const suspended = (finish.messageMetadata as { suspended?: { runId?: string; awaitingApproval?: string[] } }).suspended;
    expect(typeof suspended?.runId).toBe('string');
    expect(suspended?.awaitingApproval).toEqual([expect.any(String)]);
    expect(frames.some((frame) => frame.type === 'tool-input-available')).toBe(true);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('finishes with "error" and an error frame when the run fails mid-stream (HTTP 200)', async () => {
    const route = createChatRoute({
      agent: agent([{ text: 'partial', errorAfter: new Error('model exploded') }]),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = await response.text();
    expect(sseFrames(body)).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'partial' },
      { type: 'text-end', id: 'text-0' },
      { type: 'error', errorText: 'An error occurred.' },
      { type: 'finish', finishReason: 'error' },
    ]);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('returns a sanitized JSON 500 when the run fails before the first frame', async () => {
    const route = createChatRoute({
      agent: agent([{ fail: new Error('secret failure detail') }]),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'An error occurred.' });
  });

  it('lets onError replace the sanitized text on the 500 path', async () => {
    const route = createChatRoute({
      agent: agent([{ fail: new Error('x') }]),
      identity: IDENTITY,
      onError: () => 'custom failure text',
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(await response.json()).toEqual({ error: 'custom failure text' });
  });

  it('resolves the thread from identity when provided, ignoring the body id', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const memory = new Memory();
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory }),
      identity: () => ({ thread: 'thread-from-identity', resource: 'customer-1' }),
    });
    const response = await route(chatRequest({ id: 'body-id', messages: [userMessage('u1', 'first')] }));
    expect(response.status).toBe(200);
    await response.text(); // drain the stream: the run (and its memory save) completes with it
    const history = await memory.recall({ threadId: 'thread-from-identity' });
    expect(history.length).toBeGreaterThan(0);
    const other = await memory.recall({ threadId: 'body-id' });
    expect(other.length).toBe(0);
  });

  it('prefixes the stream with stream-open and emits keep-alive comments when keepAliveMs is on', async () => {
    const route = createChatRoute({
      agent: agent([{ text: 'slow', delayMs: 40 }]),
      identity: IDENTITY,
      keepAliveMs: 5,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.startsWith(': stream-open\n\n')).toBe(true);
    expect(body.includes(': keep-alive\n\n')).toBe(true);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('keeps keep-alive off by default', async () => {
    const route = createChatRoute({
      agent: agent([{ text: 'plain', delayMs: 40 }]),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    const body = await response.text();
    expect(body.startsWith('data: ')).toBe(true);
    expect(body.includes(': keep-alive')).toBe(false);
  });

  it('propagates the request signal to the run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    const model = fakeModel([{ text: 'never' }]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
    });
    const response = await route(
      chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }, { signal: controller.signal }),
    );
    // Aborted before the first frame: the pull fails, the route answers 500 (nobody is reading).
    expect(response.status).toBe(500);
  });

  // M-2(批 2)补钉:M-52 终帧 `finishReason` 逐值映射(model.md「路由:createChatRoute」终帧表)。
  // `stop` / `error` / `suspended → other` 三值已由上文「streams a run」「finishes with "error"…」
  // 「expresses a durable suspension…」三例钉死;此处补齐两个透传值,并随钉 `messageMetadata.usage`
  // 恒写(M-9 改实:usage = run 累计,恒在)。

  it('maps a "length" terminal finishReason straight through to the finish frame', async () => {
    const route = createChatRoute({
      agent: agent([
        { text: 'cut off', finishReason: 'length', usage: { inputTokens: 3, outputTokens: 2 } },
      ]),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(200);
    const frames = sseFrames(await response.text()) as Array<{ type: string }>;
    expect(frames.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'length',
      messageMetadata: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    });
  });

  it('maps a "tool-calls" terminal finishReason (maxSteps exhausted) straight through', async () => {
    // 路由永不从 body 读 maxSteps:耗尽默认上限 5,末步工具照常执行,截断信号归框架。
    const step: FakeResponse = {
      toolCalls: [{ toolName: 'ping', input: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const route = createChatRoute({
      agent: agent([step, step, step, step, step], {
        ping: createTool({ description: 'Pings.', execute: () => 'pong' }),
      }),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'go')] }));
    expect(response.status).toBe(200);
    const frames = sseFrames(await response.text()) as Array<{ type: string }>;
    expect(frames.some((frame) => frame.type === 'tool-output-available')).toBe(true);
    expect(frames.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'tool-calls',
      messageMetadata: { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
    });
  });

  // M-2(批 2)补钉:M-51 取消直通——`request.signal` 中止即 run 中止(原因同一对象随 abort 接力
  // 到 run 的 signal),响应流 `cancel()` 同接 abort。上方「propagates the request signal to
  // the run」只覆盖请求前已中止的 500 路径;此处钉在途取消与客户端断连两条。

  it('aborting request.signal mid-stream aborts the run with the same reason, then finalizes error + [DONE]', async () => {
    const controller = new AbortController();
    const reason = new Error('client went away');
    const seen: unknown[] = [];
    const model = fakeModel([{ text: ['Hel', 'lo'], abortAfter: 3 }]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
      onError: (error) => {
        seen.push(error);
        return 'sanitized';
      },
    });
    const response = await route(
      chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }, { signal: controller.signal }),
    );
    expect(response.status).toBe(200);

    controller.abort(reason);
    const body = await response.text();

    // 中断点前已吐的增量照常交付,其后的脚本部分永不发出(桩的 abortAfter 语义)
    const frames = sseFrames(body) as Array<{ type: string; delta?: string }>;
    expect(frames.filter((frame) => frame.type === 'text-delta').map((frame) => frame.delta)).toEqual(['Hel']);
    // 直通证据:run 的 signal 已中止,onError 收到的错误与 request.signal.reason 是同一对象
    expect(model.streamCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(seen).toEqual([reason]);
    // 首帧后失败的收尾:脱敏 error 帧 + finish error + [DONE],HTTP 200 不变
    expect(frames.at(-2)).toEqual({ type: 'error', errorText: 'sanitized' });
    expect(frames.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('cancelling the response stream aborts the run (client disconnect)', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], abortAfter: 3 }]);
    const route = createChatRoute({
      agent: new Agent({ name: 'desk', instructions: 'You are concise.', model, memory: new Memory() }),
      identity: IDENTITY,
    });
    const response = await route(chatRequest({ id: 't1', messages: [userMessage('u1', 'hi')] }));
    expect(response.status).toBe(200);

    await response.body!.cancel();

    // 响应流 cancel() 同接 abort:run 的 signal(即模型调用收到的 signal)随之中止
    expect(model.streamCalls[0]?.abortSignal?.aborted).toBe(true);
  });
});
