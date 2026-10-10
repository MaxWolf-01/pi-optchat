import { chmodSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import type { Children } from './agents.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { record } from './cache.ts';
import { checkSocketPath, isWindows, profileSocket, removeStaleSocket } from './profiles.ts';
import { textContent } from './transcript.ts';
import { isActiveRun } from './runs.ts';

type Action = 'start' | 'say' | 'tell-main' | 'answer' | 'complete';
interface Request { kind: 'request'; id: number; action: Action; text?: string; cwd?: string }
interface Reply { kind: 'reply'; id: number; error?: string; text?: string }
/** A tool the subagent is running right now, with its streamed output so far. */
export interface LiveTool { id: string; name: string; args: unknown; output?: unknown; started: number }
/** What the subagent is doing between finished messages: its streaming reply and running tools. */
export interface LiveState { state: string; model: string; streaming?: AgentMessage; tools: LiveTool[]; agents?: number }
/**
 * `from` marks the conversation itself (your messages and the agent's replies); other messages have no `from`.
 * `message` carries the agent's own messages (replies with tool calls, tool results) so the window can draw them with Pi's components.
 */
export interface WindowEvent {
  kind: 'event'; name: 'started' | 'message' | 'status' | 'finished'; text: string; from?: 'user' | 'agent';
  message?: AgentMessage; live?: LiveState;
}
type Frame = Request | Reply | WindowEvent;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isMessage = (value: unknown): value is AgentMessage => record(value) && (value.role === 'assistant' || value.role === 'toolResult') && Array.isArray(value.content);
const isLive = (value: unknown): value is LiveState => record(value) && typeof value.state === 'string' && typeof value.model === 'string'
  && (value.streaming === undefined || isMessage(value.streaming))
  && Array.isArray(value.tools) && value.tools.every(t => record(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.started === 'number')
  && (value.agents === undefined || typeof value.agents === 'number');
function parse(value: unknown): Frame {
  if (!record(value)) throw new Error('Invalid window message');
  const name = value.name, action = value.action, from = value.from;
  if (value.kind === 'event' && (name === 'started' || name === 'message' || name === 'status' || name === 'finished') && typeof value.text === 'string')
    return { kind: 'event', name, text: value.text, from: from === 'user' || from === 'agent' ? from : undefined,
      message: isMessage(value.message) ? value.message : undefined, live: isLive(value.live) ? value.live : undefined };
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) throw new Error('Invalid request ID');
  if (value.kind === 'reply' && (value.error === undefined || typeof value.error === 'string') && (value.text === undefined || typeof value.text === 'string'))
    return { kind: 'reply', id: value.id, error: value.error, text: value.text };
  if (value.kind === 'request' && (action === 'start' || action === 'say' || action === 'tell-main' || action === 'answer' || action === 'complete')
    && (value.text === undefined || typeof value.text === 'string') && (value.cwd === undefined || typeof value.cwd === 'string'))
    return { kind: 'request', id: value.id, action, text: value.text, cwd: value.cwd };
  throw new Error('Invalid window message');
}
const SHORTENED = '\n[Display shortened; full text is saved in the transcript.]';
/** Stays under the 4 MB frame bound even when JSON escapes some characters. */
const ANSWER_LIMIT = 1_000_000;
const shorten = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}${SHORTENED}` : text;
/** Long text parts are cut and images dropped: the window only draws them, the owner keeps the full transcript. */
function clipContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(part => !record(part) ? part : part.type === 'text' && typeof part.text === 'string' ? { ...part, text: shorten(part.text, 50_000) }
    : part.type === 'image' ? { type: 'text', text: '[image]' } : part);
}
const clip = (message: AgentMessage) => ({ ...message, content: clipContent('content' in message ? message.content : []) }) as AgentMessage;
const clipOutput = (output: unknown) => record(output) ? { ...output, content: clipContent(output.content) } : output;
/**
 * Huge tool arguments (a large file write) would choke the socket; the window then falls back to text.
 * Partial tool output comes from any extension and may not serialize (a cycle, a BigInt); that falls back too
 * instead of throwing inside the status timer, which would take the owner's Pi down with it.
 */
const fits = (value: unknown) => { try { return JSON.stringify(value).length < 1_000_000; } catch { return false; } };

/** Local JSONL protocol, bounded before parsing. On POSIX the socket file is mode 0600, so only its OS user can connect; a Windows named pipe has no file permissions, so its hashed profile name is the only separation. */
function wire(socket: Socket, receive: (frame: Frame) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (text: string) => {
    buffer += text;
    if (buffer.length > 4_000_000) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(parse(JSON.parse(line))); } catch { socket.destroy(); return; }
    }
  });
  return (frame: Frame) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 4_000_000) { socket.destroy(); return; }
    socket.write(JSON.stringify(frame) + '\n');
  };
}

/** Call only while holding the profile lock. The owner hosts every child session. */
export async function serveWindows(directory: string, children: Children, available: () => boolean,
  report: (text: string) => Promise<void>) {
  const path = profileSocket(directory, 'windows'); checkSocketPath(path);
  removeStaleSocket(path); // A previous owner can no longer hold the profile lock.
  const connections = new Set<Socket>();
  const work = new Set<Promise<void>>();
  let closing = false;
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    connections.add(socket);
    let child: string | undefined, cursor = 0, firstUser = true, lastStatus = '', ending = false;
    const said = new Set<string>(); // Main-agent guidance and child reports reach the session as user messages too.
    const controller = new AbortController();
    let queue = Promise.resolve();
    const track = (promise: Promise<void>) => { work.add(promise); void promise.finally(() => work.delete(promise)).catch(() => {}); };
    const send = wire(socket, frame => {
      if (frame.kind !== 'request') { socket.destroy(); return; }
      queue = queue.then(async () => {
        try {
          if (socket.destroyed || ending) throw new Error('Conversation is closing');
          if (frame.action === 'start') {
            if (child) throw new Error('This window already has a conversation');
            if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
            if (!frame.text?.trim() || !frame.cwd) throw new Error('A request and working directory are required');
            [child] = await children.spawn([{ task: frame.text, cwd: frame.cwd }], frame.cwd, controller.signal, undefined, true);
            if (socket.destroyed) { await children.finish(child, closing ? 'owner-stopped' : 'disconnected'); return; }
            send({ kind: 'event', name: 'started', text: child });
          } else {
            if (!child) throw new Error('Send your first request to start a conversation');
            if (frame.action === 'answer') {
              // The agent's last reply in full, not the display copy that events carry (headless `pi -p` prints it).
              const text = children.live(child)?.session.getLastAssistantText() ?? '';
              if (text.length > ANSWER_LIMIT) throw new Error(`The reply is over ${ANSWER_LIMIT.toLocaleString('en')} characters; the original Pi window has it in full`);
              send({ kind: 'reply', id: frame.id, text }); return;
            }
            if (frame.action === 'complete') {
              const live = children.live(child);
              if (live) drainMessages(live.session.messages, live.info.task);
              ending = true;
              track(children.finish(child, 'complete').then(() => {}));
              send({ kind: 'event', name: 'finished', text: 'Conversation ended by you. The original window is stopping remaining work and preparing the handoff.' });
            } else {
              if (!frame.text?.trim()) throw new Error('Message is empty');
              if (frame.action === 'say') { said.add(frame.text.trim()); await children.tell(child, frame.text, 'user'); }
              else await report(`[${child}] User message from connected window: ${frame.text}`);
            }
          }
          send({ kind: 'reply', id: frame.id });
        } catch (error) { send({ kind: 'reply', id: frame.id, error: errorText(error) }); }
      });
      track(queue);
    });
    const drainMessages = (messages: AgentMessage[], task: string) => {
      const displayable = messages.filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
      while (cursor < displayable.length) {
        const message = displayable[cursor++];
        let text = message.role === 'toolResult' ? '' : textContent(message.content);
        if (message.role === 'user' && firstUser) { text = task; firstUser = false; said.add(task.trim()); }
        if (message.role === 'user') { if (text) send({ kind: 'event', name: 'message', from: said.has(text.trim()) ? 'user' : undefined, text: shorten(text, 200_000) }); continue; }
        const clipped = clip(message);
        if (fits(clipped)) send({ kind: 'event', name: 'message', from: message.role === 'assistant' ? 'agent' : undefined, text: shorten(text, 200_000), message: clipped });
        else if (text) send({ kind: 'event', name: 'message', from: 'agent', text: shorten(text, 200_000) });
      }
    };
    const timer = setInterval(() => {
      if (!child || socket.destroyed || ending) return;
      const live = children.live(child), info = children.history.records.get(child);
      if (!info) {
        // Deleted from the Agents page: end the window (and a headless join) instead of leaving it waiting forever.
        ending = true;
        send({ kind: 'event', name: 'finished', text: 'This conversation was deleted from the Agents page.' });
        return;
      }
      if (live) drainMessages(live.session.messages, info.task);
      const preview = live?.streaming && 'content' in live.streaming ? textContent(live.streaming.content).slice(-2000) : '';
      const text = `${info.state === 'waiting' ? 'Awaiting user or child reports' : info.state} · ${info.model}\n${live ? [...live.tools.values()].map(t => t.name).join(', ') : ''}\n${preview}`;
      let state: LiveState = { state: info.state, model: info.model,
        streaming: live?.streaming?.role === 'assistant' ? clip(live.streaming) : undefined,
        tools: live ? [...live.tools].map(([id, t]) => ({ id, name: t.name, args: t.args, output: clipOutput(t.output), started: t.started })) : [],
        // A finished child counts until its report has reached this agent, so the agent never looks idle in between.
        agents: [...children.history.records.values()].filter(run => run.parentId === child && (isActiveRun(run) || children.live(run.id))).length };
      if (!fits(state)) state = { ...state, streaming: undefined, tools: state.tools.map(t => ({ ...t, args: {}, output: undefined })) };
      const status = JSON.stringify(state);
      if (status !== lastStatus) { lastStatus = status; send({ kind: 'event', name: 'status', text, live: state }); }
      if (!live && info.handoff?.delivered) {
        try { drainMessages(children.messages(child), info.task); }
        catch (error) { send({ kind: 'event', name: 'message', text: `Could not read the final transcript: ${errorText(error)}` }); }
        ending = true;
        send({ kind: 'event', name: 'finished', text: info.handoff.text ?? 'Conversation ended.' });
      }
    }, 150);
    const { promise: ended, resolve } = Promise.withResolvers<void>();
    const connection = ended.then(async () => {
      clearInterval(timer); controller.abort(); connections.delete(socket);
      await queue;
      if (child) await children.finish(child, closing ? 'owner-stopped' : 'disconnected');
    });
    track(connection);
    socket.once('close', resolve);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  if (!isWindows) chmodSync(path, 0o600);
  return async () => {
    closing = true;
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    for (const socket of connections) socket.destroy();
    await closed;
    // A socket's close handler adds its cleanup after this point, so drain the tracked work instead of snapshotting it.
    while (work.size) await Promise.allSettled([...work]);
  };
}

export async function connectWindow(directory: string, event: (event: WindowEvent) => void, disconnected: () => void) {
  const socket = createConnection(profileSocket(directory, 'windows'));
  let next = 0;
  const pending = new Map<number, { resolve: (text?: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const send = wire(socket, frame => {
    if (frame.kind === 'event') { event(frame); return; }
    if (frame.kind !== 'reply') { socket.destroy(); return; }
    const request = pending.get(frame.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error(frame.error)); else request.resolve(frame.text);
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Connection to the original Pi window was lost')); }
    pending.clear(); disconnected();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Profile owner did not respond')));
  }).catch((error: unknown) => {
    const code = record(error) ? error.code : undefined;
    throw code === 'ENOENT' || code === 'ECONNREFUSED'
      ? new Error('No running OptChat session on this profile accepts connections. A headless run (pi -p) holding it does not accept connections; once it exits, open the profile instead.', { cause: error }) : error;
  });
  socket.setTimeout(0);
  return {
    async request(action: Action, text?: string, cwd?: string) {
      if (socket.destroyed) throw new Error('The original Pi window is disconnected');
      if (text && text.length > 256_000) throw new Error('Connected-window messages are limited to 256,000 characters');
      const id = next++;
      return await new Promise<string | undefined>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owner response timed out; closing this connection')); socket.destroy(); }, 120_000);
        pending.set(id, { resolve, reject, timer }); send({ kind: 'request', id, action, text, cwd });
      });
    },
    close() { socket.destroy(); },
  };
}

/**
 * A headless run (`pi -p`) on a profile another Pi owns: one request to a connected subagent, its final reply,
 * then `complete`, so the main agent gets the handoff. Connects up front, so a missing session fails before the prompt.
 */
export async function joinHeadless(directory: string) {
  let last: AgentMessage | undefined;
  let settle: (outcome: { ended?: string; lost?: true }) => void = () => {};
  const outcome = new Promise<{ ended?: string; lost?: true }>(resolve => { settle = resolve; });
  const connection = await connectWindow(directory, event => {
    if (event.name === 'message' && event.from === 'agent') last = event.message;
    // Waiting with no agents of its own means the agent is waiting for its user: the reply is done. A paused agent
    // waits for the owner's user instead, and a finished one ends with `finished` once its last messages are sent.
    else if (event.name === 'status' && event.live?.state === 'waiting' && !event.live.agents) settle({});
    else if (event.name === 'finished') settle({ ended: event.text });
  }, () => settle({ lost: true }));
  let asked = false;
  return {
    async ask(text: string, cwd: string) {
      if (asked) throw new Error('A headless run joins for one request');
      asked = true;
      await connection.request('start', text, cwd);
      const { ended, lost } = await outcome;
      const reply = last;
      if (reply?.role === 'assistant' && (reply.stopReason === 'error' || reply.stopReason === 'aborted')) throw new Error(reply.errorMessage ?? `Request ${reply.stopReason}`);
      if (lost) throw new Error('Connection to the original Pi window was lost');
      if (ended !== undefined) throw new Error(`The conversation ended before a reply: ${ended}`);
      // Events carry display copies cut for length, so the reply itself is fetched whole.
      const answer = await connection.request('answer') ?? '';
      await connection.request('complete');
      connection.close();
      return answer;
    },
    close() { connection.close(); },
  };
}
