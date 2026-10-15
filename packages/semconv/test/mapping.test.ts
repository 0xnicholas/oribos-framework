/**
 * The seven-type mapping contract (`docs/architecture/observability.md`「映射契约(七类 + 兜底)」):
 * name templates, `gen_ai.operation.name` / kind per type, the agent-step attribute table, the
 * `oribos.*` vocabulary, error mapping, metadata, and the value-domain rules — asserted straight
 * against `mapSpan`, the leaf's public face.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveOtelEnv } from './helpers.js';
import type { ExportedSpan } from '@oribos/core/observability';
import { mapSpan } from '@oribos/semconv';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = saveOtelEnv();
});
afterEach(() => {
  restoreEnv();
});

/** A hand-built span fixture with valid OTel-compatible hex ids and known timestamps. */
function testSpan(
  overrides: { [K in keyof ExportedSpan]?: ExportedSpan[K] | undefined } = {},
): ExportedSpan {
  // The cast admits an explicit `undefined` override (removing `endTime` for an isEvent fixture)
  // that the mapped type allows but the spread's inference reads as a missing required field.
  return {
    id: 'aaaa00000000bbbb',
    traceId: 'cccc000000000000000000000000dddd',
    name: 'test-span',
    type: 'signal',
    startTime: new Date('2026-10-01T00:00:00.250Z'),
    endTime: new Date('2026-10-01T00:00:01.750Z'),
    ...overrides,
  } as ExportedSpan;
}

