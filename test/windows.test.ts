import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createAgentSession, CustomMessageComponent, initTheme, ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext, type MessageRenderer, type Theme } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, type Component, type Terminal } from '@earendil-works/pi-tui';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage, UsageLedger } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { serveWindows, connectWindow, joinHeadless, type WindowEvent } from '../src/window-bridge.ts';
import { profileSocket, lockProfile, createProfile, profilePath } from '../src/profiles.ts';
import { openConnectedWindow, registerConnectedRenderer } from '../src/connected-window.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';

/** These tests cover delegation below the first level, which profiles opt into with Subagent levels. */
const nested = () => ({ subagentLevels: 3, maxAgents: 8 });

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(contextWindow = 1_000_000, maxTokens = 64_000) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-window-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const control = { failSummary: false, truncateSummary: false, summaryText: 'Handoff: retained the user correction and actual work.' };
  const requests: string[] = [], summaries: string[] = [], reports: string[] = [], warnings: string[] = [];
  const summaryOptions: { maxTokens?: number; systemPrompt?: string }[] = [];
  runtime.registerProvider('window-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = textContent(last && 'content' in last ? last.content : '');
      const summary = text.includes('Prior handoff:');
      if (summary) summaries.push(text); else requests.push(text);
      if (summary) summaryOptions.push({ maxTokens: options?.maxTokens, systemPrompt: textContent(context.messages.find(m => m.role === 'system')?.content) });
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: summary ? control.summaryText : `Reply: ${text.split('Your task:\n').at(-1)}` }],
        api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      if (summary && control.truncateSummary) message.stopReason = 'length';
      if (!summary && text.split('Your task:\n').at(-1) === 'provider-failure') {
        message.stopReason = 'error'; message.errorMessage = 'Synthetic provider error';
        message.content = [{ type: 'text', text: 'PARTIAL_FINAL_TEXT' }];
      }
      if (!summary && last?.role === 'user' && text.includes('descendant-evidence-task')) {
        message.stopReason = 'toolUse';
        message.content = [{ type: 'toolCall', id: 'evidence', name: 'bash', arguments: { command: "printf 'DESCENDANT_TESTS_PASSED_123\\n'" } }];
      }
      if (summary && control.failSummary) { message.stopReason = 'error'; message.errorMessage = 'Synthetic summarizer unavailable'; }
      if (text === 'spawn one') {
        message.content = [{ type: 'toolCall', id: 'spawn-one', name: 'spawn', arguments: { tasks: [{ task: 'hold work descendant' }] } }];
        message.stopReason = 'toolUse';
      }
      if (last?.role === 'user' && text.split('Your task:\n').at(-1) === 'spawn quick') {
        message.content = [{ type: 'toolCall', id: 'spawn-quick', name: 'spawn', arguments: { tasks: [{ task: 'slow descendant' }] } }];
        message.stopReason = 'toolUse';
      }
      if (!summary && text.split('Your task:\n').at(-1) === 'long reply') message.content = [{ type: 'text', text: `${'x'.repeat(300_000)}END` }];
      if (text === 'ask main') {
        message.content = [{ type: 'toolCall', id: 'tell-main', name: 'tell_parent', arguments: { message: 'Need a decision from the main agent.' } }];
        message.stopReason = 'toolUse';
      }
      void (async () => {
        stream.push({ type: 'start', partial: message });
        const hold = !summary && (text.includes('hold work') || last?.role === 'toolResult' && text.includes('DESCENDANT_TESTS_PASSED_123'));
        // A held reply is mid-stream, as a real one would be while the model is still writing.
        if (hold) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Reply', partial: message });
        // Outlasts a few window status ticks, so its parent is seen waiting on it.
        if (!summary && text.endsWith('Your task:\nslow descendant')) await new Promise(resolve => setTimeout(resolve, 500));
        if (hold) await new Promise<void>(resolve => {
          if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : message.stopReason === 'length' ? 'length' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime), choice = () => ({ provider: 'window-test', model: 'child', thinking: 'off' as const });
  const ledger = new UsageLedger(dir);
  const summarize = createHandoffSummarizer(registry, choice, reply => ledger.compression(reply, 'compactor', 'owner'));
  const options = { settings: nested, parentSession: 'owner', usage: ledger, createSession: (options: Parameters<typeof createAgentSession>[0]) => createAgentSession({ ...options, modelRuntime: runtime }), summarizeHandoff: summarize };
  const children = new Children(memory, registry, choice, () => '', async text => { reports.push(text); }, text => warnings.push(text), dir, options);
  const unlock = await lockProfile(dir, 'test owner');
  return { control, dir, memory, children, requests, summaries, summaryOptions, reports, warnings, registry, choice, options, ledger,
    async close() { await children.close(); await memory.close(); await unlock(); rmSync(dir, { recursive: true, force: true }); } };
}

test('connected window keeps one real SDK conversation, communicates both ways, and completes its subtree with one handoff', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    assert.equal(f.reports.length, 1); assert.match(f.reports[0], /User started/);
    assert.equal(f.children.active, true, 'the conversation remains open between replies');
    await client.request('say', 'Correction: keep the existing API.');
    await until(() => f.children.messages(id).some(m => m.role === 'assistant' && textContent(m.content) === 'Reply: Correction: keep the existing API.'));
    assert.equal(f.children.history.records.size, 1);
    await client.request('tell-main', 'Please coordinate the release.');
    assert.match(f.reports.at(-1) ?? '', /User message.*coordinate the release/);
    await client.request('say', 'ask main');
    await until(() => f.reports.some(text => text.includes('Need a decision')));
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.tell(id, 'Main agent: proceed with tests.');
    await until(() => events.some(e => e.name === 'message' && e.text.includes('Main agent: proceed')));
    assert.deepEqual(events.filter(e => e.from === 'user').map(e => e.text), ['Investigate this repository.', 'Correction: keep the existing API.', 'ask main']);
    assert.equal(events.find(e => e.text.includes('Main agent: proceed'))?.from, undefined, 'main-agent guidance stays boxed');
    assert.ok(!events.some(e => e.name === 'message' && e.text.includes('<chat>')), 'frozen memory must not be rendered as user input');
    await client.request('say', 'hold work');
    await until(() => f.requests.at(-1) === 'hold work');
    const [descendant] = await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await client.request('complete');
    await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
    assert.equal(f.children.history.records.get(descendant)?.state, 'stopped');
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.equal(f.children.history.records.get(id)?.handoff?.delivered, true);
    assert.match(f.reports.at(-1) ?? '', /completed by user/);
    assert.equal(f.summaries.length, 1);
    assert.match(f.summaries[0], /Correction: keep the existing API/);
    assert.match(f.summaries[0], /Main agent: proceed/);
    assert.doesNotMatch(f.summaries[0], /<chat>/);
    assert.equal(f.ledger.entries.filter(entry => entry.role === 'compactor').length, 1);
    await assert.rejects(client.request('say', 'Too late'), /closing/);
    await f.children.recoverHandoffs();
    assert.equal(f.summaries.length, 1, 'delivered handoffs must not be repeated');
    assert.deepEqual(f.warnings, []);
  } finally { client.close(); await close(); await f.close(); }
});

