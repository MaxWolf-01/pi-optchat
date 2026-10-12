import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { bytes, NODE, type Compressor } from './memory.ts';
import { compaction, IMPORT_GUIDANCE, pointedCompaction, tooLong } from './prompts.ts';
import { cachePayload, record, splitView } from './cache.ts';
import { primeFirst } from './compactor.ts';
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
    if (this.last) for (const wake of this.waiting.splice(0)) wake();
  }
  private waiting: (() => void)[] = [];
  /** The last finished turn, even while another runs; before the first, it waits for one. */
  async finished(signal: AbortSignal) {
    while (!this.last) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => { this.waiting.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
    }
    return this.last;
  }
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
 * A compressor that writes a line with the main agent's model, from the cache its turns wrote.
 *
 * A message's line forks the last finished turn: the turn's last request unchanged, then its reply and the task, so all of
 * it is read from the cache. It waits while a turn runs, since the message may be in it. The message is almost always in
 * the forked request already, so the task names it by its start and end instead of repeating it, which would be paid again
 * as a cache write; a message the request does not hold is quoted whole.
 *
 * A merge needs nearby context, not the whole chat at full detail, so it is sent the compactions' own view (`input.context`,
 * the chat merged further, 16-32 KB) after the turns' tools and system prompt, as the recipe's compactions are. Parallel
 * merges share that view, so the first primes the cache and the rest read it. Nothing waits on a merge, so before the first
 * turn it waits for one; a message's line then goes to `fallback`, since the turn waits on it.
 *
 * The task runs at `effort`, set by a system message after it: Anthropic keeps the cached prefix through a per-message
 * effort change, where a changed top-level effort would start the cache over. With `gist`, a merge of 8 messages or more
 * opens with their gist. A line over `accepted` bytes is asked for again in the same conversation, as the compactor does.
 */
export function createForkCompressor(registry: ModelRegistry, turns: Turns, effort: () => ThinkingLevel, fallback: Compressor,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes, gist = () => false): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const merge = input.part.l > 0, turn = merge ? await turns.finished(signal) : await turns.latest(signal);
    if (!turn || !Array.isArray(turn.payload.messages)) return fallback(input, signal);
    const guidance = input.historical ? IMPORT_GUIDANCE + '\n\n' : '';
    const settings = { effort: effortOf(effort()) };
    let base: Record<string, unknown>, messages: unknown[], prefix: string | undefined;
    if (merge) {
      base = turn.first;
      messages = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: `\n\n${guidance}${compaction({ ...input, gist: gist() })}` }] }];
      const view = splitView(input.context);
      prefix = view.length > 1 ? `${turn.model.id}\n${view.slice(0, -1).join('')}` : undefined;
    } else {
      base = turn.payload;
      const answer = text('assistant', turn.answer || '(the turn ended without a reply)');
      const held = holds([...turn.payload.messages, answer], input.source);
      messages = [...turn.payload.messages, answer, text('user', `${guidance}${held ? pointedCompaction(input) : compaction(input)}`)];
    }
    messages.push({ role: 'system', content: [], output_config: settings });
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      // cachePayload splits the view into marked blocks in place, so each attempt marks a copy.
      const payload = merge ? cachePayload(structuredClone({ ...base, messages })) : { ...base, messages: [...messages] };
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      let reply: AssistantMessage;
      try { reply = await registry.streamSimple(turn.model, { messages: [] }, { signal, onPayload: () => payload }).result(); }
      catch (error) { warmed(false); throw error; }
      warmed(reply.stopReason !== 'error' && reply.stopReason !== 'aborted');
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Fork ${reply.stopReason}`);
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Error('Fork returned no text.');
      tries.push(line);
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push(text('assistant', line), text('user', tooLong(bytes(line), cut)));
    }
    if (!tries.length) throw new Error('Fork returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}

/** Whether `messages` hold the message `source` (its `kind: ` and a tool's `name: ` prefix aside), found by its last characters. */
function holds(messages: unknown[], source: string) {
  const tail = JSON.stringify(source.slice(-120)).slice(1, -1);
  return tail.length > 20 && JSON.stringify(messages).includes(tail);
}

/** The request as a fork resends it, copied when the turn sends it: Pi may change the object after. */
export const snapshot = (payload: unknown) => record(payload) ? structuredClone(payload) : undefined;
