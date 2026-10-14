import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { REPORT_CHANNEL, STATUS_CHANNEL } from '../src/report-message.ts';
import { textContent, WORK_RESULT } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';

type Session = Awaited<ReturnType<typeof createAgentSession>>['session'];
interface Fixture {
  session: Session;
  /** Resolves once the `runs`th run is over, which OptChat marks with its end boundary after Pi goes idle. */
  settled: (runs: number) => Promise<void>;
  /** The profile's memory log, oldest first. */
  log: () => { kind: string; text: string }[];
  /** Every main-agent request the fixture model was sent. */
  requests: Context['messages'][];
  errors: string[];
  shutdown: () => Promise<void>;
}

/** A Pi session on profile `fixture`, OptChat loaded beside `other`. The fixture model answers each request with `reply`,
 * or "Noted." when it gives nothing. */
async function withSession(other: (pi: ExtensionAPI) => void, tools: string[], body: (fixture: Fixture) => Promise<void>,
  reply: (messages: Context['messages']) => AssistantMessage['content'] | undefined = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bus-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const requests: Context['messages'][] = [];
  let session: Session | undefined, closedDown = false;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) requests.push(context.messages);
        const content = compression ? [{ type: 'text' as const, text: 'Summary.' }] : reply(context.messages) ?? [{ type: 'text' as const, text: 'Noted.' }];
        const message: AssistantMessage = { role: 'assistant', content, timestamp: Date.now(), stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop',
          api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason as 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, other] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', ...tools] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    const settled = async (runs: number) => {
      const ended = () => manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'optchat.run' && (e.data as { state?: string }).state === 'end').length;
      for (let i = 0; i < 300 && ended() < runs; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(ended(), runs);
    };
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = () => readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    const open = session;
    const shutdown = async () => { await open.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); closedDown = true; };
    await body({ session, settled, log, requests, errors, shutdown });
  } finally {
    if (session && !closedDown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('another extension reports on the event bus: taken while a profile is open, then logged as work, even before the first turn', async () => {
  let emit!: (data: Record<string, unknown>) => void;
  await withSession(pi => { emit = data => pi.events.emit(REPORT_CHANNEL, data); }, [], async ({ session, settled, log, requests, errors, shutdown }) => {
    const first: Record<string, unknown> = { text: '[agents:fix-login] busy → idle' };
    emit(first);
    assert.equal(first.taken, true);
    await settled(1);
    assert.ok(textContent(requests.at(-1)?.at(-1)?.content).endsWith('[agents:fix-login] busy → idle'), 'the report starts a turn of its own');
    await session.prompt('Anything new?');
    await settled(2);
    const later: Record<string, unknown> = { text: '[agents:fix-login] hv tell: done, PR is up' };
    emit(later);
    await settled(3);
    for (const bad of [{ text: '' }, { text: 7 }]) { emit(bad); assert.ok(!('taken' in bad)); }

    assert.deepEqual(log().filter(e => e.kind === 'work').map(e => e.text), ['[agents:fix-login] busy → idle', '[agents:fix-login] hv tell: done, PR is up']);
    assert.deepEqual(errors, []);
    await shutdown();
    const closed: Record<string, unknown> = { text: '[agents:fix-login] busy → idle' };
    emit(closed);
    assert.ok(!('taken' in closed), 'no profile open: the report stays with its sender');
  });
});

test('another extension adds its line to the status line that ends a turn\'s request, and its tool hands memory what it read as work', async () => {
  let unread = 1;
  let asked = 0;
  const read = `[agents:fix-login] 2026-10-13T14:07 the PR is up, and the migration needs max.`;
  const inbox = (pi: ExtensionAPI) => {
    pi.events.on(STATUS_CHANNEL, data => { asked++; if (unread) (data as { lines: string[] }).lines.push(`Inbox: ${unread} unread`); });
    pi.registerTool({ name: 'inbox', label: 'Inbox', description: 'Read the inbox.', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: read }], details: WORK_RESULT }) });
  };
  // The inbox is read once, and its line stays until the test empties it, so the call after the tool result has one to leave out.
  let called = false;
  const reading = (messages: Context['messages']) => messages.at(-1)?.role === 'toolResult' || called ? undefined : (called = true, [{ type: 'toolCall' as const, id: 'call-1', name: 'inbox', arguments: {} }]);
  await withSession(inbox, ['inbox'], async ({ session, settled, log, requests, errors }) => {
    await session.prompt('What came in?');
    await settled(1);
    const [first, second] = requests;
    assert.deepEqual(first.at(-1), { role: 'user', content: [{ type: 'text', text: '[OptChat status] Inbox: 1 unread' }], timestamp: 0 }, 'the line ends the turn\'s first request');
    assert.equal(second.at(-1)?.role, 'toolResult', 'the turn already had it: the call after a tool result goes without');
    assert.equal(asked, 1, 'and the extension is not asked for it');
    const entries = log();
    assert.deepEqual(entries.filter(e => e.kind === 'work').map(e => e.text), [read]);
    assert.ok(!entries.some(e => e.text.includes('Inbox:')), 'the status line is never stored');
    const turn = requests.length;
    unread = 0;
    await session.prompt('Anything else?');
    await settled(2);
    assert.ok(textContent(requests[turn].at(-1)?.content).endsWith('Anything else?'), 'nothing unread, no line');
    assert.deepEqual(errors, []);
  }, reading);
});