test('deleting a connected conversation from the Agents page ends its window', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'Investigate this repository.', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.remove(id);
    await until(() => events.some(e => e.name === 'finished'));
    assert.match(events.find(e => e.name === 'finished')?.text ?? '', /deleted from the Agents page/);
    await assert.rejects(client.request('say', 'Still there?'), /closing/);
  } finally { client.close(); await close(); await f.close(); }
});

test('connected window receives the real tool calls, results and live state, so it can draw them like Pi', async () => {
  const f = await fixture();
  const events: WindowEvent[] = [];
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, event => events.push(event), () => {});
  try {
    await client.request('start', 'descendant-evidence-task', f.dir);
    const id = events.find(e => e.name === 'started')?.text; assert.ok(id);
    // The fake model calls bash, then holds its next reply open, so the window sees a streaming reply.
    await until(() => events.some(e => e.message?.role === 'toolResult'));
    const call = events.find(e => e.message?.role === 'assistant')?.message;
    assert.ok(call?.role === 'assistant' && call.content.some(p => p.type === 'toolCall' && p.name === 'bash' && p.id === 'evidence'));
    const result = events.find(e => e.message?.role === 'toolResult')?.message;
    assert.ok(result?.role === 'toolResult' && result.toolCallId === 'evidence' && textContent(result.content).includes('DESCENDANT_TESTS_PASSED_123'));
    await until(() => events.some(e => e.live?.streaming));
    const live = events.findLast(e => e.live)?.live;
    assert.equal(live?.state, 'running'); assert.equal(live?.model, 'window-test/child');
    await f.children.spawn([{ task: 'hold work descendant' }], f.dir, undefined, id);
    await until(() => events.some(e => e.live?.agents === 1));
  } finally { client.close(); await close(); await f.close(); }
});

