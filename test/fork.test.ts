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
const first = { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'system' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n0+1|user: hi\n</chat>' }] }, { role: 'system', content: [], output_config: { effort: 'medium' } }] };
const turn = {
  model, first,
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
  // Byte for byte but for the cache mark on the turn's last block, which marks where the turn was cached.
  const unmarked = JSON.parse(JSON.stringify(messages.slice(0, 2), (k, v) => k === 'cache_control' ? undefined : v));
  assert.deepEqual(unmarked, turn.payload.messages, 'the turn\'s messages are the prefix');
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

test('a merge is sent the turns\' tools and system prompt, then the compactions\' view and the task, at once even while a turn runs', async () => {
  const { sent, registry: models } = registry(['merged line']);
  const turns = new Turns(); turns.finish(turn); turns.start();
  const view = `<chat>\n${Array.from({ length: 9 }, (_, i) => `${i}+1|line ${i}`).join('\n')}\n</chat>`;
  const merge: Compression = { context: view, source: `${'a'.repeat(300)}\n${'b'.repeat(300)}`, part: { l: 1, i: 0 } };
  assert.equal(await createForkCompressor(models, turns, () => 'low', noFallback)(merge, AbortSignal.timeout(1000)), 'merged line');
  const [payload] = sent, messages = payload.messages as { role: string; content: { text?: string; cache_control?: unknown }[]; output_config?: unknown }[];
  for (const key of ['model', 'system']) assert.deepEqual(payload[key], first[key as keyof typeof first], key);
  assert.deepEqual(messages.map(m => m.role), ['user', 'system']);
  assert.equal(messages[0].content.slice(0, -1).map(b => b.text).join(''), view, 'the compactions\' view, whole, in marked blocks');
  assert.ok(messages[0].content.some(b => b.cache_control), 'the view carries cache marks');
  assert.match(messages[0].content.at(-1)!.text!, /Compaction: merge lines 0\+1 and 1\+1/);
  assert.deepEqual(messages[1].output_config, { effort: 'low' });
});

test('a message the forked turn holds is named by its start and end; one it does not hold is quoted whole', async () => {
  const { sent, registry: models } = registry(['line', 'line']);
  const held = `read: ${'the file says this and that. '.repeat(40)}the end of the file`;
  const turns = new Turns();
  turns.finish({ ...turn, payload: { ...turn.payload, messages: [...turn.payload.messages, { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: held.slice(6) }] }] }] } });
  const compress = createForkCompressor(models, turns, () => 'low', noFallback);
  await compress({ context: 'unused', source: `echo: ${held}`, part: { l: 0, i: 7 } }, AbortSignal.timeout(1000));
  await compress(input, AbortSignal.timeout(1000));
  const task = (n: number) => (sent[n].messages as { content: { text?: string }[] }[]).at(-2)!.content[0].text!;
  assert.match(task(0), /the tool result above in this conversation/);
  assert.ok(task(0).length < held.length, 'the held message is not repeated');
  assert.ok(task(1).includes(input.source), 'a message the turn does not hold is quoted whole');
});

test('with gist on, a merge of 8 messages or more is asked to open with their gist', async () => {
  const { sent, registry: models } = registry(['l', 'l']);
  const turns = new Turns(); turns.finish(turn);
  const compress = createForkCompressor(models, turns, () => 'low', noFallback, undefined, undefined, () => true);
  const view = '<chat>\n0+1|a\n</chat>', source = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
  await compress({ context: view, source, part: { l: 3, i: 0 } }, AbortSignal.timeout(1000));
  await compress({ context: view, source, part: { l: 2, i: 0 } }, AbortSignal.timeout(1000));
  const task = (n: number) => (sent[n].messages as { content: { text?: string }[] }[])[0].content.at(-1)!.text!;
  assert.match(task(0), /These lines stand for 8 messages\. Open with their gist/);
  assert.doesNotMatch(task(1), /gist/);
});

test('a merge before any turn waits for the first one instead of going to the fallback', async () => {
  const { sent, registry: models } = registry(['merged line']);
  const turns = new Turns();
  const merge: Compression = { context: 'unused', source: `${'a'.repeat(300)}\n${'b'.repeat(300)}`, part: { l: 1, i: 0 } };
  const pending = createForkCompressor(models, turns, () => 'low', noFallback)(merge, AbortSignal.timeout(1000));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 0);
  turns.finish(turn);
  assert.equal(await pending, 'merged line');
});

test('a fork writes nothing new to the cache: its marks sit where the turn or the compactions\' view was cached, not on the task', async () => {
  const { sent, registry: models } = registry(['line', 'line']);
  const turns = new Turns(); turns.finish({ ...turn, payload: { ...turn.payload, cache_control: { type: 'ephemeral' } } });
  const compress = createForkCompressor(models, turns, () => 'low', noFallback);
  await compress(input, AbortSignal.timeout(1000));
  await compress({ context: `<chat>\n${Array.from({ length: 9 }, (_, i) => `${i}+1|line ${i}`).join('\n')}\n</chat>`, source: `${'a'.repeat(300)}\n${'b'.repeat(300)}`, part: { l: 1, i: 0 } }, AbortSignal.timeout(1000));
  for (const payload of sent) assert.equal(payload.cache_control, undefined, 'no mark at the end of the request');
  const leaf = sent[0].messages as { content: { cache_control?: unknown }[] }[];
  assert.ok(leaf[0].content.at(-1)!.cache_control, 'the turn\'s last message carries the mark');
  assert.ok(!leaf.slice(1).some(m => m.content.some(b => b.cache_control)), 'nothing after it does');
  const merge = sent[1].messages as { content: { text?: string; cache_control?: unknown }[] }[];
  assert.ok(!merge[0].content.at(-1)!.cache_control, 'the task is not marked');
});
