![Pi-OptChat: persistent memory for Pi](https://raw.githubusercontent.com/jonaslsaa/pi-optchat/main/docs/banner.jpg)

# pi-optchat

A Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one endless chat per profile, remembered through a summary tree instead of compaction.

- **Memory**: every message is logged and summarized into a binary tree. Each turn starts from a fresh context holding a bounded memory view; the agent uses `zoom` and `date` to read originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: delegate tasks to background agents, inspect them live, and send them guidance.
- **Import**: bring in history from Claude Code (conversations and memories), Codex, Pi and [OMP](https://github.com/can1357/oh-my-pi), or ChatGPT.
- **Connected windows**: a second Pi window on the same profile becomes a subagent you talk to directly.

It runs inside ordinary Pi, with no fork or separate launcher.

## Install

```sh
pi install npm:pi-optchat
pi install npm:pi-web-access   # optional, for web search and page fetching
```

Or from GitHub: `pi install git:github.com/jonaslsaa/pi-optchat`.

Requirements: Pi 1.0.2 or compatible, Node.js 22.19+, and Git. Tested on macOS; the offline tests also run on Linux and Windows.

Web access is not bundled. Subagents load the Pi extensions you have installed (except pi-optchat itself), so installing `pi-web-access` gives web tools to the main agent and every subagent.

To uninstall, run `pi remove git:github.com/jonaslsaa/pi-optchat`. Profile data is kept.

## Quick start

1. Restart Pi.
2. Choose **+ Create profile** and name it, for example `work`.
3. Chat normally.

The footer shows the active profile. Memory follows the profile across directories and Pi sessions. New sessions show the profile picker with the last-used profile first; resumed sessions restore their profile.

For headless use (`pi -p`, `--mode rpc`, other extensions' runners), pass `--optchat-profile work`. Without it, and without a saved profile in a resumed session, a headless run is plain Pi with no OptChat memory. If the requested profile can't open (misspelled, deleted, or open in another Pi), the run reports the error and doesn't answer.

If that profile is open in another Pi, `pi -p` joins it like a connected window: a subagent in that Pi answers, only its final reply goes to stdout, and the main agent gets the handoff. `--optchat-connect auto` (default) joins only when the profile is busy, `join` always joins (and fails if no Pi has the profile open), `off` reports the busy profile as an error. A failed join exits non-zero.

## Commands

| Command | Action |
| --- | --- |
| `/optchat` | Status and actions menu. |
| `/optchat profile` | Select or create a profile. Switching starts a fresh Pi session. |
| `/optchat settings` | This profile's settings: models, subagent levels and limits, previous exchange, summary size tolerance, import summaries at once. |
| `/optchat model` | Compactor model and effort for this profile. Type to filter the models you are logged in to; the current one is marked. |
| `/optchat agents` | Live agent tree and saved run history. |
| `/optchat agents model` | Subagent model and effort for this profile, picked the same way. |
| `/optchat usage` | Token usage and cost estimates. |
| `/optchat activity` | Memory gauge: view size, summaries catching up, running agents. |
| `/optchat instructions` | Edit this profile's `AGENTS.md`. |
| `/optchat browse` | Open a readable snapshot of memory: the shape of what the model sees, summaries you can open down to the original messages, and search that shows where each message is folded. Run again to refresh. |
| `/optchat import` | Import history, or resume/discard a paused import. |
| `/complete` | In a connected window: end the conversation and hand off to the main agent. |
| `/tell-main <message>` | In a connected window: message the main agent. |

## Models

| Role | Default | Change with |
| --- | --- | --- |
| Main agent | Whatever is selected in Pi | `/model` |
| Subagents | Anthropic Opus 5.5, high | `/optchat agents model` |
| Compactor (summaries, imports, handoffs) | Anthropic Sonnet 5.5, medium | `/optchat model` |

Subagent and compactor settings are saved per profile and do not follow the main model. If you use other providers, change them before chatting. Authentication uses Pi's existing provider login.

Compression and subagents make extra model requests with your provider credentials.

## Settings

`/optchat settings` opens this profile's settings. Each row shows its value and default, the selected row says what it does and when a change applies, and a change is saved right away to the profile's `config.json`. Defaults follow Victor's recipe, except Previous exchange, Summary size tolerance and Group subagent reports, which keep OptChat's earlier behaviour.

| Setting | Default | What it does |
| --- | --- | --- |
| Compactor model | Sonnet 5.5, medium | Same as `/optchat model`. Applies to the next summary. |
| Subagent model | Opus 5.5, high | Same as `/optchat agents model`. Applies to new subagents. |
| Subagent levels | 1 | 1: only the main agent starts subagents. 2 or more: subagents may start their own, that many levels deep. Applies to subagents started or resumed after the change. |
| Max active agents | 8 | Subagents running at once in the profile, all levels together, so it also caps how deep a chain can go. |
| Group subagent reports | off | Off: each subagent reports as soon as it finishes (the recipe). On: the subagents started by one spawn report together, in one message once the last of them finishes. Applies to the next spawn. |
| Previous exchange | on | Replays your last request and answer in full with the next turn (see below). Off is the recipe. |
| Previous exchange limit | 16 KB | A larger last exchange is left out. |
| Memory search | off | Gives the agent, and subagents started or resumed after the change, a `search` tool over your original messages (see below). Off is the recipe: zoom and date only. Applies from the next turn. |
| Summary size tolerance | 640 bytes | The compactor is always asked for 512-byte lines; a longer line up to this size is kept instead of retried. 512 is the recipe's strict rule. |
| Import: summaries at once | 8 | Summaries an import builds at once, 1 to 64. With N at once, a summary can see up to N−1 lines not summarized yet before it, so higher is faster but a little less accurate (at 8 that costs about 0.8 points per summary, #108). Higher also hits your provider's rate limits harder (the compactor retries what is refused). Chat always runs 8. Applies to the next import. |

Numbers must be whole numbers of at least 1 (512 for the summary size tolerance, at most 64 for Import: summaries at once). Missing keys in an older `config.json` take their defaults.

**Upgrading from 0.6.x:** subagent levels used to be fixed at 3 and now default to 1, so subagents no longer start their own subagents until you set Subagent levels to 2 or 3.

![Settings page](docs/screenshots/settings.png)

## Subagents

Ask in plain words, for example: "Spawn an agent to investigate this repository and report back."

- Children get the profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions.
- Children also get the Pi built-in extensions the main session loaded: MCP, codemode and tool search. Your MCP servers (`~/.pi/agent/mcp.json`, the project's `.pi/mcp.json`) work in subagents, with the sign-ins you made in Pi. If MCP is off in the main session (`--no-mcp`, `-builtin:mcp` in settings, or an extension that replaces `/mcp`), it is off in subagents too. Each subagent opens its own server connections (stdio servers start once per subagent) and closes them when it ends.
- Each child reports to its parent as soon as it finishes, as one message starting `[id]`. A stopped or failed child reports its stop or error text. Turn **Group subagent reports** on to have the children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order. Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start. Messages sent with `tell_parent`, connected windows and their handoffs are never held back, and a child resumed with `tell` reports on its own. The parent stays alive to receive reports; it never polls.
- In the main chat, subagent messages and reports appear in a dark grey box labelled `↳ subagent <id> · still running` or `· report`, so they don't look like something you typed. The model still receives them as ordinary user messages; memory logs them as kind `work` (older logs hold them as `user` messages starting `[id]`). (One exception: reports recovered at startup, before your first message in the session, still show as plain user messages.)
- Every report ends with `Full chat: zoom("<id>")`, so the agent can check it against what the child actually did: `zoom` with a run ID returns that child's chat so far as `kind|text` lines (its task without the memory view, replies, tool calls, tool results cut to their first and last ~500 characters, and what it was told), in 25,000-character pages that say which `offset` to go on from. It works on running children too; a subagent can read only its own descendants' chats, as with `tell`. The report box leaves the trailer out.
- While any subagent runs, each new input to the main agent (your message, a report, a `tell_parent` message, the restart note, a connected window's message) ends with a status line, `[OptChat status] Agents at work now: 8f28e694 "Review PR #123 carefully", …` (id and the first words of each task), so it knows what is still out without asking. Lines another extension adds (below) follow it under the same label. It is rebuilt each time and never stored. It isn't repeated on the calls after a tool result within one turn, and nothing is sent while it has no line. The main prompt says what the label means, so the model doesn't take it for the user. It comes after the cached view and turn, with the turn's cache mark on the block before it, so it costs no cache.
- The parent can send a running child guidance with `tell`, and the child can message its parent mid-run with `tell_parent` (a question, an early finding). It reaches the parent like a report, marked "still running": between tool calls if the parent is busy, or waking it if it's waiting.
- `tell` to a finished child resumes it: the same agent (ID, parent, model, directory) reopens its saved transcript, gets the message as a new prompt, and sends a new report. This also works for children from earlier Pi sessions. Only the agent that started the child can resume it, and the resumed child takes one active slot. Connected windows can't be resumed, and a child whose transcript is missing must be spawned fresh.
- Another Pi extension can report into the open profile the same way, for work that runs outside Pi: it emits `{ text: '[id] body' }` on Pi's event bus, channel `optchat:report` (`pi.events.emit`). OptChat sets `taken: true` on the object once the report is journaled; while no profile is open, or an import runs, nothing takes it and the sender keeps it.
- Another extension can add a line to the status line: on channel `optchat:status` OptChat emits `{ lines: [] }` as it builds each request, and the extension pushes its line onto `lines` before its first `await`, since Pi runs each listener as an async function and reads nothing pushed later. Its tool can hand memory what it read for the agent: a result whose `details` are `{ optchat: 'work' }` (`WORK_RESULT`) is logged as `work`, its text starting `[sender] `, instead of as the tool's echo.
- By default only the main agent starts subagents. Set **Subagent levels** in `/optchat settings` to let them delegate further (3 means child, grandchild, great-grandchild).
- **Max active agents** (8 by default) caps how many agents can be active per profile, including parents waiting on descendants. Going over a limit returns an error; there is no queue.
- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode. Subagents that were working when Pi closed, crashed or `/reload`ed are resumed from their saved transcripts when the profile next opens in interactive Pi, and the main agent is told which. Headless `pi -p` doesn't resume them; they wait for the next interactive start. Ones you stopped or paused aren't resumed.

## Agents, usage and activity inspector

An **Agents | Usage | Activity** bar sits below the input.

| Key | Action |
| --- | --- |
| **Down** (empty input) | Focus the bar |
| **Left/Right**, **Enter** | Pick and open a section |
| **Escape**, **Up**, or typing | Back to the editor |
| **F6** | Open Agents directly, keeping your draft |
| **Tab** | Cycle Agents, Usage and Activity |

Set a different shortcut with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat leaves its Down key alone; use the shortcut or commands instead.

**Agents** lists runs as a tree with state, elapsed time, current tool, and last activity. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, and press **M** to pick the subagent model. Press **D** twice to delete the selected agent and the agents it started, with their transcripts. An agent that is still working is stopped first, and its stop report reaches its parent before it is deleted. The report tells the parent that you dropped the task, so it does not delegate it again. Deleting a finished agent sends no report, so memory logs `[id] deleted by the user` right away, without a model turn. The main agent can no longer resume a deleted agent. Deleting a connected window that is still open stops it like closing the window; its handoff still reaches the main agent, but the transcript the handoff points to is deleted.

**Enter** swaps the screen to that agent's conversation, drawn with Pi's own chat components, so it reads like the main chat: its task, replies, and collapsed tool calls, following live output. Typing and **Enter** send it guidance. Guidance from the main agent and reports from the agent's own agents show in labelled boxes, so only your own messages look typed. **Escape** goes back to the main chat.

| Key | Action |
| --- | --- |
| **Escape** | Clear a draft, else back to the main chat |
| **Ctrl+C** | Clear a draft, else interrupt the agent's current step. Never ends the agent: queued messages go to it at once and it carries on; with none queued it waits for you (**interrupted · waiting for you**) until your next message, or a `tell` from the main agent, resumes it |
| **Up** (empty input) | Take your newest queued message back to edit; send it again, or clear it to drop it |
| **Ctrl+X** twice | Stop this agent and the agents it started (the only key that ends it) |
| **Page Up/Down**, mouse wheel | Scroll; back at the bottom it follows again. The wheel needs Pi's default fullscreen mode |
| **Ctrl+O** | Expand tool output (Pi's own toggle) |

Guidance shows as queued until delivered, or undelivered if the child stops first. When you interrupt an agent with nothing queued, the agent that started it gets a one-line note instead of a report, so it isn't left waiting. Guidance you send is also saved in main memory. Reasoning is not shown. Transcripts stay browsable after restart, and browsing them makes no model calls.

**Usage** shows this session, last hour, today, last 7 days, or all time (**Left/Right**): one row per role and model (main agent, subagents, compactor, imports) with estimated cost, share of the total, output tokens, and how much input came from the cache. Costs are API prices, not your subscription bill.

![Usage page](docs/screenshots/usage.png)

**Activity** is a memory gauge: how many messages the profile holds and how much of the 128 KB view they fill, then either **Settled** or **Catching up · 12 of 40 summaries** with a progress bar counted from when the backlog last grew from empty. If summarizing keeps failing, the last error and the retry countdown show under it. A turn waiting for summaries shows the same error next to its spinner, usually a summarizer model you aren't logged in to (`/optchat model`). Once every summary it waits for has failed, the turn goes on, with "(not summarized yet: zoom it)" in place of the missing lines, and the failed summaries keep retrying in the background. It also counts running agents, and interrupted ones waiting for you; their list is on Agents. While summaries or agents are at work, the bar's Activity item gets a **●**.

![Activity page](docs/screenshots/activity.png)

- Costs are API-rate estimates, not your subscription bill. Unknown rates show zero.
- Record counts are not request counts; retries and tool overhead can add records.
- Main-agent tracking starts with v0.3.0 (resumed sessions are backfilled). Older records without a parent session are left out of **This session**.
- All views are limited to the active profile.

## Import history

Pick the destination profile, then run `/optchat import`.

1. **Source**: Claude Code (`~/.claude/projects`), Claude Code memories, Codex (`~/.codex/sessions`, `~/.codex/archived_sessions`), Pi / OMP (`~/.pi/agent/sessions`, `~/.omp/agent/sessions`, and each OMP profile's `~/.omp/profiles/<name>/agent/sessions`; both write the same session format), or a ChatGPT export (ZIP, folder, or `conversations.json`; a ZIP is read with `unzip` on macOS/Linux and the built-in `tar.exe` on Windows). Scanning is local and makes no model calls.
2. **Select**: for Claude Code, its memories, Codex, and Pi / OMP, pick projects (busiest first), optionally filter by start date, then take all conversations or pick some. **Tab** toggles (and **Space** when the filter is empty), **Enter** continues, type to filter, **Ctrl+A**/**Ctrl+D** select/clear matches, **Esc** cancels. Nothing is classified as work or personal for you.
3. **Mode** (only if the profile already has history):
   - **Append**: keep existing summaries and add the import. Faster and cheaper.
   - **Rebuild by conversation start date**: regenerate the whole tree, ordered by conversation start.
4. **Preview**: destination, new and duplicate counts, text size, rough token estimate, and compactor. This is not a price quote: a big import costs about 3x that estimate in compactor input, because every message is summarized and then re-read in merges, each with the memory view as (mostly cached) context.

**What gets imported**: user messages and final assistant replies, with original dates and source labels, as in Victor's recipe. Tool calls and results, intermediate commentary, reasoning, subagent transcripts, replayed context, and image/audio/file bytes are left out. So is the output Claude Code logs for slash and shell commands; the command itself stays as typed (`/name args` or `!command`). So are the context messages Codex injects, such as the AGENTS.md instructions and the environment context, and the messages OMP injects (reminders, background job notices). Pi / OMP keep `/skill:name args`, `!command` and `$code` as typed, without the skill's text or the output; `!!` and `$$` commands, kept from the model, stay out. Dropped text never becomes a conversation's title. ChatGPT alternate branches are labelled as alternatives, and so are Pi / OMP branches left by a rewind (`[alternate branch]`). Pi sessions that ran under OptChat are skipped: their messages are already in a profile's memory. A forked session adds only its new messages. Imported records are marked as historical so old requests are not treated as new instructions.

**Claude Code memories**: the auto-memory topic files in `~/.claude/projects/*/memory/` (not `MEMORY.md`, which only indexes them), picked by project. Each file becomes one dated note in the memory tree, not part of the prompt. An edited file comes in again as a newer note.

**Duplicates**: re-importing skips messages already present, even if titles or paths changed. A resumed Claude Code session copies earlier messages into its own file; those copies are matched by message id and text, so they come in once, also against messages an earlier import stored. Changed source messages can appear as a separate historical version.

**Pausing**: **Pause import** (or Escape) saves progress, and so does restarting Pi. `/optchat import` then offers **Resume** or **Discard staged import**. While an import is pending, chat in that profile is blocked; other profiles still work. Imports need the main agent and its subagents to be idle.

**Safety**: imports build a new memory generation and switch to it only when the whole tree is ready. The previous generation stays on disk. Source files are never modified.

Damaged or unsupported records are listed before you start, so you can cancel or continue without them. Conversations that disappear during the scan are skipped with a warning.

See OpenAI's guides on [exporting ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and the [conversation file format](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).

## Connected windows

Each profile is locked to one Pi process. If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent, or to go back to the profile picker.

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The window looks like a normal Pi chat: replies, tool calls with their output and running time, the working spinner, and reports from the subagent's own agents in the dark box. Ctrl+O expands tool output.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and uses one of the 8 agent slots. While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent can use `tell_parent`, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Run `/complete` when done. The window closes, remaining work stops, and the compactor writes a handoff for the main agent: decisions, changes, evidence, failures, unfinished work, and links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly, handoffs are delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user. No daemon or server.

Handoff limits: the whole transcript is summarized in one call if it fits in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If summarizing fails, a labelled fallback still reports the task, last result, and transcript locations.

## Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`):

| Path | Contents |
| --- | --- |
| `main/` | The conversation log (dated JSONL, no reasoning) |
| `tree/` | Summary nodes |
| `active-memory.json`, `memories/<id>/` | After an import: pointer to the active `main/` and `tree/`. Older generations are kept. |
| `imports/pending.json` | Resumable import state |
| `AGENTS.md` | Profile instructions |
| `config.json` | Compactor and subagent models |
| `pending-inputs.json`, `pending-reports.json` | Recovery journals |
| `runs/` | Subagent sessions and run metadata |
| `usage.jsonl` | Usage ledger |
| `memory.html` | Snapshot from `/optchat browse` |

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

To delete a profile, delete its folder. Your original Pi sessions are kept in Pi's normal session directory.

Memory reaches disk through one seam, `Store` in `src/store.ts`: the log, summary nodes, saved view and images, which is what would travel between machines. Runs, recovery journals, imports and their pointer, usage, settings and `AGENTS.md` stay local files. `FileStore` (the layout above) is the only store today; another, such as Postgres, would implement the same few operations, and its lease (take, heartbeat, release) is optional: without one, OptChat keeps its machine-local profile lock. Import records (`imports/*.json`, the staging generations and the `active-memory.json` pointer) are per machine, so a second machine with the same `~/.claude` or Codex history on disk may offer those sessions for import again.

## Windows

The same install and commands work on Windows, and the offline tests run there too. What differs:

- **Named pipes, not socket files.** The profile lock and the connected-window bridge listen on `\\.\pipe\optchat-<hash>-lock` and `optchat-<hash>-windows`, where the hash comes from the profile path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **ZIP exports** are read with Windows' own `tar.exe` (in System32 since Windows 10) instead of `unzip`; nothing is extracted to disk.
- **Home paths.** `~` in a subagent task directory is your home directory; `~\project` is read as a home path only on Windows.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
- Files are opened with `explorer.exe` instead of `open` or `xdg-open`.

## Good to know

- **Profiles separate memory and instructions only.** Agents keep full filesystem access and share provider credentials.
- **Tab title**: the terminal tab shows the profile and what it is doing: `π personal` while waiting for you, `● π personal` while the agent works, plus `· 2 agents` while subagents run. A connected window shows `↳ personal`, `● ↳ personal`, then `↳ personal · done` or `↳ personal · disconnected`. OptChat replaces Pi's default title and puts its own back when Pi resets it (new session, reload, rename).
- **Use worktrees** when parallel agents edit the same repository; they share the filesystem.
- **Instructions**: the main agent and subagents get Pi's usual global and repository `AGENTS.md` files and your skills, followed by the profile's `AGENTS.md`, which comes last and wins. OptChat replaces only Pi's opening prompt. Prompt templates work in the main session only.
- **Images** you paste, or a tool returns, are kept in the profile's memory folder under `images/` (once each, shrunk to 2,048 px on the long side and about 1.5 MB with Pi's own resizer; smaller ones stay as they are). The log names each as `[image <hash>]`, and `zoom(id, 1)` returns a message's images with its text, so the agent can look again in a later turn. Summaries stay text. Imported conversations keep a text placeholder.
- **Pi's auto-compaction is off.** A single very long run can still hit the model's context limit; stop it and continue in a new turn.
- **Restarts**: unsent inputs are recovered into memory, and pending subagent reports are delivered. Interrupted subagents are not restarted.
- **Prompt-template inputs** can be saved twice: expanded, and later in their original form as an unanswered input, because Pi expands them after the input journal records them. Skill commands (`/skill:name`) are matched back to their journaled input and don't have this problem. Plain text chat is unaffected.

## How it differs from the recipe

`src/prompts.ts` holds every prompt sent to a model (the recipe's four, the subagent instruction paragraphs, the compaction task and its retry, the handoff prompt, the import note), each with a comment on where it goes; tool descriptions stay with their tools. The recipe's prompts are lightly adapted. The main agent's turn rules are the revised recipe's (2026-10-08) word for word, without its paragraph on computers, with reports starting "[id] " instead of "[Name]", and with two added sentences: don't poll anything slow (CI, a deploy) yourself, hand the watching to a subagent, and a message starting "[OptChat status]" is OptChat's own note, not the user; the view doc keeps the original's description of the view, drops its "No message appears in full" line (untrue with Previous exchange on) and its list of when to zoom, adds one sentence on zooming out from a message to the summaries above it, and ends with the revised recipe's rule that the view is the truth and zoom the only way through it; the compactor prompt is the revised recipe's intro, view and Compactions sections, with OptChat's kinds (`talk` for replies, subagent reports as `work`) and without its turn-only sections, and with its value list reworded so the size limit is a ceiling rather than a target (bare approvals are recorded as the decision they made, lines don't narrate what wasn't seen yet, and a tool result is described by what its output shows rather than by a cause guessed from an exit code or an empty match; an A/B found less filler and no recall loss, see #129); unlike the recipe, the compactor doesn't get your instructions, since an A/B found they added nothing (#112); and the subagent prompt is the original's plus a closing note on time: report progress on long tasks with tell_parent, and say so before waiting on something slow, so the main agent can go on. OptChat keeps the recipe's numbers: 512-byte summary nodes (by default summaries up to 640 bytes are accepted without a retry, as long as they are smaller than what they replace; see Summary size tolerance), a memory view that grows a line per message and, past 128,000 bytes, merges in one batch down to 64,000 (so between batches it only grows at its end and each turn reads the last one's view from the cache; the view is saved and reloaded as it was), binary merges, 8 compression workers, fixed retry delays, 5 shortening attempts, and a 30,000-character tool output cap. Compactions get their own view, as in the 2026-10-08 revision of the recipe: the memory view merged further, to between 16,000 and 32,000 bytes with the same sawtooth, ending at the line being built. A message's summary starts once fewer than 8 lines before it are unsummarized, so up to 8 compactions run at once on one cached view. An import logs its messages the same way, waiting only while 8 messages and due merges are unbuilt, so the merges keep up. Where the recipe ends a compaction's view at the first line not summarized yet, OptChat shows that line as a placeholder and keeps the lines after it: cutting there also hid the short lines that follow, such as an echo's own tool call, and an A/B on real turns scored those summaries lower (see #101). The compactor's task and its "Too long" retry are the recipe's, verbatim, with a 512-dash ruler for the size. Anthropic requests split the view into blocks of 4 lines with cache marks on the last whole one and on the blocks 20 and 40 before it, so a turn that adds up to 240 lines of tool calls and results still reads the last view from the cache, and when that view is not cached yet, one compactor call goes first and the others wait until it starts answering, so they read the cache instead of each writing it. The marks keep the lifetime Pi asks for: with `PI_CACHE_RETENTION=long` a turn is cached for an hour, so a reply after a pause of up to an hour still reads the view from the cache; compactions and merges are always cached for 5 minutes, since their batch reads the cache within seconds. See `docs/victor-recipe.md` for notes.

Each run's context is the memory view, the previous exchange, and your new message. Deliberate additions (the ones that change the recipe's behaviour are settings, see [Settings](#settings)):

1. **Previous exchange kept verbatim.** Your last request (with any steering) and the final answer are included in full, so "why is that?" refers to what you actually read. Tool calls and reasoning are not carried over. It comes on top of the 128,000-byte view. If it is over 16,000 bytes (about 4,000 tokens, usually a big paste; Previous exchange limit) it is left out entirely, and the model relies on the view and zoom as in Victor's recipe. A new Pi session starts with the memory view only.
2. **Subagents** are built in with Pi's SDK rather than a separate package. With Subagent levels above 1 they can delegate further.
3. **Memory search** (off by default). With the setting on, the agent also gets `search(text, before?)`: plain, case-insensitive text matching over the original messages, never the summaries (a summary can be wrong, and one fact repeats at every level of the tree), skipping logged zoom and search results. It returns 20 hits at a time, newest first, each with its id, the view line that holds it when that is a summary (`1234 (in 1024+256)`), its date and a snippet; `before: id` pages back, and `zoom(id, 1)` reads a hit. One line about it is added to the system prompt, and the rule that zoom is the only way through memory names search too. Turning it on or off changes the cached prompt once.
4. **Large messages.** `zoom(id, 1)` returns a message over 25,000 characters in pages, `[showing characters 0-25000 of 92000; next page: offset 25000]`, and `offset`/`limit` read any part of one (used on a shorter message, the page adds a note that it fits in one zoom); the recipe returns it whole, where the 30,000-character tool output cap cut out its middle.
5. **Profiles**, the **inspector**, the **usage ledger**, **import**, and **connected windows** are additions. Import adds historical-record guidance to the prompts.
6. **Not done**: computer use and hosting on an always-on machine.

## Development

```sh
git clone https://github.com/jonaslsaa/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source changes. Use `OPTCHAT_HOME` to test against a throwaway data directory.

```sh
npm run check      # type check
npm test           # offline tests, no paid model calls
npm run test:live  # paid Anthropic calls on synthetic data in a disposable profile
```

### Publishing to npm

Pi's [package directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) lists npm packages with the `pi-package` keyword, which the manifest already has. GitHub alone is not enough.

Publishing a GitHub release publishes to npm. The [Publish workflow](.github/workflows/publish.yml) uses npm trusted publishing, so no token or `npm login` is involved:

1. Merge a PR that bumps `version` in `package.json`.
2. `gh release create vX.Y.Z --target main --generate-notes`

The workflow checks that the tag matches `package.json`, runs the type check and tests, and publishes with provenance. It skips versions already on npm. To retry a tag, run it by hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

## Credits and license

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). His revised gist (2026-10-08) calls his own version UniiChat. This is an independent Pi implementation, not Victor's official OptChat.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
