import { getMarkdownTheme, UserMessageComponent, type ExtensionAPI, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { Container, Loader, Markdown, type Component, type TUI } from '@earendil-works/pi-tui';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { connectWindow, type LiveState, type WindowEvent } from './window-bridge.ts';
import { profilePath } from './profiles.ts';
import { TranscriptView } from './agent-view.ts';
import { isReport, reportBox } from './report-message.ts';
import { statusState, windowTitle, type WindowState } from './title.ts';

/** `turn` is one finished reply of the agent with the results of its tool calls, drawn like Pi draws its own turns. */
type Details = { from?: WindowEvent['from']; turn?: AgentMessage[] };

/**
 * One transcript for the window, shared by the chat and the live widget, so tool calls keep their timings when they settle into the chat.
 * Pi's built-in tools keep their own renderers. Other tools' definitions live in the owner's process, out of reach here, so they get the
 * look Pi gives any registered tool without a renderer (`spawn tasks=[…]`) instead of the raw-JSON look of an unknown one.
 */
let transcript: TranscriptView | undefined;
const transcriptOn = (tui: TUI) => new TranscriptView(tui, process.cwd(), () => ({}));
const view = (tui: TUI) => transcript ??= transcriptOn(tui);
/** Turns drawn before this window has a live view (after /reload) still get their tool boxes; there is just no live screen to redraw. */
let detached: TranscriptView | undefined;
const NO_SCREEN = { requestRender() {} } as unknown as TUI;

/** The conversation itself renders like a normal chat; everything else keeps Pi's boxed custom-message look. */
export function registerConnectedRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<Details>('optchat-connected', (message, { expanded, outputPad }, theme) => {
    const text = typeof message.content === 'string' ? message.content : '';
    if (message.details?.from === 'user') return new UserMessageComponent(text, getMarkdownTheme(), outputPad);
    const turn = message.details?.turn;
    if (turn) {
      const shown = transcript ?? (detached ??= transcriptOn(NO_SCREEN));
      shown.setExpanded(expanded);
      const container = new Container();
      for (const part of shown.build('', turn)) container.addChild(part);
      return container;
    }
    if (message.details?.from === 'agent') return new Markdown(text.trim(), outputPad, 0, getMarkdownTheme());
    // Reports from the agent's own subagents get the same dark box as in the main window.
    return isReport(text) ? reportBox(text, outputPad, theme) : undefined;
  });
}

const toolCalls = (message: AgentMessage) => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'toolCall' ? [part.id] : []) : [];

/** What normally sits at the bottom of Pi's chat while it works: the streaming reply, running tools and the working spinner. */
class LiveTurn implements Component {
  private readonly loader: Loader;
  private readonly body = new Container();
  private spinning = false;
  turn: AgentMessage[] = [];
  live?: LiveState;
  constructor(private readonly tui: TUI, theme: Theme) {
    this.loader = new Loader(tui, text => theme.fg('accent', text), text => theme.fg('muted', text), 'Working');
    // Running tools show their elapsed time, which only moves when they are redrawn.
    this.timer = setInterval(() => { if (this.live?.tools.length) this.update(); }, 1000); this.timer.unref();
  }
  private readonly timer: ReturnType<typeof setInterval>;
  update() {
    const streaming = this.live?.streaming;
    const running = new Map((this.live?.tools ?? []).map(t => [t.id, { output: t.output, started: t.started }] as const));
    this.body.clear();
    for (const part of view(this.tui).build('', streaming ? [...this.turn, streaming] : this.turn, streaming, running)) this.body.addChild(part);
    const state = this.live?.state;
    // Waiting with no agents of its own means it is waiting for you, so nothing spins, like an idle Pi.
    const agents = this.live?.agents ?? 0;
    const spin = !!state && statusState(state, agents) === 'working';
    this.loader.setMessage(state === 'waiting' ? `Waiting for ${agents === 1 ? '1 agent' : `${agents} agents`}` : state === 'stopping' ? 'Stopping' : 'Working');
    if (spin && !this.spinning) this.loader.start(); else if (!spin && this.spinning) this.loader.stop();
    this.spinning = spin;
    this.tui.requestRender();
  }
  render(width: number) { return [...this.body.render(width), ...(this.spinning ? this.loader.render(width) : [])]; }
  invalidate() { this.body.invalidate(); this.loader.invalidate(); }
  dispose() { clearInterval(this.timer); this.loader.stop(); }
}

