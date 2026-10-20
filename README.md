# pi-telecom

Run several pi agents on one project at once, and have them work as a team.

When agents work in parallel on the same project, problems show up fast: one rewrites a file
another just changed, two refactor the same module, a question gets typed into the wrong
terminal. Telecom gives every pi session in the project a callsign and a shared switchboard. Each
agent knows who else is working, on what, which areas are claimed, and which files were just
changed, and agents can message each other directly.

```
┌ terminal 1 ─ alpha ───────────────────┐   ┌ terminal 2 ─ bravo ───────────────────┐
│ > refactor the auth module            │   │ > fix the flaky upload test           │
│ telecom claim src/auth/** "refactor"  │   │                                       │
│ edit src/auth/session.ts ✓            │──▶│ 📡 alpha changed a file you are       │
│                                       │   │    working with                       │
│                                       │   │  • src/auth/session.ts — edited, 2    │
│                                       │   │    edits from line 40 · you read this │
│                                       │   │    file earlier                       │
│ 📡 Ask from bravo — they are blocked  │◀──│ telecom ask alpha "is login() async   │
│ telecom reply "yes, since 3 min ago"  │──▶│ now?"  → alpha answered: yes, …       │
└───────────────────────────────────────┘   └───────────────────────────────────────┘
```

## Install

```bash
pi install npm:@justar_96/pi-telecom
# or from GitHub:
pi install git:github.com/Justar96/pi-telecom
# or try it in one session without installing:
pi -e ./pi-telecom/src/index.ts
```

Start two or more pi sessions in the same repository and they find each other. You don't need to
configure anything, and there is no daemon or port. It runs on Linux and macOS with Node ≥ 22.6.

## What each agent gets

| | |
|---|---|
| **Callsign** | `alpha`, `bravo`, … (the first free NATO word in the project), shown in the footer: `📡 bravo · 2 peers (1 busy) · 1 claim`. It survives a resume. Change it with `/telecom name ops`. |
| **Presence** | Busy or idle, current task (the first line of the latest prompt, or one the agent sets), git branch, claims, and recently changed files. Peers read it from the board. |
| **Team brief** | When the first prompt starts with peers present, the model gets the whole team: who is working, on what, their claims, and their recent changes. After that, briefs list only what changed (who joined or left, new tasks, new or released claims); a peer editing files is not team news. If nothing changed, nothing is sent, so solo work costs no tokens. A full brief comes again after a compaction or every 30 minutes. |
| **Change notices** | When a peer edits a file this agent **read (in the last hour) or edited**, or a file inside this agent's **claim**, a notice arrives with a few changed lines. Edits that happen close together are combined into one notice, and a file triggers only one notice until the agent reads it again. Files read before a compaction don't produce notices, since their content is no longer in context. If the agent is running, the notice goes in before its next step. If it is idle, the notice waits for the next prompt. Notices never start a turn. |
| **Edit guard** | Stops an agent from overwriting a peer's work that it hasn't seen (see below). |
| **Claims** | Reserve an area (`src/auth/**`) before a large change. Peers who try to edit there are held back once, and you are told. Overlapping claims are refused. A claim ends when you release it, when your session ends, or after 2 h without activity inside it. |
| **Messaging** | `send`, `ask` (waits for the answer), `reply`, `broadcast`, from the model or from the human. |

### The edit guard

The guard acts only on changes it can **attribute to a peer**. Changes made by your own `bash`
(a formatter, `sed -i`) or by your editor are left alone, so working solo behaves exactly as it
does without telecom.

| Situation | `standard` (default) | `strict` | `off` |
|---|---|---|---|
| `write` over a peer's change you haven't read | **blocked**: re-read, then re-apply | blocked | allowed |
| `edit` over a peer's change you haven't read | allowed, with a ⚠ note in the result | blocked | allowed |
| `write` after you edited over a peer's change without reading it | **blocked**: re-read first | blocked | allowed |
| editing inside a peer's claim | blocked once, the owner is told; a deliberate retry goes through | always blocked | allowed |
| editing inside a claim whose owner is unresponsive (no check-in for 45 s) | allowed, with a ⚠ note | allowed, with a ⚠ note | allowed |

Every block explains what happened and what to do next, for example:
`telecom: bravo edited shared.txt 11s ago (1 edit from line 1), after you last read it. Re-read
shared.txt and re-apply your change on top of theirs (prefer edit over a whole-file write).`
The guard blocks the same change at most twice, so an agent can never get stuck in a loop.

### Messaging rules that prevent runaway chatter

