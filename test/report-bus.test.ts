import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, CustomMessageComponent, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  UserMessageComponent, type ExtensionAPI, type MessageRenderer } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { REPORT_CHANNEL } from '../src/report-message.ts';
import { REPORT_TYPE, textContent, withoutFullChat } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';


test('another extension reports on the event bus: taken while a profile is open, then logged as work, even before the first turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bus-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const seen: string[] = [];
  let emit!: (data: Record<string, unknown>) => void;
  const reporter = (pi: ExtensionAPI) => { emit = data => pi.events.emit(REPORT_CHANNEL, data); };
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined, closedDown = false;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) seen.push(textContent(context.messages.at(-1)?.content));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : 'Noted.' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, reporter] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    // A run is over once OptChat writes its end boundary, after Pi goes idle: wait for the `runs`th.
    const settled = async (runs: number) => {
      const ended = () => manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'optchat.run' && (e.data as { state?: string }).state === 'end').length;
      for (let i = 0; i < 300 && ended() < runs; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(ended(), runs);
    };

    const first: Record<string, unknown> = { text: '[agents:fix-login] busy → idle' };
    emit(first);
    assert.equal(first.taken, true);
    await settled(1);
    assert.ok(seen.at(-1)?.endsWith('[agents:fix-login] busy → idle'), 'the report starts a turn of its own');
    await session.prompt('Anything new?');
    await settled(2);
    const later: Record<string, unknown> = { text: '[agents:fix-login] hv tell: done, PR is up' };
    emit(later);
    await settled(3);
    for (const bad of [{ text: '' }, { text: 7 }]) { emit(bad); assert.ok(!('taken' in bad)); }

    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    assert.deepEqual(log.filter(e => e.kind === 'work').map(e => e.text), ['[agents:fix-login] busy → idle', '[agents:fix-login] hv tell: done, PR is up']);
    assert.deepEqual(errors, []);
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); closedDown = true;
    const closed: Record<string, unknown> = { text: '[agents:fix-login] busy → idle' };
    emit(closed);
    assert.ok(!('taken' in closed), 'no profile open: the report stays with its sender');
  } finally {
    if (session && !closedDown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
