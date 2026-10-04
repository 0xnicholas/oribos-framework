import type { ModelMessage } from '../model/contract.js';

/**
 * Normalizes message input: a string becomes one user text message (the exact shape the prompt
 * carries), an array is copied as given. The agent's run input and the signals message forms
 * share this one normalization — for the run these are also the messages the first memory save
 * persists alongside the first step's record; for signals they are what injects into a live run
 * and what a woken run starts from.
 *
 * Internal to the package: not part of any entry's export surface.
 */
export function toUserTextMessages(input: string | ModelMessage[]): ModelMessage[] {
  return typeof input === 'string'
    ? [{ role: 'user', content: [{ type: 'text', text: input }] }]
    : [...input];
}
