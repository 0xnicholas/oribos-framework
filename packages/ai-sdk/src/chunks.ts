/**
 * The closed frame vocabulary of the AI SDK interop package.
 *
 * The target protocol is the `ai@7` generation of the UI message stream — its vocabulary plus the
 * wire-level `x-vercel-ai-ui-message-stream: v1` header — and nothing else: one generation, no
 * `version` option, no multi-generation adapter. The union below is a **closed subset** of AI SDK's
 * `UIMessageChunk`: the emitted-frames surface is a protocol promise, it may stay narrower than the
 * target vocabulary, and it must never exceed it. The opt-in delta families map through
 * (`reasoning-start` / `reasoning-delta` / `reasoning-end` and `tool-input-start` /
 * `tool-input-delta`) whenever the core streams them — the UI vocabulary has no `tool-input-end`
 * frame, so that chunk only closes the converter's block state. Everything else that
 * cannot be reconstructed from the core's chunk protocol (approvals, sources, files, custom and
 * data frames, `reset-step`, standalone `message-metadata`, `abort`) is deliberately absent.
 *
 * Structural compatibility with `UIMessageChunk` is enforced in CI by type tests against the real
 * `ai` package (`test/cross-check.test.ts`); the published artifact never imports `ai` types.
 */

import type { Usage } from '@oribos/core/model';

/**
 * The finish reason of a UI message stream, as this package emits it on the message-level `finish`
 * frame. The core's `'suspended'` has no wire counterpart and maps to `'other'`
 * (`stop → stop` / `length → length` / `tool-calls → tool-calls` / `error → error` /
 * `suspended → other`).
 */
export type AISdkFinishReason = 'stop' | 'length' | 'tool-calls' | 'error' | 'other';

/** How a durable run's suspension is expressed on the message-level `finish` frame. */
export interface AISdkSuspendedMetadata {
  /** The suspended run's identity — what `durable.resume(runId, …)` continues. */
  readonly runId: string;
  /** The tool-call ids the approval decision governs (the gate's held-back hits). */
  readonly awaitingApproval: readonly string[];
}

/**
 * The message metadata this package carries on the `finish` frame: the run's accumulated usage
 * (the UI protocol has no usage frame), and the suspension marker when a durable run held back.
 */
export interface AISdkMessageMetadata {
  readonly usage?: Usage;
  readonly suspended?: AISdkSuspendedMetadata;
}

/**
 * This package's closed frame union — structurally assignable to AI SDK's `UIMessageChunk`.
 *
 * Message-level `start` / `finish` frames are written by the caller (`createChatRoute`, or a host
 * composing its own response): the converter produces body frames only, because `finish` needs
 * terminal values the chunk stream cannot see. Tool calls arrive as `tool-input-available` —
 * flagged `providerExecuted` (the framework executes, which keeps `useChat` from offering the call
 * to `onToolCall`) and `dynamic` (tool schemas live on the server; the client has none) — and when
 * the run opted into tool-input deltas, as the streaming `tool-input-start` / `tool-input-delta` /
 * `tool-input-end` preview ahead of it. Reasoning deltas likewise map to `reasoning-start` /
 * `reasoning-delta` / `reasoning-end` blocks.
 */
export type AISdkStreamChunk =
  | { readonly type: 'start' }
  | { readonly type: 'start-step' }
  | { readonly type: 'text-start'; readonly id: string }
  | { readonly type: 'text-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'text-end'; readonly id: string }
  | { readonly type: 'reasoning-start'; readonly id: string }
  | { readonly type: 'reasoning-delta'; readonly id: string; readonly delta: string }
  | { readonly type: 'reasoning-end'; readonly id: string }
  | {
      readonly type: 'tool-input-start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly providerExecuted: true;
      readonly dynamic: true;
    }
  | { readonly type: 'tool-input-delta'; readonly toolCallId: string; readonly inputTextDelta: string }
  | {
      readonly type: 'tool-input-available';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly providerExecuted: true;
      readonly dynamic: true;
    }
  | {
      readonly type: 'tool-output-available';
      readonly toolCallId: string;
      readonly output: unknown;
      readonly providerExecuted: true;
    }
  | {
      readonly type: 'tool-output-error';
      readonly toolCallId: string;
      readonly errorText: string;
      readonly providerExecuted: true;
    }
  | { readonly type: 'finish-step' }
  | { readonly type: 'error'; readonly errorText: string }
  | {
      readonly type: 'finish';
      readonly finishReason?: AISdkFinishReason;
      readonly messageMetadata?: AISdkMessageMetadata;
    };

// ── History read-back (`toAISdkMessages`) ────────────────────────────────────────────────────────

/** A text part of a UI message. */
export interface AISdkTextUIPart {
  readonly type: 'text';
  readonly text: string;
}

/** A file part of a UI message, carried as a Data URL. */
export interface AISdkFileUIPart {
  readonly type: 'file';
  readonly url: string;
  readonly mediaType: string;
  readonly filename?: string;
}

/** A step boundary inside a folded assistant message. */
export interface AISdkStepStartUIPart {
  readonly type: 'step-start';
}

/**
 * A tool invocation part of a UI message, in the dynamic-tool shape: the client has no tool
 * schemas (they live on the server), matching the `dynamic: true` posture of the stream frames.
 */
export type AISdkToolUIPart = {
  readonly type: 'dynamic-tool';
  readonly toolName: string;
  readonly toolCallId: string;
} & (
  | { readonly state: 'input-available'; readonly input: unknown }
  | { readonly state: 'output-available'; readonly input: unknown; readonly output: unknown }
  | { readonly state: 'output-error'; readonly input: unknown; readonly errorText: string }
  | {
      readonly state: 'output-denied';
      readonly input: unknown;
      readonly approval: { readonly id: string; readonly approved: false; readonly reason?: string };
    }
);

/** A user message as `useChat` renders it. */
export interface AISdkUserUIMessage {
  readonly id: string;
  readonly role: 'user';
  // Mutable on purpose: AI SDK's `UIMessage.parts` is a mutable array, and read-back messages
  // must remain assignable to it (the drift guard asserts exactly that).
  readonly parts: (AISdkTextUIPart | AISdkFileUIPart)[];
}

/** An assistant message as `useChat` renders it — one folded step sequence. */
export interface AISdkAssistantUIMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly parts: (AISdkTextUIPart | AISdkFileUIPart | AISdkStepStartUIPart | AISdkToolUIPart)[];
}

/**
 * A UI message — structurally assignable to AI SDK's `UIMessage`. Note the id discipline: ids are
 * the stored messages' own ids, so a refreshed client re-renders history under fresh ids while a
 * live stream's message carries the client's self-generated one (documented divergence).
 */
export type AISdkUIMessage = AISdkUserUIMessage | AISdkAssistantUIMessage;