- `send` wakes an idle peer. If the peer is busy, the message goes in before its next step.
- `broadcast` and change notices **never** wake an idle agent.
- An `ask` makes the asker wait. If the agent you asked is about to stop without replying, it is
  reminded once.
- If two agents ask each other at the same moment, both asks are interrupted instead of waiting
  forever: each side gets the other's question at once.
- If the asker presses Esc, the question is withdrawn from the other agent. If the asked agent's
  session ends, the asker's call fails right away.
- Peer messages can start at most 6 turns per minute (`PI_TELECOM_MAX_WAKES`, where `0` means
  never; asks still wake). Messages beyond that still arrive, but without starting a turn.
- A peer that hasn't checked in for 45 s (suspended or hung) is shown as `unresponsive` on the
  board. Messages to it wait in its inbox, and its claims stop blocking anyone.

## The `telecom` tool (for the model)

| action | parameters | what it does |
|---|---|---|
| `board` | `scope?` | Shows everyone in this project (or on the `machine`): task, branch, claims, recent changes, and any asks waiting on you. |
| `send` | `to`, `message` | Messages one agent. `to` is a callsign, a session name, or an id prefix of 4+ characters. |
| `ask` | `to`, `message`, `timeoutSec?` | Sends a question and waits for the answer (default 300 s). A late answer still arrives as a message. |
| `reply` | `message`, `askId?` | Answers an inbound ask. `askId` can be left out when only one ask is waiting. |
| `broadcast` | `message`, `scope?` | Tells every agent in the project. It does not wake idle agents. |
| `status` | `message` | Sets the one-line task your peers see. |
| `claim` | `paths`, `message?` | Reserves paths or globs (`src/auth`, `src/**/*.test.ts`, `src/{api,db}/**`). `message` says why. |
| `release` | `paths?` | Releases those claims, or all of them. Peers you held back are told. |

## The `/telecom` command (for you)

```
/telecom                     team board for this project
/telecom all                 every agent on this machine
/telecom msg <agent> <text>  message an agent as its human (wakes it if idle)
/telecom broadcast <text>    tell every agent in this project
/telecom name <callsign>     rename this agent
/telecom widget              toggle a live board above the editor
/telecom release             release every claim this agent holds
```

## Configuration

All configuration is through environment variables, so you can set them per terminal:

| variable | default | |
|---|---|---|
| `PI_TELECOM_GUARD` | `standard` | `strict`, `standard` or `off` (see the guard table) |
| `PI_TELECOM_CALLSIGN` | next free | a fixed callsign for this session |
| `PI_TELECOM_ASK_TIMEOUT_MS` | `300000` | default wait for `ask` (at most 1 h) |
| `PI_TELECOM_MAX_WAKES` | `6` | peer messages per minute that may start a turn (`0` = never; asks still do) |
| `PI_TELECOM_CLAIM_TTL_MIN` | `120` | a claim with no activity inside it expires after this many minutes |
| `PI_TELECOM_DIR` | see below | where the switchboard lives |
| `PI_TELECOM_DISABLE` | unset | `1` turns telecom off in this session |

## Prompt cache

Telecom never changes the system prompt or tools at runtime. Its tool and guidelines are fixed
when it loads. Everything it sends is appended to the end of the conversation: the brief after
the user prompt, notices before the agent's next step or at the end of the history. It never
rewrites a message that has already been sent. `scripts/e2e-cache.mjs` measures this with a
real model. A probe extension hashes every provider request while a peer hits the agent with a
change notice, a broadcast, a team brief, and a message steered into the middle of a run. Then
the same prompts run again without telecom. Results on Claude Sonnet 5.5:

| | requests | system / tools changed | message prefix rewritten | cache hit rate |
|---|---|---|---|---|
| with telecom | 7 | never | never (every request a pure append) | **84.4 %** |
| without telecom | 7 | never | never | **84.4 %** |

The fixed cost is about 900 prompt tokens for the tool definition and guidelines, cached after
the first request.

## Durability

- **Messages are acknowledged only after they are handled.** An inbox file is removed after
  its message reaches the session. A crash in between redelivers the message instead of losing
  it, and a duplicate delivery is recognized by id and handled once. A message that makes its
  handler throw is reported and removed, so it can't block the inbox.
- **`/reload` doesn't drop the line.** Peers keep seeing the agent during a reload, messages
  sent meanwhile wait in its inbox, and the new runtime takes over the callsign, claims, task and
  any unanswered asks. The asker can still get its answer.
- **The same session open twice** (`pi -c` in two terminals) is detected. The process that
  opened it later steps back (`📡 off (session open elsewhere)`) instead of both fighting over
  one record and one inbox.