test("a headless run joins a busy profile: it gets the final reply after the agent's own agents report, and main gets the handoff", async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  try {
    const joined = await joinHeadless(f.dir);
    const reply = await joined.ask('spawn quick', f.dir);
    // The agent spawns a slow child and waits for it, then answers with its report; only that last answer is the reply.
    assert.match(reply, /^Reply: .*Reply: slow descendant/s);
    const [id] = [...f.children.history.records.values()].filter(run => run.connected).map(run => run.id);
    await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
    assert.equal(f.children.history.records.get(id)?.state, 'completed');
    assert.match(f.reports.at(-1) ?? '', /completed by user/);
    await assert.rejects(joined.ask('again', f.dir), /one request/);
    // Window events cut long text for display; the printed reply is never cut.
    assert.equal(await (await joinHeadless(f.dir)).ask('long reply', f.dir), `${'x'.repeat(300_000)}END`);
  } finally { await close(); await f.close(); }
});

test('a headless join fails visibly: no running session, or a provider error instead of a reply', async () => {
  const f = await fixture();
  try {
    await assert.rejects(joinHeadless(f.dir), /No running OptChat session/);
    const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
    try {
      const joined = await joinHeadless(f.dir);
      await assert.rejects(joined.ask('provider-failure', f.dir), /Synthetic provider error/);
    } finally { await close(); }
  } finally { await f.close(); }
});

