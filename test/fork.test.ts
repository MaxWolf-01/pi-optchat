import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createForkCompressor, Turns } from '../src/fork.ts';
import { emptyUsage } from '../src/usage.ts';
import type { Compression } from '../src/memory.ts';

const model = { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-opus-5-5' } as Model<Api>;
/** A registry whose model answers each request with the next of `lines`, and keeps the payloads it was sent. */
function registry(lines: string[]) {
  const sent: Record<string, unknown>[] = [];
  const fake = {
    streamSimple: (_model: Model<Api>, _context: unknown, options: { onPayload: () => Record<string, unknown> }) => {
      sent.push(options.onPayload());
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: lines.shift() ?? '' }], api: model.api, provider: model.provider,
        model: model.id, timestamp: 0, stopReason: 'stop', usage: emptyUsage() };
      return { result: async () => message };
    },
  };
  return { sent, registry: fake as unknown as ModelRegistry };
}
const turn = {
  model,
  payload: { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'system' }], tools: [], thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n0+1|user: hi\n</chat>' }] }, { role: 'system', content: [], output_config: { effort: 'medium' } }] },
  answer: 'the reply',
};
const input: Compression = { context: 'unused', source: `echo: ${'x'.repeat(900)}`, part: { l: 0, i: 3 } };
const noFallback = async () => { throw new Error('fallback used'); };

test('a fork resends the turn\'s request unchanged, then its reply, the task, and the effort for the task', async () => {
  const { sent, registry: models } = registry(['a short line']);
  const turns = new Turns(); turns.finish(turn);
  const line = await createForkCompressor(models, turns, () => 'low', noFallback)(input, AbortSignal.timeout(1000));
  assert.equal(line, 'a short line');
  const [payload] = sent, messages = payload.messages as { role: string; content: { text?: string }[]; output_config?: unknown }[];
  for (const key of ['model', 'system', 'tools', 'thinking', 'output_config']) assert.deepEqual(payload[key], turn.payload[key as keyof typeof turn.payload], key);
  assert.deepEqual(messages.slice(0, 2), turn.payload.messages, 'the turn\'s messages are the prefix, byte for byte');
  assert.deepEqual(messages.slice(2).map(m => m.role), ['assistant', 'user', 'system']);
  assert.equal(messages[2].content[0].text, 'the reply');
  assert.match(messages[3].content[0].text!, /^Compaction: compress message 3/);
  assert.deepEqual(messages[4].output_config, { effort: 'low' });
});

test('a line over the limit is asked for again in the same conversation, and the shortest is kept', async () => {
  const { sent, registry: models } = registry(['y'.repeat(700), 'short enough']);
  const turns = new Turns(); turns.finish(turn);
  assert.equal(await createForkCompressor(models, turns, () => 'low', noFallback)(input, AbortSignal.timeout(1000)), 'short enough');
  const second = sent[1].messages as { role: string; content: { text?: string }[] }[];
  assert.deepEqual(second.slice(-2).map(m => m.role), ['assistant', 'user']);
  assert.match(second.at(-1)!.content[0].text!, /^Too long: your line is 700 bytes/);
});

test('a fork waits while a turn runs and forks the turn that ended; before any turn, the fallback writes the line', async () => {
  const { sent, registry: models } = registry(['line']);
  const turns = new Turns();
  assert.equal(await createForkCompressor(models, turns, () => 'low', async () => 'from the compactor')(input, AbortSignal.timeout(1000)), 'from the compactor');
  turns.start();
  const pending = createForkCompressor(models, turns, () => 'low', noFallback)(input, AbortSignal.timeout(1000));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 0, 'nothing is sent while the turn runs');
  turns.finish({ ...turn, answer: 'the newer reply' });
  assert.equal(await pending, 'line');
  assert.equal((sent[0].messages as { content: { text?: string }[] }[])[2].content[0].text, 'the newer reply');
});