export async function openConnectedWindow(pi: ExtensionAPI, ctx: ExtensionContext, profile: string, setTitle: (title: string) => void = title => ctx.ui.setTitle(title)) {
  // Each window draws with its own transcript, so nothing from an earlier window carries over.
  transcript = undefined;
  let started = false, ended = false, liveTurn: LiveTurn | undefined, live: LiveState | undefined, turn: AgentMessage[] = [];
  const title = (state: WindowState) => setTitle(windowTitle(profile, state));
  const display = (text: string, details: Details = {}) => pi.sendMessage<Details>({ customType: 'optchat-connected', content: text, display: true, details }, { triggerTurn: false });
  const refresh = () => { if (liveTurn) { liveTurn.turn = turn; liveTurn.live = live; liveTurn.update(); } };
  /** A reply moves into the chat once all its tool calls have results, as Pi's own chat does when a tool finishes. */
  const commit = () => {
    if (!turn.length) return;
    const [reply] = turn;
    display(reply.role === 'assistant' ? reply.content.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n') : '', { from: 'agent', turn });
    turn = [];
  };
  const settled = () => { const done = new Set(turn.flatMap(m => m.role === 'toolResult' ? [m.toolCallId] : [])); return turn.length > 0 && toolCalls(turn[0]).every(id => done.has(id)); };
  const showLive = () => ctx.ui.setWidget('optchat-connected', (tui, theme) => { view(tui); liveTurn = new LiveTurn(tui, theme); refresh(); return liveTurn; });
  const hideLive = () => { live = undefined; liveTurn = undefined; ctx.ui.setWidget('optchat-connected', undefined); };
  const connection = await connectWindow(profilePath(profile), event => {
    if (event.name === 'started') {
      started = true; showLive(); title('working');
      ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected agent ${event.text} · /complete`);
    } else if (event.name === 'status') {
      live = event.live; refresh();
      // The tab says working exactly when the spinner spins.
      if (!ended && live) title(statusState(live.state, live.agents));
    } else if (event.message?.role === 'assistant') {
      commit(); turn = [event.message];
      if (settled()) commit();
      refresh();
    } else if (event.message?.role === 'toolResult') {
      if (turn.length) { turn.push(event.message); if (settled()) commit(); }
      refresh();
    } else {
      commit();
      display(event.text, { from: event.from });
      if (event.name === 'finished') {
        ended = true; hideLive(); title('done');
        ctx.ui.setStatus('optchat', `OptChat: ${profile} · conversation ended · /complete to exit`);
      } else refresh();
    }
  }, () => {
    if (ended) return;
    ended = true; commit(); hideLive();
    ctx.ui.setStatus('optchat', `OptChat: ${profile} · disconnected`); title('disconnected');
    ctx.ui.notify('Connection closed. The owner saves the interrupted conversation and handoff. Use /new to continue: it connects again, or opens the profile here once it is free.', 'info');
  });
  ctx.ui.setStatus('optchat', `OptChat: ${profile} · connected window · send a task to start`); title('waiting');
  display(`Connected to ${profile}'s original window. Messages here go to one subagent using the profile's subagent model. /tell-main sends a message to the main agent; /complete ends this conversation and sends a handoff. Closing this window interrupts it.`);
  return {
    /** Ended by /complete, by the owner, or by losing the owner: nothing left here to protect from a session switch. */
    get ended() { return ended; },
    async submit(text: string) {
      if (ended) throw new Error('Conversation ended. Use /new to start another.');
      await connection.request(started ? 'say' : 'start', text, ctx.cwd);
    },
    async tell(text: string) { await connection.request('tell-main', text); },
    async complete() {
      ctx.ui.setWorkingMessage('Ending conversation and preparing handoff…');
      try {
        if (started && !ended) await connection.request('complete');
        ended = true; connection.close(); ctx.shutdown();
      } finally { ctx.ui.setWorkingMessage(); }
    },
    close() { ended = true; connection.close(); },
  };
}