initTheme('dark', false);
class OffscreenTerminal implements Terminal {
  start() {} stop() {} async drainInput() {} write() {}
  get columns() { return 100; } get rows() { return 30; } get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');

test('a connected window draws each reply with its tool results, the live turn, and Working vs Waiting for N agents', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-home-'));
  createProfile('draw');
  const close = await serveWindows(profilePath('draw'), f.children, () => true, async text => { f.reports.push(text); });
  const tui = new TuiMainScreen(new OffscreenTerminal());
  const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  let renderer: MessageRenderer | undefined, widget: (Component & { dispose?(): void }) | undefined;
  const sent: { content: unknown; details?: { from?: string; turn?: unknown[] } }[] = [];
  const pi = { registerMessageRenderer: (_type: string, r: MessageRenderer) => { renderer = r; }, sendMessage: (m: typeof sent[number]) => { sent.push(m); } } as unknown as ExtensionAPI;
  registerConnectedRenderer(pi);
  const ctx = { cwd: f.dir, shutdown() {}, ui: { setStatus() {}, notify() {}, setWorkingMessage() {}, setTitle() {},
    setWidget: (_key: string, factory?: (tui: TuiMainScreen, theme: Theme) => Component) => { widget?.dispose?.(); widget = factory?.(tui, plainTheme); } } } as unknown as ExtensionContext;
  // What the chat shows for a committed message, drawn through the registered renderer as Pi would.
  const chat = (message: typeof sent[number]) => plain(new CustomMessageComponent({ role: 'custom', customType: 'optchat-connected', content: message.content as string,
    display: true, details: message.details, timestamp: 1 }, renderer).render(100));
  const live = () => widget ? plain(widget.render(100)) : '';
  const turns = () => sent.filter(m => m.details?.turn);
  // A turn restored before any window is live (after /reload) still draws as a tool box, not plain text.
  const restored = { content: '', details: { from: 'agent', turn: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'echo restored' } }], api: 'x', provider: 'x', model: 'x', usage: emptyUsage(), stopReason: 'toolUse', timestamp: 1 },
    { role: 'toolResult', toolCallId: 'old', toolName: 'bash', content: [{ type: 'text', text: 'RESTORED_OUTPUT' }], isError: false, timestamp: 2 },
  ] } };
  assert.match(chat(restored), /\$ echo restored[\s\S]*RESTORED_OUTPUT/);
  const window = await openConnectedWindow(pi, ctx, 'draw');
  try {
    await window.submit('Investigate this repository.');
    const id = [...f.children.history.records.keys()][0]; assert.ok(id);
    await until(() => f.children.history.records.get(id)?.state === 'waiting' && turns().length === 1);
    assert.match(chat(turns()[0]), /Reply: Investigate this repository\./);
    await until(() => !/Working|Waiting/.test(live()));

    // A tool OptChat provides is drawn like a registered tool, on one line with its result, not as raw JSON.
    await window.submit('ask main');
    await until(() => turns().length >= 2);
    const asked = chat(turns()[1]);
    assert.match(asked, /tell_parent message="Need a decision from the main agent\."/);
    assert.match(asked, /Message sent to the main agent/);
    assert.doesNotMatch(asked, /^\s*"message":/m);
    await until(() => f.children.history.records.get(id)?.state === 'waiting' && turns().length >= 3);

    // Waiting on its own agent spins with a count; waiting on you does not spin at all.
    await window.submit('spawn one');
    await until(() => /Waiting for 1 agent/.test(live()));

    // The live turn shows the streaming reply under the spinner; the finished bash call settles into the chat with its output.
    await window.submit('descendant-evidence-task');
    await until(() => /Working/.test(live()) && /Reply/.test(live()));
    const bash = turns().map(chat).find(text => text.includes('printf'));
    assert.ok(bash, 'the bash call is in the chat');
    assert.match(bash, /DESCENDANT_TESTS_PASSED_123/, 'a reply and its tool results are one chat entry');
  } finally {
    widget?.dispose?.();
    window.close(); await close(); await f.close();
    rmSync(process.env.OPTCHAT_HOME!, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('a connected window titles its tab: waiting, working, done, and disconnected', async () => {
  const f = await fixture();
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = mkdtempSync(join(tmpdir(), 'optchat-home-'));
  createProfile('win');
  const close = await serveWindows(profilePath('win'), f.children, () => true, async text => { f.reports.push(text); });
  const titles: string[] = [];
  let closed = false;
  const pi = { sendMessage() {} } as unknown as ExtensionAPI;
  const ctx = (into: string[]) => ({ cwd: f.dir, shutdown() {},
    ui: { setStatus() {}, setWidget() {}, notify() {}, setWorkingMessage() {}, setTitle: (title: string) => into.push(title) } }) as unknown as ExtensionContext;
  try {
    const window = await openConnectedWindow(pi, ctx(titles), 'win');
    assert.deepEqual(titles, ['↳ win']);
    await window.submit('Investigate this repository.');
    await until(() => titles.at(-1) === '↳ win' && titles.includes('● ↳ win'));
    assert.deepEqual(titles.filter((t, i) => t !== titles[i - 1]), ['↳ win', '● ↳ win', '↳ win'], 'working while the child runs, waiting once it replies');
    await window.complete();
    assert.equal(titles.at(-1), '↳ win · done');

    const other: string[] = [];
    await openConnectedWindow(pi, ctx(other), 'win');
    await close(); closed = true;
    await until(() => other.at(-1) === '↳ win · disconnected');
  } finally {
    if (!closed) await close();
    await f.close();
    rmSync(process.env.OPTCHAT_HOME!, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});

test('SIGKILL of the client interrupts owner-hosted work and reports it', async () => {
  const f = await fixture();
  const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createConnection} from 'node:net';
    const socket = createConnection(process.argv[1]);
    socket.on('connect', () => socket.write(JSON.stringify({kind:'request',id:1,action:'start',text:'hold work',cwd:process.argv[2]})+'\\n'));
    socket.on('data', () => {});
  `, profileSocket(f.dir, 'windows'), f.dir], { stdio: 'ignore' });
  try {
    await until(() => f.requests.some(text => text.includes('hold work')));
    child.kill('SIGKILL');
    await until(() => f.reports.some(text => text.includes('interrupted (disconnected)')));
    assert.equal(f.children.active, false);
    assert.equal(f.children.history.list()[0].handoff?.delivered, true);
  } finally { child.kill('SIGKILL'); await close(); await f.close(); }
});

test('pending handoffs survive failed delivery and restart without another model call', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Remember the user correction.' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    await f.children.finish(id, 'complete');
    const run = f.children.history.records.get(id)!;
    // Simulate the durable state left by an owner crash before producing its handoff.
    run.state = 'waiting'; run.handoff = undefined; f.children.history.save(run);
    const failing = new Children(f.memory, f.registry, f.choice, () => '', async () => { throw new Error('delivery unavailable'); }, () => {}, f.dir, f.options);
    await assert.rejects(failing.recoverHandoffs(), /delivery unavailable/);
    const calls = f.summaries.length;
    const recovered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { recovered.push(text); }, () => {}, f.dir, f.options);
    await restored.recoverHandoffs(); await restored.recoverHandoffs();
    assert.equal(recovered.length, 1); assert.match(recovered[0], /owner-stopped/);
    assert.equal(f.summaries.length, calls);
    await failing.close(); await restored.close();
  } finally { await f.close(); }
});

test('disconnect during startup cancels cleanly, and importing owners reject new work', async () => {
  const f = await fixture();
  let available = false;
  const close = await serveWindows(f.dir, f.children, () => available, async text => { f.reports.push(text); });
  const client = await connectWindow(f.dir, () => {}, () => {});
  try {
    await assert.rejects(client.request('start', 'hello', f.dir), /importing/);
    assert.equal(f.children.history.records.size, 0);
    available = true;
    const start = client.request('start', 'hello', f.dir);
    client.close();
    await assert.rejects(start, /lost/);
    await close();
    assert.equal(f.children.active, false);
  } finally { client.close(); await f.close(); }
});


test('long handoffs fold all transcript chunks, and a failed summarizer still reports an honest fallback', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const info = f.children.history.records.get(id)!;
    const longCorrection = 'Original detail. 🧠 '.repeat(70_000) + ' FINAL USER CORRECTION';
    f.control.summaryText = 'Handoff: ' + 'Important detail. '.repeat(3000);
    const text = await f.options.summarizeHandoff(info, [
      { role: 'user', content: '<chat>PRIVATE MEMORY VIEW</chat>\n\nYour task:\nInitial task', timestamp: 1 },
      { role: 'user', content: longCorrection, timestamp: 2 },
    ]);
    assert.ok(f.summaries.length >= 3);
    assert.ok(f.summaries.some(chunk => chunk.includes('FINAL USER CORRECTION')));
    assert.ok(f.summaries.every(chunk => !chunk.includes('PRIVATE MEMORY VIEW')));
    const evidence = f.summaries.map(request => request.split('\nNext transcript chunk:\n')[1]).join('');
    assert.ok(evidence.includes(longCorrection), 'chunking must preserve all evidence, including Unicode at boundaries');
    for (const [i, request] of f.summaries.entries()) {
      const inputBytes = Buffer.byteLength(request) + Buffer.byteLength(f.summaryOptions[i].systemPrompt!);
      assert.ok(inputBytes / 4 <= 128_000, 'the prior handoff and instructions count toward the input budget');
      if (i) assert.ok(request.includes(f.control.summaryText.trim()), 'each call includes the full prior summary');
    }
    assert.equal(text, f.control.summaryText.trim(), 'useful detail beyond the old word limit is retained');
    assert.match(text, /Handoff:/);
    f.control.failSummary = true;
    await f.children.finish(id, 'disconnected');
    assert.match(f.reports.at(-1) ?? '', /interrupted \(disconnected\)/);
    assert.match(f.reports.at(-1) ?? '', /Automatic summary unavailable.*Synthetic summarizer unavailable/);
    assert.doesNotMatch(f.reports.at(-1) ?? '', /Stopped by the user|tell resumes it/, 'a window that ends is not stopped by the user, and resume refuses connected runs');
    assert.match(f.reports.at(-1) ?? '', /Full transcript:/);
    assert.equal(info.handoff?.delivered, true);
  } finally { await f.close(); }
});

test('a transcript below the handoff budget is summarized in one call with a larger output allowance', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const detail = 'Complete evidence. '.repeat(25_000);
    await f.options.summarizeHandoff(f.children.history.records.get(id)!, [
      { role: 'user', content: 'Initial task', timestamp: 1 },
      { role: 'user', content: detail, timestamp: 2 },
    ]);
    assert.equal(f.summaries.length, 1);
    assert.ok(f.summaries[0].includes(detail));
    assert.equal(f.summaryOptions[0].maxTokens, 16_000);
  } finally { await f.close(); }
});

test('handoffs respect smaller model windows and output limits while retaining all evidence', async () => {
  const f = await fixture(32_000, 2048);
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    const detail = 'Smaller model evidence. '.repeat(10_000);
    await f.options.summarizeHandoff(f.children.history.records.get(id)!, [
      { role: 'user', content: 'Initial task', timestamp: 1 },
      { role: 'user', content: detail, timestamp: 2 },
    ]);
    assert.ok(f.summaries.length > 1);
    assert.ok(f.summaries.map(request => request.split('\nNext transcript chunk:\n')[1]).join('').includes(detail));
    for (const [i, request] of f.summaries.entries()) {
      const options = f.summaryOptions[i];
      assert.equal(options.maxTokens, 2048);
      assert.ok((Buffer.byteLength(request) + Buffer.byteLength(options.systemPrompt!)) / 4 + options.maxTokens <= 32_000 * 0.8);
    }
  } finally { await f.close(); }
});

test('a handoff truncated by the output limit reports a fallback instead of claiming to be complete', async () => {
  const f = await fixture();
  try {
    const [id] = await f.children.spawn([{ task: 'Initial task' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(id)?.state === 'waiting');
    f.control.truncateSummary = true;
    await f.children.finish(id, 'complete');
    assert.match(f.reports.at(-1) ?? '', /Automatic summary unavailable.*output limit/);
    assert.match(f.reports.at(-1) ?? '', /Full transcript:/);
    assert.equal(f.children.history.records.get(id)?.handoff?.delivered, true);
  } finally { await f.close(); }
});

test('recovery leaves newly started conversations to their own completion path', async () => {
  const f = await fixture();
  let releaseOld = () => {}, releaseNew = () => {};
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
  try {
    const [old] = await f.children.spawn([{ task: 'Earlier interrupted session' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(old)?.state === 'waiting');
    await f.children.finish(old, 'complete');
    const oldInfo = f.children.history.records.get(old)!;
    oldInfo.handoff = undefined; oldInfo.state = 'interrupted'; f.children.history.save(oldInfo);
    const calls: string[] = [];
    f.options.summarizeHandoff = async run => {
      calls.push(run.id); const serial = calls.length;
      await (run.id === old ? oldGate : newGate);
      return `Summary from call ${serial}`;
    };
    let recovered = false;
    const recovery = f.children.recoverHandoffs().then(() => { recovered = true; });
    await until(() => calls.includes(old));
    const [fresh] = await f.children.spawn([{ task: 'New connected session' }], f.dir, undefined, undefined, true);
    await until(() => f.children.history.records.get(fresh)?.state === 'waiting');
    const finish = f.children.finish(fresh, 'complete');
    await until(() => calls.includes(fresh));
    releaseOld();
    await until(() => recovered || calls.filter(id => id === fresh).length > 1);
    assert.equal(recovered, true, 'recovery must finish while the new conversation is still summarizing');
    assert.equal(calls.filter(id => id === fresh).length, 1);
    releaseNew();
    await Promise.all([finish, recovery]);
    assert.equal(f.reports.filter(text => text.startsWith(`[${fresh}] Connected conversation`)).length, 1);
  } finally { releaseOld(); releaseNew(); await f.close(); }
});

test('handoffs include stopped descendant evidence at every depth, including after restart', async () => {
  const f = await fixture();
  try {
    const [parent] = await f.children.spawn([{ task: 'hold work parent' }], f.dir, undefined, undefined, true);
    await until(() => f.requests.some(text => text.includes('hold work parent')));
    const [child] = await f.children.spawn([{ task: 'hold work child' }], f.dir, undefined, parent);
    await until(() => f.requests.some(text => text.includes('hold work child')));
    const [grandchild] = await f.children.spawn([{ task: 'descendant-evidence-task' }], f.dir, undefined, child);
    await until(() => f.requests.some(text => text.includes('DESCENDANT_TESTS_PASSED_123')));
    await f.children.finish(parent, 'complete');
    assert.ok(f.children.messages(grandchild).some(m => m.role === 'toolResult' && textContent(m.content).includes('DESCENDANT_TESTS_PASSED_123')));
    const root = f.children.history.records.get(parent)!, childRun = f.children.history.records.get(child)!, grandchildRun = f.children.history.records.get(grandchild)!;
    const checkEvidence = (handoff: string) => {
      assert.match(f.summaries.join('\n'), /TOOL RESULT \(bash, error=false\): DESCENDANT_TESTS_PASSED_123/);
      assert.ok(f.summaries.join('\n').includes(`AGENT ${grandchild} · parent ${child} · stopped`));
      assert.ok(handoff.includes(grandchildRun.sessionFile!));
      assert.ok(handoff.includes(`[${child}] stopped · parent ${parent}`));
    };
    checkEvidence(root.handoff!.text!);

    // Recovery must use persisted relationships, and one missing transcript must not hide the others.
    root.state = 'waiting'; root.handoff = undefined; f.children.history.save(root);
    unlinkSync(childRun.sessionFile!); f.summaries.length = 0;
    const recovered: string[] = [];
    const restored = new Children(f.memory, f.registry, f.choice, () => '', async text => { recovered.push(text); }, () => {}, f.dir, f.options);
    try {
      await restored.recoverHandoffs();
      assert.equal(recovered.length, 1); checkEvidence(recovered[0]);
      assert.ok(recovered[0].includes(`No transcript available. Run metadata: ${join(f.dir, 'runs', `${child}.optchat.json`)}`));
    } finally { await restored.close(); }
  } finally { await f.close(); }
});

for (const scenario of ['before-first-tick', 'after-reply', 'missing-transcript'] as const) {
  test(`provider failure drains terminal messages before finishing (${scenario})`, async t => {
    const f = await fixture();
    const events: WindowEvent[] = [];
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    const interval = t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
      if (delay === 150) { tick = callback; return originalInterval(() => {}, 10000); }
      return originalInterval(callback, delay);
    });
    const close = await serveWindows(f.dir, f.children, () => true, async text => { f.reports.push(text); });
    const client = await connectWindow(f.dir, event => events.push(event), () => {});
    // The server's connection handler runs on a later tick, so the mock must stay installed until it has captured the status timer.
    await until(() => tick !== undefined);
    interval.mock.restore();
    try {
      await client.request('start', scenario === 'after-reply' ? 'Hello' : 'provider-failure', f.dir);
      const id = events.find(e => e.name === 'started')?.text; assert.ok(id); assert.ok(tick);
      if (scenario === 'after-reply') {
        await until(() => f.children.history.records.get(id)?.state === 'waiting');
        tick(); await until(() => events.filter(e => e.name === 'message').length === 2);
        await client.request('say', 'provider-failure');
      }
      await until(() => f.children.history.records.get(id)?.handoff?.delivered === true);
      assert.ok(f.children.messages(id).some(m => m.role === 'assistant' && textContent(m.content).includes('PARTIAL_FINAL_TEXT')));
      if (scenario === 'missing-transcript') unlinkSync(f.children.history.records.get(id)!.sessionFile!);
      tick();
      await until(() => events.some(e => e.name === 'finished'));
      const messages = events.filter(e => e.name === 'message');
      if (scenario !== 'missing-transcript') {
        assert.equal(messages.filter(e => e.from === 'agent' && e.text === 'PARTIAL_FINAL_TEXT').length, 1);
        assert.equal(messages.filter(e => e.from === 'user' && e.text === 'provider-failure').length, 1);
        assert.equal(messages.length, scenario === 'after-reply' ? 4 : 2);
        assert.equal(events.at(-1)?.name, 'finished');
        assert.ok(!messages.some(e => e.text.includes('<chat>')));
      }
      tick();
      assert.equal(events.filter(e => e.name === 'finished').length, 1);
    } finally { interval.mock.restore(); client.close(); await close(); await f.close(); }
  });
}
