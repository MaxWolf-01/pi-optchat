import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { bytes, NODE, type Compressor } from './memory.ts';
import { compaction, IMPORT_GUIDANCE, tooLong } from './prompts.ts';
import { record } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

/** A finished turn, as a fork continues it: the first and the last request it sent, byte for byte, its final reply's text,
 * and its model. */
export interface Turn { first: Record<string, unknown>; payload: Record<string, unknown>; answer: string; model: Model<Api> }

/** The last finished turn. While a turn runs, a fork waits for it to end, so a summary starts from the turn its message was in. */
export class Turns {
  private last?: Turn;
  private running?: { ended: Promise<void>; end: () => void };
  /** A turn started. */
  start() {
    if (this.running) return;
    let end = () => {};
    const ended = new Promise<void>(resolve => { end = resolve; });
    this.running = { ended, end };
  }
  /** A turn ended; without `turn` it sent no request, and the one before stays the last. */
  finish(turn?: Turn) {
    if (turn) this.last = turn;
    this.running?.end(); this.running = undefined;
  }
  /** The last finished turn, even while another runs. */
  get finished() { return this.last; }
  /** The last finished turn once none runs, or undefined before the first. */
  async latest(signal: AbortSignal) {
    while (this.running) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => { this.running!.ended.then(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
    }
    signal.throwIfAborted();
    return this.last;
  }
}

/** Effort as Anthropic takes it per message; a level below low runs at low. */
const effortOf = (level: ThinkingLevel) => level === 'off' || level === 'minimal' ? 'low' : level;
const text = (role: 'user' | 'assistant', value: string) => ({ role, content: [{ type: 'text', text: value }] });

/**
 * A compressor that writes each line as a fork of the last finished turn: the turn's model is sent the turn's last request
 * unchanged, then its reply and the compaction task, so everything up to the task is read from the cache the turn wrote.
 * A message's line waits while a turn runs, since the message may be in it. A merge needs only the view, so it forks the
 * last finished turn's first request at once, which is the system prompt, the view and one message: a shorter prefix to
 * reread than the whole turn's, and also in the cache.
 * The task runs at `effort`, set by a system message after it: Anthropic keeps the cached prefix through a per-message
 * effort change, where a changed top-level effort would start the cache over. Before any turn has finished there is
 * nothing to fork, and `fallback` writes the line. A line over `accepted` bytes is asked for again in the same
 * conversation, as the compactor does.
 */
export function createForkCompressor(registry: ModelRegistry, turns: Turns, effort: () => ThinkingLevel, fallback: Compressor,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes): Compressor {
  return async (input, signal) => {
    const merge = input.part.l > 0, turn = merge ? turns.finished : await turns.latest(signal);
    if (!turn) return fallback(input, signal);
    const base = merge ? turn.first : turn.payload;
    if (!Array.isArray(base.messages)) return fallback(input, signal);
    const task = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction(input)}`;
    // The first request ends on the turn's opening message, and a merge's task follows it as the next user message.
    const reply = merge ? [] : [text('assistant', turn.answer || '(the turn ended without a reply)')];
    const messages: unknown[] = [...base.messages, ...reply, text(merge ? 'assistant' : 'user', merge ? '(this turn is set aside for a compaction)' : task),
      ...(merge ? [text('user', task)] : []), { role: 'system', content: [], output_config: { effort: effortOf(effort()) } }];
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const payload = { ...base, messages: [...messages] };
      const reply: AssistantMessage = await registry.streamSimple(turn.model, { messages: [] }, { signal, onPayload: () => payload }).result();
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Fork ${reply.stopReason}`);
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Error('Fork returned no text.');
      tries.push(line);
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/�$/, '');
      messages.push(text('assistant', line), text('user', tooLong(bytes(line), cut)));
    }
    if (!tries.length) throw new Error('Fork returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}

/** The request as a fork resends it, copied when the turn sends it: Pi may change the object after. */
export const snapshot = (payload: unknown) => record(payload) ? structuredClone(payload) : undefined;