describe('seven-type mapping: names, operations, kinds', () => {
  it('maps agent-run to invoke_agent with the agent semconv attributes', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk', runId: 'run-1' },
      }),
    );

    expect(mapped.name).toBe('invoke_agent desk');
    expect(mapped.kind).toBe(0); // OTel API SpanKind.INTERNAL
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'desk',
      'oribos.run_id': 'run-1',
      'oribos.span.type': 'agent-run',
    });
  });

  it('maps agent-step to chat with CLIENT kind and the request attributes', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-step',
        name: 'gpt-5',
        attributes: {
          model: 'gpt-5',
          provider: 'openai',
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
          finishReason: 'stop',
          timeToFirstChunk: 250,
        },
        output: 'hello',
      }),
    );

    expect(mapped.name).toBe('chat gpt-5');
    expect(mapped.kind).toBe(2); // OTel API SpanKind.CLIENT
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5',
      'gen_ai.request.stream': true,
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.time_to_first_chunk': 0.25,
      'oribos.span.type': 'agent-step',
    });
    // `total` has no semconv key — no repeated counting across backends.
    expect(Object.keys(mapped.attributes)).not.toContain('gen_ai.usage.total_tokens');
  });

  it('passes agent-step parameters through the whitelist and the rest under oribos.request.*', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-step',
        name: 'gpt-5',
        attributes: {
          model: 'gpt-5',
          provider: 'openai',
          parameters: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 1024,
            stopSequences: ['END'],
            customKnob: 'x',
          },
        },
      }),
    );

    expect(mapped.attributes).toMatchObject({
      'gen_ai.request.temperature': 0.7,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.max_tokens': 1024,
      'gen_ai.request.stop_sequences': ['END'],
      'oribos.request.customKnob': 'x',
    });
  });

  it('maps tool-call to execute_tool, result only on success', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'tool-call',
        name: 'refund',
        attributes: { toolCallId: 'call-1' },
        input: { orderId: 'o-1' },
        output: { refunded: true },
      }),
    );
    expect(mapped.name).toBe('execute_tool refund');
    expect(mapped.kind).toBe(0);
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'refund',
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.call.arguments': '{"orderId":"o-1"}',
      'gen_ai.tool.call.result': '{"refunded":true}',
      'oribos.span.type': 'tool-call',
    });

    const failedMapped = mapSpan(
      testSpan({
        type: 'tool-call',
        name: 'refund',
        attributes: { toolCallId: 'call-2' },
        input: { orderId: 'o-2' },
        output: { refunded: true },
        error: {
          message: 'gateway down',
          details: Object.assign(new Error('gateway down'), { name: 'TimeoutError' }),
        },
      }),
    );
    expect(failedMapped.attributes).toMatchObject({
      'gen_ai.tool.call.arguments': '{"orderId":"o-2"}',
      'error.type': 'TimeoutError',
    });
    expect(failedMapped.attributes).not.toHaveProperty('gen_ai.tool.call.result');
  });

  it('maps workflow-run and workflow-step', () => {
    const mappedRun = mapSpan(
      testSpan({
        type: 'workflow-run',
        name: 'refund-flow',
        attributes: { workflowId: 'refund-flow', runId: 'run-9' },
        input: { orderId: 'o-1' },
        output: 'refunded',
      }),
    );
    const mappedStep = mapSpan(
      testSpan({
        type: 'workflow-step',
        name: 'validate',
        attributes: {},
        input: { orderId: 'o-1' },
        output: true,
      }),
    );

    expect(mappedRun.name).toBe('invoke_workflow refund-flow');
    expect(mappedRun.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': 'refund-flow',
      'oribos.run_id': 'run-9',
      'oribos.input': '{"orderId":"o-1"}',
      'oribos.output': '"refunded"',
      'oribos.span.type': 'workflow-run',
    });

    expect(mappedStep.name).toBe('workflow-step validate');
    expect(mappedStep.attributes).toMatchObject({
      'oribos.input': '{"orderId":"o-1"}',
      'oribos.output': 'true',
      'oribos.span.type': 'workflow-step',
    });
    expect(mappedStep.attributes).not.toHaveProperty('gen_ai.operation.name');
  });

  it('maps memory-recall and memory-save without inventing operations', () => {
    const mappedRecall = mapSpan(
      testSpan({
        type: 'memory-recall',
        name: 'thread-1',
        attributes: { threadId: 'thread-1' },
        input: { query: 'last messages' },
        output: [],
      }),
    );
    const mappedSave = mapSpan(
      testSpan({
        type: 'memory-save',
        name: 'thread-1',
        attributes: { threadId: 'thread-1', resourceId: 'user-7' },
        input: [{ role: 'user', content: 'hi' }],
        output: [{ id: 'm-1' }],
      }),
    );

    expect(mappedRecall.name).toBe('memory-recall thread-1');
    expect(mappedRecall.attributes).toMatchObject({
      'oribos.thread_id': 'thread-1',
      'oribos.input': '{"query":"last messages"}',
      'oribos.output': '[]',
    });
    expect(mappedRecall.attributes).not.toHaveProperty('gen_ai.operation.name');

    expect(mappedSave.name).toBe('memory-save thread-1');
    expect(mappedSave.attributes).toMatchObject({
      'oribos.thread_id': 'thread-1',
      'oribos.resource_id': 'user-7',
    });
  });

  it('passes open types through untouched, marked only by oribos.span.type', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'signal',
        name: 'approval-signal',
        attributes: { kind: 'approval' },
        input: { verdict: 'approved' },
      }),
    );

    expect(mapped.name).toBe('approval-signal');
    expect(mapped.kind).toBe(0);
    expect(mapped.attributes).toMatchObject({
      kind: 'approval',
      'oribos.input': '{"verdict":"approved"}',
      'oribos.span.type': 'signal',
    });
    expect(mapped.attributes).not.toHaveProperty('gen_ai.operation.name');
  });
});

