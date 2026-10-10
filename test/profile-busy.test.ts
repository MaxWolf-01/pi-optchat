import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory } from '../src/memory.ts';
import { checkSocketPath, createProfile, isWindows, loadConfig, lockProfile, profilePath, profileSocket, saveConfig, SOCKET_PATH_LIMIT } from '../src/profiles.ts';

const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
after(() => rmSync(agentDir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(dir: string, ui: Partial<ExtensionUIContext>, bound?: string, talked = false) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (bound) manager.appendCustomEntry('optchat.profile', { name: bound });
  if (talked) manager.appendMessage({ role: 'user', content: 'earlier turn', timestamp: Date.now() });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] });
  const titles: string[] = [], errors: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), setTitle: t => { titles.push(t); },
    notify: (text, type) => { if (type === 'error') errors.push(text); }, ...ui };
  await session.bindExtensions({ uiContext, mode: 'tui' });
  return { session, titles, errors, manager };
}

test('a busy profile offers to connect or pick another profile, and picking another opens it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: Awaited<ReturnType<typeof start>>['session'][] = [];
  let unlock: (() => Promise<void>) | undefined;
  try {
    for (const name of ['busy', 'other', 'third']) {
      createProfile(name);
      const config = loadConfig(profilePath(name));
      saveConfig(profilePath(name), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    }
    unlock = await lockProfile(profilePath('busy'), 'busy · PID 1 · elsewhere');

    // New session: pick `busy`, it's taken, choose "Back", then pick `other`.
    const asked: { title: string, options: string[] }[] = [];
    const picks = ['busy', 'Back', 'other'];
    const fresh = await start(dir, { select: async (title, options) => { asked.push({ title, options }); return picks.shift(); } });
    sessions.push(fresh.session);
    assert.deepEqual(asked.map(a => a.title.split('\n')[0]), ['OptChat profile', 'busy is open in another window', 'OptChat profile']);
    assert.match(asked[1].title, /busy · PID 1 · elsewhere/);
    assert.deepEqual(asked[1].options, ['Start a connected subagent conversation here', 'Back']);
    assert.equal(fresh.titles[0], 'π other');
    assert.deepEqual(fresh.errors, []);
    const bound = fresh.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(bound.map(e => e.type === 'custom' && e.data), [{ name: 'other' }], 'the session is bound to the profile actually opened');

    // `/optchat profile` makes a fresh session already bound to its pick; a busy pick can still go Back and rebind.
    const switchedPicks = ['Back', 'third']; // `other` is held by the session above
    const switched = await start(dir, { select: async () => switchedPicks.shift() }, 'busy');
    sessions.push(switched.session);
    assert.equal(switched.titles[0], 'π third');
    assert.deepEqual(switched.errors, []);
    const rebound = switched.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(rebound.map(e => e.type === 'custom' && e.data), [{ name: 'busy' }, { name: 'third' }], 'the latest binding wins');

    // A resumed conversation already belongs to `busy`, so it can only connect (or cancel), not switch.
    const resumedAsked: string[][] = [];
    const resumed = await start(dir, { select: async (_title, options) => { resumedAsked.push(options); return undefined; } }, 'busy', true);
    sessions.push(resumed.session);
    assert.deepEqual(resumedAsked, [['Start a connected subagent conversation here']]);
    assert.match(resumed.errors.join('\n'), /Profile already running/);
  } finally {
    for (const session of sessions) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await unlock?.(); await sleep(50);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connected window whose original window closed can leave: /new, /resume, /fork and /optchat profile work again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-left-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let owner: Awaited<ReturnType<typeof start>>['session'] | undefined, window: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    createProfile('busy');
    owner = (await start(dir, {}, 'busy')).session;
    const notes: string[] = [], asked: string[] = [];
    const picks = ['Start a connected subagent conversation here', undefined];
    window = (await start(dir, { notify: text => { notes.push(text); }, select: async title => { asked.push(title.split('\n')[0]); return picks.shift(); } }, 'busy')).session;
    const switchBlocked = async () => (await window!.extensionRunner.emit({ type: 'session_before_switch', reason: 'new' }))?.cancel === true;
    const forkBlocked = async () => (await window!.extensionRunner.emit({ type: 'session_before_fork', entryId: 'x', position: 'at' }))?.cancel === true;
    assert.equal(await switchBlocked(), true, 'a live connected conversation keeps its window');

    await owner.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); owner.dispose(); owner = undefined;
    for (let i = 0; i < 200 && !notes.some(n => n.startsWith('Connection closed')); i++) await sleep(10);
    assert.ok(notes.some(n => n.startsWith('Connection closed')), 'the window saw the owner go');
    assert.equal(await switchBlocked(), false, '/new and /resume are no longer cancelled');
    assert.equal(await forkBlocked(), false, '/fork and /clone are no longer cancelled');
    await window.prompt('/optchat profile');
    assert.deepEqual(asked, ['busy is open in another window', 'OptChat profile'], '/optchat profile offers the profile picker');
    assert.ok(!notes.some(n => n.includes('original window')), 'no pointer to a window that is gone');
  } finally {
    for (const session of [owner, window]) if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await sleep(50);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a client that hangs up early does not crash the process holding the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  const unlock = await lockProfile(dir, 'holder');
  try {
    const path = profileSocket(dir);
    for (let round = 0; round < 20; round++) {
      await Promise.all(Array.from({ length: 50 }, () => new Promise<void>(done => {
        const client = createConnection(path);
        client.on('error', () => done());
        client.on('connect', () => { client.destroy(); done(); });
      })));
      await sleep(5);
    }
    await sleep(100);
    await assert.rejects(lockProfile(dir, 'second'), /holder/);
  } finally {
    await unlock(); rmSync(dir, { recursive: true, force: true });
  }
});

