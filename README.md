# pi-telecom

[![npm](https://img.shields.io/npm/v/@justar_96/pi-telecom)](https://www.npmjs.com/package/@justar_96/pi-telecom)
[![license](https://img.shields.io/npm/l/@justar_96/pi-telecom)](LICENSE)

A [pi](https://pi.dev) extension that turns pi sessions in the same repository into a team.

Each session gets a callsign and publishes what it is working on. Every model is told who else
is working, on what, which paths are claimed, and which files a peer just changed. Agents can
message and ask each other, and an edit that would overwrite a peer's unread change is stopped.
Git worktrees of one repository form one team, and subagents started with
[pi-subagents](https://github.com/nicobailon/pi-subagents) are grouped with their parent.

![Two pi sessions working in one repository: alpha answers bravo's question while bravo gets a change notice with alpha's diff](https://raw.githubusercontent.com/Justar96/pi-telecom/main/docs/images/team.png)

<sub>alpha (Claude Opus 5.5) made <code>login()</code> async and fixed the test that calls it.
bravo (GPT-6.1 Sol) had read that test, so it got a change notice with alpha's diff; asked to fix
the test, it asked alpha first. Captured with <code>npm run screenshots</code>.</sub>

## Quick start

```bash
pi install npm:@justar_96/pi-telecom
```

Open two or more pi sessions in the same repository. They find each other through a shared
directory on this machine: no server, port or configuration. `/telecom` shows the team and
`/telecom help` lists the commands. The footer shows the session's callsign, its peers, and any
ask waiting on it:

```
📡 bravo · 1 peer (1 busy) · 1 claim · 1 ask waiting
```

Other ways to install:

```bash
pi -e npm:@justar_96/pi-telecom                # one session, without installing
pi install -l npm:@justar_96/pi-telecom        # one project (loads once the project is trusted)
pi install npm:@justar_96/pi-telecom@0.5.2     # a pinned version
pi install git:github.com/Justar96/pi-telecom  # from GitHub
```

Requires pi 1.3+ and Node 22.6+ (or newer if your pi needs it), on Linux, macOS or Windows.

## Teams of three or more

Pick one agent as the lead and have it write the plan: who does what, in which paths. Give each
teammate its part (`/telecom run` or the lead's `send`), ideally in its own worktree. After that,
teammates talk to each other directly and report back to the lead; telecom handles claims, shared
locks, waits and change notices.

## What the model receives

At the start of a prompt, when other agents are live, it gets a team brief:

```
📡 Telecom — you are "bravo". 1 other agent is working in this project right now:
• alpha [busy] on main  id 3f2a9c1e
    task: refactor the auth module (2m ago)
    claims: src/auth/** — refactor
    recently changed: src/auth/session.ts (1m ago)
Stay out of their claimed paths, re-read files they changed before editing, and use the telecom tool to coordinate when your work overlaps theirs.
```

Later briefs list only what changed, and nothing at all when nothing did:

```
📡 Telecom — team update (you are "bravo"):
• alpha is now on: write the session migration
• alpha released src/auth/**
```

When a peer edits a file this agent is working with, it gets a change notice:

```
📡 alpha changed a file you are working with
  • src/auth/session.ts — edited, 1 edit from line 1 · you read this file earlier
      -export function login(user) {
      +export async function login(user) {
Re-read before you edit it; your earlier view is stale.
```

When it tries to overwrite a peer's change it hasn't read, the edit is refused:

```
telecom: alpha edited shared.txt 5s ago, after you last read it. Re-read shared.txt and re-apply
your change on top of theirs (prefer `edit` over a whole-file `write`). If you must coordinate,
telecom({ action: "ask", to: "alpha", message: "…" }).
```

## Features

### Presence

Each session takes the first free callsign in the repository (`alpha`, `bravo`, …), keeps it
across a resume, and can change it with `/telecom name ops`. It publishes:

- busy or idle, for how long, and which long tool call it is in (`bravo [busy · bash 14m]`);
- its task: set with `status` or `/telecom run`, else the first line of its latest prompt (a
  one-word prompt or a short question never replaces it, and a task set with `status` is
  replaced only by a prompt of 10 words or more);
- its checkout and git branch;
- its claims and locks, its place in a lock's line, and whom it waits for;
- how many asks it owes, whom its own asks wait on, and `unread` when a message it was sent
  started no model reply;
- the last 12 files it changed with pi's `edit` and `write` tools.

### Team briefs

The first brief describes every peer; later ones list only changes: joins, departures, callsign
and task changes, claims and releases, and moves to another worktree or branch. File edits are
left to change notices. A full brief is sent again only after a compaction or a callsign change.
An agent put to work by a peer's message, with no task yet, is reminded to set one.

A teammate joining or leaving mid-run is told as a short update during the run; an idle agent
hears it in its next brief, and is not woken for it. The human sees `📡 bravo left; foxtrot
joined`. A peer counts as gone when its process exits, when it leaves on purpose (`/telecom off`,
`/new`), or after its record is missing from two refreshes in a row; one missing read is not a
departure.

With more than three other agents (subagents not counted), a brief describes at most six peers
near this agent's work: they changed or claim a file it works with, overlap its claims, share its
parent, or have messaged with it in the last 30 minutes. The rest share one line:

```
Also here, not near your work so far: charlie [busy] the api layer (claims src/api); echo [busy] the build
```

A brief shows a peer's first six claims and the first 140 characters of its task; the board shows
them all. Updates leave out the task changes and new claims of peers that aren't near (the edit
guard still applies their claims). Joins, departures, callsign changes and releases of claims
the agent knows about are always listed. A peer that becomes near is described once, with what
was left out.

### Change notices

A notice comes when a peer edits a file this agent read in the last hour, edited, or claims. It
shows the first changed lines.

- A peer's edits within about a second make one notice, and a file gives one notice until it is
  read again.
- Files read before a compaction give no notices (their content left the context); the guard
  still checks them.
- A busy agent gets the notice before its next step, an idle one with its next prompt. A notice
  never starts a turn.

### The edit guard

The guard checks `edit` and `write` calls against peers' `edit` and `write` changes. Changes made
by `bash` (formatters, `sed -i`, `git checkout`) or an editor are not tracked. With no peers and
no peer history for the file, it does nothing.

| Situation | `standard` (default) | `strict` | `off` |
|---|---|---|---|
| `write` over a peer's change the agent hasn't read | blocked until it re-reads the file | blocked | allowed |
| `edit` over a peer's change the agent hasn't read | allowed, with a ⚠ note | blocked | allowed |
| `write` after an `edit` made over an unread peer change | blocked until it re-reads the file | blocked | allowed |
| editing inside a peer's claim | blocked once and the owner is told; a retry within 10 minutes goes through | blocked | allowed |
| editing inside a claim whose owner hasn't checked in for 45 s | allowed, with a ⚠ note | allowed, with a ⚠ note | allowed |
| editing this checkout's copy of a file claimed in another worktree | allowed, with a ⚠ note; the owner is told | same | allowed |
| editing a file a peer in another worktree also changed in its copy | allowed, with a ⚠ note once per peer and file | same | allowed |
| a subagent inside its parent's claim, or the other way round | allowed | allowed | allowed |

Every refusal says what happened and what to do next, with the exact `telecom` call when one
helps. A `write` blocked twice by the same unread change goes through on the third try, with a ⚠
note, so an agent is never stuck.

### Claims

```
telecom({ action: "claim", paths: ["src/auth/**"], message: "refactor" })
```

Patterns are paths or globs relative to the project (`src/auth`, `src/**/*.test.ts`,
`src/{api,db}/**`), and overlap is exact: `src/*.ts` and `src/api/x.ts` don't overlap.

A relative claim binds in every checkout its owner works in: where it started and wherever its
edits land. A full path into a worktree claims that worktree's copy only, shown as
`src/auth/** (in repo-api)`. An agent working in a worktree whose relative claim would hold back
a teammate in another checkout is given the full-path call.

A path that overlaps a peer's claim in the same checkout is refused, the rest of the call is
granted, and the result names the owner to ask. An overlap with a claim in another worktree is
allowed with a note, and a subagent may claim part of its parent's claim. Paths outside the
repository can't be claimed; the result says how to tell peers instead.

A claim ends when it is released, when its session ends, or after 2 hours with no edit inside it
(`PI_TELECOM_CLAIM_TTL_MIN`). The owner is told what expired, and peers it held back are told the
paths are free. While its owner waits on a teammate who is still at work, a claim doesn't lapse
(up to 12 hours).

A claim can be tied to a process, such as a build or test run started in the background:

```
telecom({ action: "claim", paths: ["@cargo", "target/**"], pid: 48211, message: "release build" })
```

It stays while the process runs, even with its owner idle, and is released when the process
exits; the owner is told. A pid that isn't running makes an ordinary claim.

### Locks

Shared things that aren't files are claimed by name:

```
telecom({ action: "claim", paths: ["@cargo"], message: "release build" })
```

A lock matches no file and is shared by every worktree. If it is held, the claim is refused with
the holder, since when and its state, plus the call to queue: `queue: true` waits in line. When
the lock frees (released, holder left, or expired), the first in line gets it and is woken:
`📡 @cargo is yours now (charlie released it)`. Two agents taking a free lock at once settle on
the earlier claim; the other goes back to the front of the line and is told.

A lock doesn't lapse while its holder is busy, or while the process it was claimed with runs (up
to 12 hours). Once the holder is idle, it lapses the claim TTL after it was claimed. Edits don't
renew it; claiming it again does. To claim a path that starts with `@`, write `./@…`.

### Waits

```
telecom({ action: "status", message: "waiting for the green run", waitingFor: ["charlie"] })
```

The agent is woken when charlie finishes a run or leaves. The wait is declared once and ends by
itself: when charlie sends what it needs with `unblocks: true`, or when the agent has heard from
charlie and gets to work (an edit, claiming files, a long tool call). A message that leaves the wait
in place says so, with the call to end it. If charlie stays idle for 30 minutes or doesn't act on a
message, the waiter is told once, with the call to nudge it.

charlie's own `status` result, its board and its full brief say who waits on it. A lock handed
over ends the taker's wait on its previous holder. A `status` without `waitingFor` keeps the
wait; `waitingFor: []` clears it.

The board shows locks with their lines (`@cargo — charlie (queue: echo, bravo)`), who waits for
whom, and wait cycles. A cycle among working agents usually resolves itself; once every agent on it
has been idle for 5 minutes, each is woken once with the call that breaks it.

### Team log

A short history per repository: joins and departures, task changes, broadcasts, claims, releases,
and lock handoffs. A late joiner or a compacted agent can see what was decided with
`telecom({ action: "log" })` (optionally filtered by `paths`), and a full brief points to it.
Humans use `/telecom log`. Messages, asks and answers are private and never logged. A departed
session stays in the log for 24 hours.

### Worktrees

Checkouts that share a git common directory (the main checkout and its worktrees) are one team,
with callsigns unique across them. The board shows where each session works:

```
• bravo [idle] on lane-b  in worktree /home/me/repo-lane  id 9d41c07a
```

A session's checkout is where it edits, not where it started. Each checkout has its own files, so
a peer's edit in another worktree doesn't make this agent's copy stale. Two cases are flagged
because the changes meet at the merge:

- a file both changed in their own copies: one notice to this agent, a ⚠ note on the peer's edit;
- an edit to this checkout's copy of a file claimed in another worktree: a ⚠ note, and the owner
  is told (at most every 10 minutes per file).

An edit that reaches into another checkout's files (an absolute path, or a worktree nested in
the main checkout) counts as an edit there. A submodule is its own repository, and a folder
outside git its own project.

### Subagents

pi-subagents' foreground subagents (inside the parent's process, found through the session header)
and background subagents (in a runner process, found through `PI_SUBAGENT_*`) are both
recognized. Processes they start, such as a test suite or another `pi`, are not subagents.

- Subagents are named after their parent (`alpha-1`, `alpha-2`, …), ignoring an inherited
  `PI_TELECOM_CALLSIGN`, and the board shows them as `(subagent of alpha)`.
- They make no join or leave notices. Other agents see them inside their parent's entry, with
  their claims. A parent and its subagents get no briefs about each other; siblings see each other.
- A parent and its subagents don't hold each other back with claims; siblings do.
- A parent is blocked while its foreground subagent runs, so an `ask` to it (or to a blocked
  ancestor) is refused at once. The refusal suggests deciding without it, or pi-subagents'
  `contact_supervisor`.
- A subagent record that stays silent for 5 minutes, while another session in its process keeps
  checking in, is removed.

Background subagents load installed extensions, telecom included. Foreground subagents load only
the extensions their agent lists. To give every subagent telecom, add it to
`~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["~/.pi/agent/npm/node_modules/@justar_96/pi-telecom/src/index.ts"]
  }
}
```

or to `subagentOnlyExtensions` in one agent's definition. Each pays the tool's fixed prompt cost
(about 950 cached tokens), so read-only subagents may not need it.

## The `telecom` tool

| action | parameters | what it does |
|---|---|---|
| `board` | `scope?` | The agents in this repository: state, task, claims, recent changes, asks waiting on this agent. `scope: "machine"` lists every agent on the machine. |
| `send` | `to` or `paths`, `message`, `interrupt?`, `unblocks?` | Messages one agent; starts a turn if it is idle (within the wake limit). `interrupt: false` holds it until a busy agent's run ends. |
| `ask` | `to` or `paths`, `message`, `timeoutSec?`, `wait?` | Asks and waits for the answer (default 300 s, at most 1 h); a late answer arrives as a message. `wait: false` returns at once. |
| `reply` | `message`, `askId?`, `unblocks?` | Answers an ask; `askId` is optional when only one is waiting. |
| `broadcast` | `message`, `paths?`, `scope?` | Messages every agent in the repository. Never starts a turn. |
| `status` | `message`, `waitingFor?` | Sets the task peers see (up to 400 characters) and whom this agent waits for. |
| `claim` | `paths`, `message?`, `queue?`, `pid?` | Claims paths or globs, or takes `@name` locks; `queue: true` waits in line, `pid` holds the claims while that process runs. |
| `release` | `paths?` | Releases those claims (or all) and leaves a lock's line. Releasing nothing is fine. |
| `log` | `paths?` | The team's recent history (see [Team log](#team-log)). |

`to` is a callsign, session name or id, as the board shows it. `unblocks: true` on a `send` or
`reply` ends the recipient's declared wait on the sender (see [Waits](#waits)).

`send` and `ask` with `paths` instead of `to` go to the agent claiming them (this checkout first,
then other worktrees), else to the one that last changed a file there. With several claimants,
or none, the call is refused with the candidates and the call to use:

```
telecom({ action: "ask", paths: ["src/db/**"], message: "Is users.email unique?" })
```

A `broadcast` with `paths` reaches two groups right away: agents that read, changed or claim a
file there (in any worktree), and agents that messaged with the sender in the last 30 minutes.
The rest get it at the start of their next run, and one held over 30 minutes is cut to a line
that points to the log. A broadcast without `paths` reaches everyone right away.

### Delivery

- A `send` with `interrupt: false` reaches a busy agent when its run ends: the run goes on
  with the held messages, in the order they came, before it stops. An idle agent gets it at once.
- Messages and late answers start at most 6 turns per minute per agent (`PI_TELECOM_MAX_WAKES`);
  beyond that they arrive without starting one. Asks and `/telecom run` always start a turn, and
  messages to a busy agent don't count.
- If a message starts a run that ends without a model reply, it is sent again after about 1, 5
  and 15 minutes, then the human is told. Meanwhile teammates see `unread`, and a `send` to that
  agent warns that its session may be stuck.
- An agent about to stop with an unanswered ask is reminded once. A `send` to an agent that owes
  several asks says to expect a wait. Messages from the asked peer during an ask are shown in the
  ask's result before the answer, in order. Pressing Esc withdraws an ask, and it fails at once if
  the peer's session ends.
- With `wait: false`, the answer arrives later as a message that starts a turn. With none within
  `timeoutSec` (default 1800 s, at most 3600 s), the asker gets a notice that starts no turn, also
  across a `/reload`. Such an ask never blocks or interrupts anyone's wait.
- An ask to an agent that is itself waiting interrupts it only if it closes a cycle (alpha waits
  on bravo, bravo on charlie, charlie asks alpha); otherwise it waits its turn.
  The board shows who waits on whom: `alpha [busy, waiting on bravo (asked 40s ago)]`. An ask
  that would close a cycle through a running foreground subagent is refused, naming the ask to
  answer instead.
- A peer silent for 45 s is shown `unresponsive`: messages wait in its
  inbox, and its claims block no one.

## The `/telecom` command

```
/telecom                     the board for this repository
/telecom all                 every agent on this machine
/telecom run <prompt>        give every connected session in this repository a task, this one included
/telecom msg <agent> <text>  message an agent as its human (starts a turn if it's idle)
/telecom broadcast <text>    message every agent in this repository
/telecom off                 disconnect this session and release its claims
/telecom on                  reconnect this session
/telecom name <callsign>     rename this session
/telecom widget              show or hide a live team list above the editor
/telecom release             release every claim this session holds
/telecom log                 the team log for this repository
/telecom help                list the commands, also while telecom is off
```

In the terminal UI, `/telecom` opens a live board: Tab switches between the repository and the
machine, `w` toggles the widget, arrows scroll, Esc closes. `/telecom help` opens a command list,
and completions describe each command and list agents for `/telecom msg`. Without the terminal
UI (RPC mode), commands answer with plain text. Each agent keeps one colour across the widget,
the board and the transcript.

`/telecom run` reaches this session and every connected teammate, subagents and worktrees
included: idle sessions start a turn, busy ones get it before their next step. It reports who
received it. Sessions on an older telecom get it as a human message, under their wake limit.

`/telecom off` stops messaging and the edit guard, releases claims and ends pending asks; the
footer reads `📡 off`. The choice survives reloads and resumes, and overrides
`PI_TELECOM_DISABLE`.

## Configuration

Environment variables, read when a session starts or reconnects:

| variable | default | |
|---|---|---|
| `PI_TELECOM_GUARD` | `standard` | `strict`, `standard` or `off` (see [the edit guard](#the-edit-guard)) |
| `PI_TELECOM_CALLSIGN` | first free | a fixed callsign for this session |
| `PI_TELECOM_ASK_TIMEOUT_MS` | `300000` | default wait for `ask` (at most 1 h) |
| `PI_TELECOM_MAX_WAKES` | `6` | peer wake-ups per minute; `0` turns them off (asks and `/telecom run` still wake) |
| `PI_TELECOM_CLAIM_TTL_MIN` | `120` | minutes without an edit before a claim expires |
| `PI_TELECOM_DIR` | see [How it works](#how-it-works) | the shared directory |
| `PI_TELECOM_DISABLE` | unset | `1` starts telecom off |

## Reliability

- Telecom never changes the system prompt, the tool definitions or earlier
  messages, so the prompt cache stays valid; it only appends. The tool adds about 950 cached
  prompt tokens per session.
- A message leaves the inbox only once handled; after a crash it is delivered again
  and handled once. `/reload` keeps the record and inbox, so peers don't see the session leave,
  and keeps its callsign, claims, task and open asks.
- If one session is open in two pi processes, the younger stops using
  telecom (`📡 off (session open elsewhere)`).
- Hooks catch their own errors and let the tool run (pi would treat a throw as a
  block). Each step of the background loop is caught on its own. A disposed session's record is
  removed, and a missing record is rewritten within about a second.
- Everything a peer writes is validated, flattened to one line and capped
  before a model sees it. Messages are limited to 32 KB of text, 64 KB in all.

## How it works

- A session's checkout is the nearest folder above its working directory with a `.git`
  (or the directory itself). Checkouts sharing a git common directory are one repository, and its
  sessions one team.
- The shared directory is `$XDG_RUNTIME_DIR/pi-telecom`, else `pi-telecom-<uid>` (Unix) or
  `pi-telecom-<user hash>` (Windows) in the temporary folder. It holds a presence record, an
  inbox and a log file per session, each written to a temporary name and renamed. Unix roots must
  belong to the user with mode `0700`.
- A record lives as long as its process; on Linux the process start time must match
  too, so a reused pid isn't mistaken for a session. Subagents share their host's process and are
  also checked by heartbeat.
- Paths are compared in canonical form: `@`, `~` and file URLs expanded, symlinks and
  junctions followed, and on macOS and Windows the OS's spelling used. Windows claims accept `/` or
  `\`, drive and UNC paths.

### Limits

- Only changes made with pi's `edit` and `write` are tracked. A peer's `bash` changes give no
  notice.
- "Near" is judged from files read or changed, claims, and messages; related code in other files
  doesn't count.
- Any process of the same user can write to the inbox, the same boundary as the user's files.
  Treat a peer's message as text from another model.
- Worktrees are compared by path, not content: two worktrees changing different parts of one file
  get a note even when git would merge them cleanly.

## Contributing

See [AGENTS.md](AGENTS.md) for the setup, architecture, rules and release process; run
`npm install` and `npm run check`. CI runs the typecheck, tests and real pi RPC checks on Linux,
macOS and Windows with Node 24 and 26, using a local fixture provider (no model calls).

## Credits

The message transport and ask/reply bookkeeping are derived from
[`@tinoy/pi-ipc`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ipc) and
[`@tinoy/pi-ext-lib`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ext-lib) by
Tinoy Thomas (MIT). Telecom adds the team layer (callsigns, briefs, change notices, claims, the
edit guard), macOS support, the `reply` action, and wait-cycle detection.

## License

[MIT](LICENSE)
