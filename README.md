# pi-telecom

[![npm](https://img.shields.io/npm/v/@justar_96/pi-telecom)](https://www.npmjs.com/package/@justar_96/pi-telecom)
[![license](https://img.shields.io/npm/l/@justar_96/pi-telecom)](LICENSE)

**Run several [pi](https://pi.dev) agents on one project at once, and have them work as a team.**

When agents work in parallel on the same repository, problems show up fast. One agent rewrites
a file another just changed. Two refactor the same module. A question meant for one terminal is
typed into another. Telecom connects every pi session in a project, so each agent knows who else
is working, on what, which areas are taken, and which files just changed. Agents can also ask
each other questions directly.

![Two pi sessions working in one repository: alpha answers bravo's question while bravo gets a change notice with alpha's diff](https://raw.githubusercontent.com/Justar96/pi-telecom/main/docs/images/team.png)

<sub>A real moment from two pi sessions in one repository: alpha on Claude Opus 5.5, bravo on GPT-6.1
Sol. alpha made <code>login()</code> async and fixed the test that calls it. bravo had read that test, so it
got a change notice with alpha's diff; asked to fix the test, it asked alpha first, and alpha
answered. Captured with <code>npm run screenshots</code>.</sub>

## Quick start

```bash
pi install npm:@justar_96/pi-telecom
```

Open two or more pi sessions in the same repository. They find each other on their own: there is
nothing to configure, and no server or port. Type `/telecom` to see the team. The footer shows
who you are and who else is working:

```
📡 bravo · 1 peer (1 busy) · 1 claim
```

Other ways to install:

```bash
pi -e npm:@justar_96/pi-telecom                # try it for one session, without installing
pi install -l npm:@justar_96/pi-telecom        # for one project (loads once the project is trusted)
pi install npm:@justar_96/pi-telecom@0.1.1     # pin a version
pi install git:github.com/Justar96/pi-telecom  # from GitHub
```

Requires pi ≥ 1.3 and Node ≥ 22.6, on Linux or macOS.

## What the agents see

Telecom talks to each model in short, plain messages. These examples are real output, lightly
trimmed.

**A team brief** when a prompt starts and other agents are present. The first one describes the
whole team:

```
📡 Telecom — you are "bravo". 1 other agent is working in this project right now:
• alpha [busy] on main  id 3f2a9c1e
    task: refactor the auth module (2m ago)
    claims: src/auth/** — refactor
    recently changed: src/auth/session.ts (1m ago)
```

After that, a brief appears only when something changes, and it lists only the changes:

```
📡 Telecom — team update (you are "bravo"):
• alpha is now on: write the session migration
• alpha released src/auth/**
```

**A change notice** when a peer edits a file this agent is working with:

```
📡 alpha changed a file you are working with
  • src/auth/session.ts — edited, 2 edits from line 40 · you read this file earlier
      -export function login(user) {
      +export async function login(user) {
Re-read before you edit it; your earlier view is stale.
```

**A refusal** when an agent tries to overwrite a peer's change it hasn't seen:

```
telecom: alpha edited shared.txt 5s ago (1 edit from line 1), after you last read it. Re-read
shared.txt and re-apply your change on top of theirs (prefer `edit` over a whole-file `write`).
```

In live tests on Claude Opus 5.5 and GPT-6.1 Sol, both models re-read a file after its change
notice instead of writing over it, so both changes were kept. Asked to edit inside a peer's claim,
both contacted the owner first: one waited when told to, the other went ahead once the owner
released the claim.

## Features

### Callsigns and presence

Each agent gets a short, speakable name (`alpha`, `bravo`, … the first free word in the project).
It survives a resume, and you can change it with `/telecom name ops`. Each agent publishes its
state: busy or idle, its current task (the first line of the latest prompt, or one it sets), its
git branch, its claims, and the files it changed recently.

### Team briefs

The model is told about its teammates when a prompt starts. The first brief describes everyone.
After that, a brief lists only what changed: someone joined or left, a task changed, a claim was
added or released. A peer editing files isn't team news; change notices cover that. When nothing
changed, nothing is sent, and working alone costs no tokens at all. A full brief comes again
after a compaction, or every 30 minutes.

### Change notices

When a peer edits a file this agent **read in the last hour or edited**, or a file inside this
agent's **claim**, a notice arrives with the first few changed lines.

- Edits that land close together are combined into one notice per peer.
- A file triggers only one notice until the agent reads it again.
- Files read before a compaction don't trigger notices, since their content is no longer in
  context.
- A running agent gets the notice before its next step. An idle agent gets it with its next
  prompt. A notice never starts a turn.

### The edit guard

The guard stops an agent from overwriting work it hasn't seen. It acts only on changes it can
**attribute to a peer**. Changes from your own `bash` (formatters, `sed -i`) or from your editor
are left alone, so working solo behaves exactly as it does without telecom.

| Situation | `standard` (default) | `strict` | `off` |
|---|---|---|---|
| `write` over a peer's change you haven't read | **blocked** until you re-read | blocked | allowed |
| `edit` over a peer's change you haven't read | allowed, with a ⚠ note | blocked | allowed |
| `write` after an `edit` over a peer's change you never read | **blocked** until you re-read | blocked | allowed |
| editing inside a peer's claim | blocked once, and the owner is told; retrying goes through | always blocked | allowed |
| editing inside a claim whose owner is unresponsive | allowed, with a ⚠ note | allowed, with a ⚠ note | allowed |

Every refusal says what happened and what to do next. The same change is blocked at most twice,
so an agent can never get stuck in a loop.

### Claims

Before a large change, an agent can reserve an area: `telecom claim src/auth/** "refactor"`. When
a peer tries to edit there, the guard holds it back and tells the owner. Claims that overlap an
existing one are refused. A claim ends when it's released, when its session ends, or after 2 hours
with no activity inside it. When a claim is released, anyone who was held back is told.

### Messaging

| action | parameters | what it does |
|---|---|---|
| `board` | `scope?` | Shows who works here, on what, their claims and recent changes, and asks waiting on you. `scope: "machine"` covers every project. |
| `send` | `to`, `message` | Messages one agent by callsign, session name or id. It wakes the agent if it's idle. |
| `ask` | `to`, `message`, `timeoutSec?` | Sends a question and waits for the answer (default 300 s). A late answer still arrives as a message. |
| `reply` | `message`, `askId?` | Answers an inbound ask. `askId` can be left out when only one ask is waiting. |
| `broadcast` | `message`, `scope?` | Tells every agent in the project. It never wakes idle agents. |
| `status` | `message` | Sets the one-line task your peers see. |
| `claim` | `paths`, `message?` | Reserves paths or globs (`src/auth`, `src/**/*.test.ts`, `src/{api,db}/**`). |
| `release` | `paths?` | Releases those claims, or all of them. |

These rules keep agents from talking each other into endless loops:

- **Wake limit.** Peer messages can start at most 6 turns per minute. Messages beyond that still
  arrive, without starting a turn. Set `PI_TELECOM_MAX_WAKES=0` to never wake from a message.
- **Asks always wake.** Someone is blocked waiting for the answer. An agent about to stop with an
  unanswered ask is reminded once.
- **Simultaneous asks.** If two agents ask each other at the same moment, both waits are
  interrupted, so neither sits waiting until the timeout. Each side sees the other's question.
- **Cancelled and lost asks.** Pressing Esc on an ask withdraws it from the peer. If the peer's
  session ends, the ask fails at once.
- **Unresponsive peers.** A peer that hasn't checked in for 45 s is marked `unresponsive`.
  Messages to it wait in its inbox, and its claims stop blocking anyone.

## The `/telecom` command

```
/telecom                     the team board for this project
/telecom all                 every agent on this machine
/telecom msg <agent> <text>  message an agent as its human (wakes it if it's idle)
/telecom broadcast <text>    tell every agent in this project
/telecom name <callsign>     rename this agent
/telecom widget              show a live board above the editor
/telecom release             release every claim this agent holds
```

## Configuration

Telecom is configured with environment variables, so each terminal can have its own settings.

| variable | default | |
|---|---|---|
| `PI_TELECOM_GUARD` | `standard` | `strict`, `standard` or `off` (see [the edit guard](#the-edit-guard)) |
| `PI_TELECOM_CALLSIGN` | next free | a fixed callsign for this session |
| `PI_TELECOM_ASK_TIMEOUT_MS` | `300000` | how long `ask` waits by default (at most 1 h) |
| `PI_TELECOM_MAX_WAKES` | `6` | peer messages per minute that may start a turn; `0` means never (asks still wake) |
| `PI_TELECOM_CLAIM_TTL_MIN` | `120` | minutes without activity before a claim expires |
| `PI_TELECOM_DIR` | see [How it works](#how-it-works) | where the shared directory lives |
| `PI_TELECOM_DISABLE` | unset | `1` turns telecom off for this session |

## Guarantees

### Your prompt cache is unchanged

Telecom never changes the system prompt or tool definitions while a session runs. Everything it
sends is appended to the end of the conversation, and it never rewrites a message that has
already been sent. This was measured, not just designed: `npm run e2e:cache` records every request
the model receives while a peer sends the agent a change notice, a broadcast, a team brief, and a
message mid-run, then runs the same prompts without telecom.

| | system prompt or tools changed | earlier messages rewritten | cache hit rate* |
|---|---|---|---|
| Claude Opus 5.5, with telecom | never | never | **96.7 %** |
| Claude Opus 5.5, without | never | never | **97.1 %** |
| GPT-6.1 Sol, with telecom | never | never | **73.8 %** |
| GPT-6.1 Sol, without | never | never | **74.8 %** |

<sub>* Prompt tokens served from cache, from the second request on. The first request is warm or
cold depending on what ran before it, not on telecom. OpenAI's caching is best-effort, which
explains the lower rates with and without telecom.</sub>

The fixed cost is about 900 prompt tokens for the tool and its guidelines, cached after the
first request.

### Nothing is lost

- **At-least-once delivery.** A message is removed from the inbox only after it's handled. After a
  crash it's delivered again, and a duplicate is recognized and handled once.
- **`/reload` is invisible to peers.** Messages sent during a reload wait in the inbox. The new
  runtime keeps the callsign, claims, task and unanswered asks.
- **One session, two terminals.** If the same session is open twice (`pi -c` in two terminals),
  the second process steps back instead of both garbling one inbox. Its footer reads `📡 off`.
- **Self-repair.** If a session's record disappears, the session rewrites it within a second.

### Telecom never gets in your way

- **A telecom bug never blocks your work.** In pi, a hook that throws blocks the tool it's
  watching. Every telecom hook catches its own errors, reports them, and lets the tool run.
- **Peers can't flood the model.** A peer's callsign, name and task end up in other models'
  context, so they are validated, flattened to one line, and length-capped. Messages are capped
  at 32 KB of text and 64 KB in total.

## How it works

- **Same project** means the same project root: the nearest folder above the working directory
  that contains `.git`, or the working directory itself when there is none. Each git worktree is
  its own project. Use `scope: "machine"` or `/telecom all` to see agents in other projects.
- **Shared directory.** Sessions coordinate through a directory: `$XDG_RUNTIME_DIR/pi-telecom`, or
  `<tmpdir>/pi-telecom-<uid>` where that variable isn't set (macOS). It holds one presence record
  and one inbox per session. Every file is written under a temporary name and then renamed, so a
  reader never sees a half-written one. Telecom refuses to use the directory unless it's private
  to your user (mode `0700`).
- **Liveness** comes from the process table, not from heartbeats. On Linux a record's process must
  also still have the same start time, so a reused process id isn't mistaken for a live agent.
  Records left by crashed sessions are cleaned up.
- **Paths** are compared in one canonical form: `@` and `~` handled the way pi's tools handle
  them, resolved against the session's directory, with symlinks followed.

### Limits

- Only changes made through pi's `edit` and `write` tools are tracked. A peer's `bash` changes
  (`git checkout`, code generators) are not announced.
- Any process running as your user can write to your inbox. That's the same trust boundary as
  your files. Still, a peer's message is text from another model, and the model should treat it
  that way.
- Subagents started with pi-subagents join the team too, marked `(subagent)`, when telecom is in
  their extension list.

## Contributing

See [AGENTS.md](AGENTS.md) for the development setup, the architecture, the rules the code must
keep, and the release process. In short: `npm install && npm run check`.

## Credits

The message transport and the ask/reply bookkeeping are derived from
[`@tinoy/pi-ipc`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ipc) and
[`@tinoy/pi-ext-lib`](https://github.com/tinoy1336/pi-extensions/tree/main/packages/ext-lib) by
Tinoy Thomas (MIT). Telecom adds the team layer (projects, callsigns, briefs, change notices,
claims and the edit guard), macOS support, the separate `reply` action, and a fix for agents that
ask each other at the same moment.

## License

[MIT](LICENSE)