test('two Pis with different TMPDIRs still share one profile lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-')), oldTmp = process.env.TMPDIR;
  const temps = [mkdtempSync(join(tmpdir(), 'optchat-tmp-a-')), mkdtempSync(join(tmpdir(), 'optchat-tmp-b-'))];
  process.env.TMPDIR = temps[0];
  const unlock = await lockProfile(dir, 'first');
  try {
    process.env.TMPDIR = temps[1];
    await assert.rejects(lockProfile(dir, 'second'), /first/);
  } finally {
    await unlock();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    for (const path of [dir, ...temps]) rmSync(path, { recursive: true, force: true });
  }
});

test('a regular file named like the lock socket is refused, not deleted', async (t) => {
  if (isWindows) return t.skip('a Windows pipe has no filesystem entry to be confused with a file');
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  try {
    writeFileSync(profileSocket(dir), 'notes');
    await assert.rejects(lockProfile(dir, 'holder'), /is not an OptChat socket/);
    assert.equal(readFileSync(profileSocket(dir), 'utf8'), 'notes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('on Windows, another spelling of the same profile (casing or a junction) finds the same lock', async (t) => {
  if (!isWindows) return t.skip('POSIX keeps the socket file inside the profile, so every spelling already reaches it');
  const root = mkdtempSync(join(tmpdir(), 'optchat-alias-')), dir = join(root, 'Profile'), junction = join(root, 'link');
  mkdirSync(dir); symlinkSync(dir, junction, 'junction');
  const unlock = await lockProfile(dir, 'holder');
  try {
    for (const alias of [dir.toUpperCase(), junction]) await assert.rejects(lockProfile(alias, 'second'), /Profile already running: holder/);
  } finally { await unlock(); rmSync(root, { recursive: true, force: true }); }
});

test('a socket path over the system limit names OPTCHAT_HOME and its length without binding a truncated socket, and one at the limit locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optchat-limit-'));
  try {
    if (isWindows) {
      // The pipe name is hashed from the profile path, so a long profile directory cannot overflow it; an over-long hand-built name is still refused before listen.
      const long = join(root, 'p'.repeat(200)); mkdirSync(long);
      const unlock = await lockProfile(long, 'holder'); await unlock();
      assert.match(profileSocket(root), /^\\\\\.\\pipe\\optchat-[0-9a-f]{16}-lock$/);
      assert.throws(() => checkSocketPath(`\\\\.\\pipe\\${'q'.repeat(251)}`), /OPTCHAT_HOME to a shorter directory/);
      return;
    }
    const fileLength = Buffer.byteLength(basename(profileSocket(root)));
    const profileOf = (socketLength: number) => { const dir = join(root, 'q'.repeat(socketLength - fileLength - 1 - root.length - 1)); mkdirSync(dir); return dir; };
    const atLimit = profileOf(SOCKET_PATH_LIMIT), overLimit = profileOf(SOCKET_PATH_LIMIT + 1), long = join(root, 'p'.repeat(200));
    mkdirSync(long);

    assert.equal(Buffer.byteLength(profileSocket(atLimit)), SOCKET_PATH_LIMIT);
    const unlock = await lockProfile(atLimit, 'holder'); await unlock();

    for (const dir of [overLimit, long]) {
      await assert.rejects(lockProfile(dir, 'holder'), /OPTCHAT_HOME to a shorter directory/);
      await assert.rejects(lockProfile(dir, 'holder'), new RegExp(`${Buffer.byteLength(profileSocket(dir))} bytes`));
      assert.deepEqual(readdirSync(dir), [], 'no truncated socket was bound');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second writer that got past the lock is refused on its next turn, with the log intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-writer-')), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    createProfile('shared');
    saveConfig(profilePath('shared'), { ...loadConfig(profilePath('shared')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const opened = await start(dir, { select: async () => 'shared' });
    session = opened.session;
    const other = new Memory(profilePath('shared'), async () => 'summary', () => {});
    other.append('user', 'written by the other process'); await other.close();

    await session.prompt('Question for the first process');
    await session.agent.waitForIdle();
    assert.match(opened.errors.join('\n'), /Another process wrote .*nothing was written/);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
  const reopened = new Memory(join(dir, 'home', 'profiles', 'shared'), async () => 'summary', () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['written by the other process']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});