describe('error, metadata, and the value domain', () => {
  it('maps details.name to error.type, falls back to _OTHER, and omits an empty details JSON', () => {
    const mappedNamed = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        error: { message: 'boom', details: { name: 'RateLimitError', retryAfter: 3 } },
      }),
    );
    const mappedPlain = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        error: { message: 'boom', details: new Error('boom') },
      }),
    );
    const mappedNameless = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        error: { message: 'boom', details: { code: 500 } },
      }),
    );
    const mappedBare = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        error: { message: 'boom' },
      }),
    );

    expect(mappedNamed.attributes['error.type']).toBe('RateLimitError');
    expect(mappedNamed.attributes['oribos.error.details']).toBe(
      '{"name":"RateLimitError","retryAfter":3}',
    );

    // A plain Error's name is the string 'Error' — taken as-is; only a missing name falls back.
    expect(mappedPlain.attributes['error.type']).toBe('Error');
    // An Error's own properties do not enumerate — `{}` would be worse than nothing.
    expect(mappedPlain.attributes).not.toHaveProperty('oribos.error.details');

    expect(mappedNameless.attributes['error.type']).toBe('_OTHER');
    expect(mappedBare.attributes['error.type']).toBe('_OTHER');
  });

  it('ships the metadata bag as one oribos.metadata JSON attribute (empty omitted)', () => {
    const mapped = mapSpan(testSpan({ metadata: { tenant: 'acme', attempt: 2 } }));
    const mappedEmpty = mapSpan(testSpan({ metadata: {} }));

    expect(mapped.attributes['oribos.metadata']).toBe('{"tenant":"acme","attempt":2}');
    expect(mappedEmpty.attributes).not.toHaveProperty('oribos.metadata');
  });

  it('applies the value-domain rules to unmapped attribute keys', () => {
    const mapped = mapSpan(
      testSpan({
        attributes: {
          plain: 'text',
          count: 3,
          flag: true,
          object: { nested: [1, 2] },
          holes: [1, null, undefined, 2],
          mixed: [1, { a: 2 }],
          dropped: undefined,
        },
      }),
    );

    expect(mapped.attributes).toMatchObject({
      plain: 'text',
      count: 3,
      flag: true,
      object: '{"nested":[1,2]}',
      holes: [1, 2],
      // A non-primitive member makes the whole array "any other value" → JSON text.
      mixed: '[1,{"a":2}]',
    });
    expect(mapped.attributes).not.toHaveProperty('dropped');
    expect(mapped.droppedAttributesCount).toBe(0);
  });

  it('drops unserializable values and counts them in droppedAttributesCount', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const mapped = mapSpan(testSpan({ attributes: { circular } }));

    expect(mapped.attributes).not.toHaveProperty('circular');
    expect(mapped.droppedAttributesCount).toBe(1);
  });

  it('drops a primitive array that strips down to nothing', () => {
    const mapped = mapSpan(testSpan({ attributes: { empty: [null, undefined] } }));
    expect(mapped.attributes).not.toHaveProperty('empty');
  });
});

/** The prompt fixture shared by the payload assertions. */
const prompt: ExportedSpan['input'] = [
  { role: 'system', content: 'You are a refund desk.' },
  { role: 'user', content: [{ type: 'text', text: 'refund o-1' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'checking the order' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'refund', input: { orderId: 'o-1' } },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'refund',
        output: { type: 'json', value: { refunded: true } },
      },
    ],
  },
];

describe('message semantics (agent-run / agent-step payloads)', () => {
  it('splits system instructions from input messages and converts every part', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-step',
        name: 'gpt-5',
        attributes: { model: 'gpt-5', provider: 'openai' },
        input: prompt,
        output: 'all set',
      }),
    );

    expect(JSON.parse(mapped.attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'You are a refund desk.' },
    ]);
    expect(JSON.parse(mapped.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'refund o-1' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'checking the order' },
          { type: 'tool_call', id: 'call-1', name: 'refund', arguments: '{"orderId":"o-1"}' },
        ],
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_call_response', id: 'call-1', name: 'refund', output: '{"refunded":true}' },
        ],
      },
    ]);
    expect(JSON.parse(mapped.attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'all set' }] },
    ]);
  });

  it('degrades unrecognized parts to a single JSON text part', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        input: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://x/y.png' } }],
          },
        ],
      }),
    );

    const messages = JSON.parse(mapped.attributes['gen_ai.input.messages'] as string) as {
      parts: { type: string; content: string }[];
    }[];
    const [message] = messages;
    expect(message!.parts).toHaveLength(1);
    const [part] = message!.parts;
    expect(part!.type).toBe('text');
    expect(JSON.parse(part!.content)).toMatchObject({ type: 'file', mediaType: 'image/png' });
  });

  it('omits empty model text and JSON-texts a structured result', () => {
    const mappedEmpty = mapSpan(
      testSpan({
        type: 'agent-step',
        name: 'gpt-5',
        attributes: { model: 'gpt-5', provider: 'openai' },
        output: '',
      }),
    );
    const mappedStructured = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        output: { verdict: 'approved' },
      }),
    );

    expect(mappedEmpty.attributes).not.toHaveProperty('gen_ai.output.messages');
    expect(JSON.parse(mappedStructured.attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '{"verdict":"approved"}' }] },
    ]);
  });

  it('falls back to oribos.input when the recorded input is not a message array', () => {
    const mapped = mapSpan(
      testSpan({
        type: 'agent-run',
        name: 'desk',
        attributes: { agentName: 'desk' },
        input: { note: 'not a ModelMessage[]' },
      }),
    );

    expect(mapped.attributes['oribos.input']).toBe('{"note":"not a ModelMessage[]"}');
    expect(mapped.attributes).not.toHaveProperty('gen_ai.input.messages');
  });
});