- **Self-healing presence.** If a session's record disappears (a race with a cleanup, or a wiped
  runtime directory), the session rewrites it within a second.
- **Bounded input from peers.** A peer's record ends up in other models' context, so callsigns
  must look like callsigns, free text is flattened to one line and clipped, and lists and
  envelope sizes are capped (32 KB of text, 64 KB per envelope, 64 envelopes per drain).

## How it works

- **Same project** means the same project root: the nearest ancestor of the working directory
  that holds a `.git` entry, or the working directory itself if there is none. Each git worktree
  is its own project. To see agents in other projects, use `scope: "machine"` or `/telecom all`.
- **The switchboard** is a directory: `$XDG_RUNTIME_DIR/pi-telecom`, or
  `<tmpdir>/pi-telecom-<uid>` when that variable isn't set (macOS). It holds one presence record
  per session and one inbox per session. Every file is written to a temporary name and then
  renamed into place, so a reader never sees a half-written file. The directory must be `0700`
  and owned by you; if it isn't, telecom reports the problem and refuses to use it.
- **Liveness** is checked against the process table, not a heartbeat. On Linux the record's pid
  must still have the same start time (from `/proc/<pid>/stat`), so a reused pid counts as dead.
  Crashed sessions disappear from the board and their inboxes are removed.
- **Paths** are compared in one form: the leading `@` stripped and `~` expanded (the way pi's
  tools do it), resolved against the session's working directory, and with symlinks resolved.

### Limits

- Only file changes made through pi's `edit` and `write` tools are tracked and announced. Changes
  made by a peer's `bash` (`git checkout`, codegen) are not.
- Anything running as your user can write to your inbox. That is the same trust boundary as your
  files, but a message from a peer is still text from another model, and the model should treat
  it that way.
- Sub-agents started by pi-subagents join the team too, marked `(subagent)` on the board, as long
  as telecom is in their extension list.

## Development

```bash
npm install
npm run typecheck          # tsc, strict, erasable-syntax only
npm test                   # 36 unit and multi-session scenario tests (node:test)
npm run e2e                # real pi processes over RPC, no model calls: discovery, broadcast,
                           # rename, a real /reload, one session opened in two processes, exit
# with a real model (spends a few short turns each):
TELECOM_LIVE_MODEL=anthropic/claude-sonnet-4-5 npm run e2e:live   # notice → guard → re-read,
                           # ask → wake → reply, claim → held back → owner asked
TELECOM_LIVE_MODEL=anthropic/claude-sonnet-4-5 npm run e2e:cache  # the prompt-cache proof above
```

The live scripts load only this extension. If your model's provider is itself an extension, pass
it with `TELECOM_LIVE_EXTENSIONS=/path/to/provider/index.ts`.

| file | |
|---|---|
| `src/index.ts` | wiring: presence, the inbox loop, inbound handling, the guard hooks, the tool, the command |
| `src/transport.ts` | the switchboard: root, liveness, presence records, envelopes, delivery and drain |
| `src/awareness.ts` | what this agent has seen, what peers changed, and the guard's decisions |
| `src/ledger.ts` | asks waiting for an answer and asks owed an answer |
| `src/board.ts` | the board and the team brief |
| `src/glob.ts` | claim patterns and overlap |
| `src/project.ts` | the project root, the branch, and canonical paths |
| `src/callsign.ts` | callsign choice and collision handling |
| `src/render.ts` | how telecom messages look in the TUI |

## Credits

The session transport and ask ledger come from
[`@tinoy/pi-ipc`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ipc) and
[`@tinoy/pi-ext-lib`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ext-lib) by
Tinoy Thomas (MIT), cloned into `reference/` at `6a71be3`. Changes from the original:

- It is one standalone package with no dependency on the workspace libraries. It targets pi 1.3
  and uses only APIs that pi supplies.
- When `$XDG_RUNTIME_DIR` is missing, it falls back to a private directory under the OS temp
  directory. Liveness works without `/proc`, so it runs on macOS.
- Agents are addressed by callsign. Callsigns are kept across a resume and collisions resolve
  themselves.
- `reply` is its own action and infers the ask when only one is waiting. Before, an answer was a
  `send` with an `answerTo` handle that the model had to copy exactly.
- Simultaneous asks no longer wait forever. An ask fails right away when its peer leaves, an
  aborted ask is withdrawn, and late answers are labelled. An agent is reminded once before it
  stops with an unanswered ask, instead of a notice after every turn.
- The wake limit, passive broadcasts, and steer delivery while busy are new.
- The team layer is new: project scope, presence with tasks, briefs, change notices, claims, and
  the edit guard.
