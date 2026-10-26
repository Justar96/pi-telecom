# Changelog

All notable changes to `@justar_96/pi-telecom`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `send` takes several recipients, comma-separated (`to: "alpha, bravo"`). Each gets the message
  once, sees who else got it, and is shown how to answer all of them. A name that answers to
  nobody sends nothing. The envelope field `group` is optional; older peers show a plain message.

### Changed

- `reply` with `to` answers that teammate's ask, and with none of theirs open sends the text as a
  message instead of refusing.
- Team updates no longer report `@name` locks being taken and released, nor teammates queuing for
  a lock someone else holds. Queuing for a lock this agent holds is still news.
- A declared wait that ends by itself (the waiter heard from the teammate and got to work) is told
  to the waiter, passively: who is still awaited, the task peers see, and the call to keep waiting.
- A path claim made 3 minutes or more after the task was set shows the task peers see, once per
  task, with the call to update it.
- Team updates name every checkout a teammate works in, and report a move only into a checkout
  not reported before. An agent editing notes in one checkout and code in another by turns is
  one update, not one per turn.
- A teammate's finished run no longer wakes an agent waiting for it when that run already sent the
  agent a message.
- The note that a declared wait closes a wait cycle comes once per cycle, not with every `status`.
- A leading own callsign (`bravo: …`, `bravo → echo: …`) is dropped from tasks and messages; every
  surface already names the sender.

### Fixed

- `reply` with `to` and no `askId` answered the one open ask even when it came from someone else,
  so the answer went to the wrong teammate.
- The note a claim's owner gets about an edit in another checkout named the editor's starting
  checkout and an absolute path, not the worktree the file lies in.
- A claim on a whole worktree (`/repo-b/**`) made every edit and claim in every other checkout of
  the repository "inside" it, with a merge note to both agents.

## [0.5.2] - 2026-10-25

### Added

- `send` with `interrupt: false` holds the message until the recipient's run ends, instead of
  steering it in mid-run: progress updates and FYIs stop breaking a busy agent's work. The run
  goes on with the held messages, in order, before it stops; an aborted run gets them as an idle
  agent would. An idle recipient gets it at once. The envelope field `defer` is optional; older
  peers deliver such a message as before.
- `send` and `reply` with `unblocks: true` end the recipient's declared wait on the sender at once.
  The envelope field `unblocks` is optional; older peers ignore it.
- `claim` with `pid` keeps the claims while that process runs (a background build or test run),
  and releases them, telling the owner, when it exits. A pid that isn't running makes a normal
  claim. The claim fields `pid` and `pidStart` are optional; older peers see an ordinary claim.
- The board has a "Waiting on you" section (who, for how long, on what), and a full brief names
  who waits on this agent. The record carries an optional `blockedSince`.

### Changed

- A declared wait ends by itself: once the waiter has heard from the teammate and gets to work (an
  edit, a new path claim, or a long tool call other than `telecom`). A message or answer that
  leaves the wait in place says so, with the call to end it. `status` without `waitingFor` keeps
  the wait (`[]` clears it), so restating the task no longer drops it.
- Claims don't lapse while their owner waits on a teammate who is still at work (busy, idle under
  30 minutes, or holding a process claim), up to 12 hours after the claim: waiting makes no edits
  to renew them.
- A wait cycle is told only once every agent on it has been idle for 5 minutes, and it wakes them,
  with the `unblocks: true` call that breaks it. A cycle among working agents resolves by itself.
- The task an agent sets with `status` may be up to 400 characters, and the board shows it whole.
  Briefs show the first 140 characters, and at most 6 claims per peer, each with a pointer to the
  board.
- Briefs count a teammate as near through messages only for 30 minutes after the last one.
- Recently changed files outside the repository no longer appear in briefs or on the board.
- Expiry is logged with its reason: a path claim with no edits inside it, or a lock not claimed
  again.
- The tool's guideline suggests `interrupt: false` for progress updates and FYIs; results and
  requests still go at once, since the recipient acts on them.
- README: the tips for teams of three or more are now one short note: pick a lead, have it write
  the plan, and give each teammate its part.

## [0.5.1] - 2026-10-25

### Added

- Claims can name one worktree: an absolute path into a worktree claims that copy only, shown as
  `src/** (in repo-lane)`. An agent that started in the main checkout and works in a worktree is
  given the exact call when its relative claim would hold back a teammate in another checkout, or
  when its own claim is refused because of one. The wire field `checkout` is optional; older peers
  treat such a claim as before.
- A message that started a run nobody answered (the run ended before any model reply) is sent
  again after about 1, 5 and 15 minutes, then the human is told. The record carries `unreadSince`,
  so the board shows `unread` and a `send` says the session may be stuck.
- A declared wait on a teammate that stays idle for 30 minutes, or has a message it never acted on,
  tells the waiter once, with the call to nudge it.
- The board shows how many asks an agent owes (`owes 3 asks`) and who waits on it; a `send` to an
  agent owing several says to expect a wait. The record carries an optional `asksOwed`.
- `status` tells the agent who waits on it, and says when its text was cut to one line (160
  characters).

### Changed

- A lock doesn't lapse while its holder is busy (up to 12 hours); once idle, it lapses the TTL
  after it was claimed unless claimed again.
- A teammate's new task no longer wakes agents waiting on it; finishing a run or leaving still
  does.
- A lock handed over ends the taker's declared wait on its previous holder, so the holder queueing
  behind it is no wait cycle.
- Broadcasts held for the next run are kept by telecom: ones held more than 30 minutes are cut to
  a line with a pointer to the log. Paths are compared as repository paths, so a broadcast about a
  file in one worktree reaches agents working on that file in another at once, as does one from a
  teammate messaged in the last 30 minutes.
- The worktree full-path claim is explained in full once per worktree (and again after a
  compaction); later claims carry only the call, so every claim does not repeat it.
- `e2e:cache` repeats each side 3 times (`TELECOM_CACHE_RUNS`), compares medians, and reports
  cache misses apart from the new tokens per request, the part telecom adds.
- README: tips for teams of three or more, and the claim, wait and delivery sections brought up
  to date.

### Fixed

- Claim overlap is exact for globs: `crates/program-client/**` no longer overlaps
  `crates/gateway-*/**`, and `app/lib/*.ts` no longer overlaps `app/lib/control-plane/x.ts`.
- A claim refused again after the owner narrowed its claim is no longer called a blind retry.
- An expiry notice names the claims that expired.
- `reply` with an unknown ask id says how to answer anyway.
- The heartbeat runs on its own clock: frequent record writes could postpone it indefinitely.
- A waiter that read an old release and a newer one together (a slow tick) named the old releaser
  as the one who freed the lock. Releases read in one drain are now judged together, by when each
  was sent.
- CI: the RPC check that two sessions started together get distinct callsigns waits for the
  collision to be resolved. The dev-only `undici` (through pi's packages) is overridden to a
  patched release.

## [0.5.0] - 2026-10-24

### Added

- Named locks: a claim on `@name` (`@cargo`, `@runtime`) locks a shared resource that is not a
  file. It matches no path and binds in every worktree of the repository. A refused claim names
  the holder, since when, its state, and the call to queue.
- `claim` with `queue: true` waits in line for a held lock. When the holder releases it, leaves or
  lets it expire, the first live waiter gets it and is woken. Simultaneous claims settle on the
  earlier one; the other goes back to its place at the front of the line, and is told if it was
  already told the lock was its own. A holder or a waiter whose record one read missed keeps its
  lock or its place, but never wins a race with it. Edits don't renew a lock; claiming it again
  before it expires does.
- `status` with `waitingFor` publishes whom an agent is blocked on. It is woken when one of them
  finishes a run, takes up a new task or leaves, and the wait ends when that teammate messages it.
  The board and briefs show waits, lock queues and wait cycles; each agent on a cycle is told once.
- `ask` with `wait: false` returns at once; the answer arrives later as a message that starts a
  turn. It creates no wait-for edge and never interrupts the receiver's wait. Unanswered after
  `timeoutSec` (default 30 min), the asker gets a notice that starts no turn, also when a
  `/reload` came in between.
- Team log: each session records its joins, leaves, task changes, broadcasts, claims and releases,
  and who took a lock from the line, in `log/<session>.jsonl` under the telecom root. New `telecom({ action: "log" })` (optional
  `paths` filter) and `/telecom log`. A full brief points to the log when teammates have logged.
- Live state: the board, widget and `send` results say how long a peer has been idle, or which
  long tool call it is in (`busy · bash 14m`). A message to a peer inside a long call says it
  waits for the call to end and suggests an ask with `wait: false`.
- A busy agent hears teammates join or leave mid-run as a team update that starts no turn, and its
  next brief doesn't repeat it.
- The human's notices name who joined and who left (`📡 bravo left; foxtrot joined`).

### Changed

- `release` with nothing held is a no-op instead of an error; releasing a lock you only queue for
  leaves the line.

### Fixed

- A message a peer sent before answering your ask no longer arrives after the answer. Messages
  from the peer an ask waits on are held and shown first in the ask's result; if the ask ends
  without an answer, they are delivered as usual.
- A live peer is no longer taken for dead when its `/proc/<pid>/stat` can't be read (out of file
  descriptors, a restricted `/proc`). Every session's sweep used to delete that peer's record.
- A peer whose record went missing for a moment no longer shows as leaving and rejoining, in the
  human's notices or in briefs, and no longer fails asks open to it: a departure counts after a
  second missed refresh, or at once when its process has exited or it left on purpose.
- A peer that leaves while this session is still starting up is now announced, and a lock it
  hands over names who actually freed it. A peer that renames and then leaves before the next
  team refresh is announced under its new name.

### Wire

New optional fields, ignored by older sessions: presence `stateSince`, `step`, `blockedOn` and
`queued`, and `async` on `ask` envelopes. Older sessions read `@cargo` as the path
`<checkout>/@cargo`, which matches no real file, and ignore the new `log/` directory and the
`presence/<session>.left` file a session writes when it leaves on purpose.

## [0.4.2] - 2026-10-24

### Changed

- A full team brief is no longer resent every 30 minutes: the first one and every update since
  are still in the context. It is resent only after a compaction or a callsign change.
- Team updates report a peer that moved to another worktree or branch, held for other news like a
  task change.
- An agent with no task (one put to work by a peer's message) is asked in its full brief to set
  one with `status`, so peers see more than its callsign.

### Fixed

- A presence write that fails (on Windows, a reader holding the record longer than the rename
  retries) is written again on the next tick. Before, peers saw the old record, without a new
  claim or release, until the next heartbeat 15 seconds later.
- A claim given as an absolute path into a worktree of the repository is stored as the
  repository path, so it binds in every checkout its owner works in. A path outside the
  repository is not claimed: the rest of the call is granted, and the result says how to tell
  peers instead. Before, such a claim matched nothing.
- Edits in a worktree its owner works in keep a claim alive. Before, only edits in the checkout
  where the session started did, so such a claim expired 2 hours after it was made.
- A peer's edit outside the repository no longer moves it, on the board and in briefs, back to
  the checkout it started in.
- A short question ("you tested ?") no longer replaces the task peers see; a question of 10 words
  or more still does.
- The footer is set only when its text changes. Before, every team refresh set it, and each set
  redraws the TUI.
- A claim's result in the transcript shows the paths it left out, under what it claimed: paths a
  peer holds, and paths outside the repository. Before, the panel showed only the claimed paths,
  so since 0.4.0 the human never saw that part of a claim was refused.
- The team widget names the worktree a peer works in, not the checkout it started in.
- Unanswered asks from peers are kept up to 64 at a time, and the times this agent was warned
  about a peer's claim up to 512, the oldest giving way. Before, a flood of either grew without
  bound.

## [0.4.1] - 2026-10-23

### Fixed

- A short reply to the agent ("continue", "yes B is good") no longer replaces the task peers
  see. One-word prompts never become the task, and a task set with `status` or `/telecom run`
  gives way only to a prompt of 10 words or more. Each replacement went to every teammate's
  brief as news.
- A session started in a folder before `git init` joins the repository's team once the folder
  is a checkout, so agents in worktrees created later see it as a teammate.

## [0.4.0] - 2026-10-23

### Changed

- CI checks Linux, macOS and Windows on Node 24 and 26.
- A claim with some paths held by a peer grants the free ones, names the owner in the suggested
  `ask`, and says so when an identical refused claim is retried.
- The board and briefs show a peer's worktree and branch where its recent edits landed, paths
  relative to that checkout, and a note shared by several claims once.
- A team update that would only report task changes waits up to 5 minutes for other news;
  the changes are told then, never dropped.
- A tool guideline keeps broadcasts for what every agent must act on, and the reply hint under
  peer messages is shorter.

### Fixed

- Claims, lane notes and change notices work when agents start in one checkout but edit sibling
  worktrees: checkouts are told apart by where the edited file lies. Before, such edits were
  in neither checkout and skipped.
- Windows: a presence or message write retries the rename briefly when a peer, an indexer or a
  virus scanner holds the target open (`EPERM`, `EACCES`, `EBUSY`). A single failed heartbeat no
  longer warns, and the warning no longer repeats for every temp file name.
- The scenario tests stop their sessions after each test, so sessions left over from earlier
  tests no longer slow the rest until they time out.

- Tests no longer race a slow runner: the late-answer reload test waits until the peer holds the
  ask, change-notice waits leave room for slow CI machines, and a worktree path is escaped before
  it is used in a regular expression, so Windows backslashes match literally.

## [0.3.0] - 2026-10-23

### Added

- Windows path handling for claims, drive and UNC paths, home expansion and pi's Windows shell
  path spellings. CI checks Linux, macOS and Windows on Node 22 and 24.
- `/telecom run <prompt>` starts work in every connected session in the repository, including
  the caller, subagents and sibling worktrees. Multiline prompts retain their formatting, and
  explicit human tasks bypass the automatic wake limit.
- `/telecom off` disconnects this session, releases its claims and ends its pending asks;
  `/telecom on` reconnects it. The setting survives reloads and resumes on the active session
  branch and overrides `PI_TELECOM_DISABLE`. Help remains available while disconnected.
- A cleaner terminal UI. `/telecom` opens a live board panel (Tab switches to the whole machine,
  `w` toggles the widget, Esc closes), and `/telecom help` opens a command list that runs the
  selected command. Completions describe every command and, for `/telecom msg`, every agent.
- Each agent keeps one colour across the transcript, board and widget. The `telecom` tool's calls
  and results, and peers' messages, draw as panels edged in the sender's colour, with the
  instructions meant for the model dimmed.
- The live widget lists this agent first, subagents under their parent, each agent's state, task
  and claims, and the asks waiting on this agent, and fits narrow terminals. The footer shows
  `📡 off` while telecom is disconnected.

### Fixed

- macOS and Windows use native canonical paths for existing files and checkout aliases, without
  merging distinct case or Unicode names on volumes that distinguish them. Glob characters in a
  checkout's directory name stay literal, and `..name` is correctly inside its checkout.
- Temporary file locks no longer discard messages or sweep unreadable presence records. Inbox
  cleanup failures are isolated, and atomic-write errors remain reportable even if cleanup fails.
- Windows transport roots use a per-user key, and record ids reject Windows device names and
  trailing dots.
- Test runners avoid shell globs and Windows command shims, preserve split UTF-8 pipe data,
  report early process failures, and await process shutdown before removing scratch files.
- Messages steered into a busy session no longer consume its idle wake allowance.
- A failed reply delivery keeps the ask handle available for retry. Already cancelled asks
  send no question, and disconnecting or reloading completes outstanding local waits.
- Answers and withdrawals must match the session involved in the ask. Late-answer correlation
  survives reload, and asks from departed sessions in other projects no longer leave reminders.
- An envelope in the wrong inbox is discarded before it can wake or modify that session.
- Coalesced change notices count all edits in the window and show the latest excerpt, including
  changes in sibling worktrees.
- Wait-cycle searches retain uncertainty at their depth limit and find known cycles even when
  another branch is unknown. Foreground child edges are indexed once per search.

## [0.2.0] - 2026-10-23

### Added

- **Worktrees are lanes of one team.** Agents in the main checkout and in git worktrees of the
  same repository (sharing a git common directory) now see each other, with each agent's lane on
  the board. Callsigns are unique across the repository. The edit guard still works within a
  checkout. Across lanes, an agent is told once when a peer edits a file it also changed in its own
  checkout, since the two changes meet at merge. A claim made in another worktree is advisory:
  the edit goes through with a note, the owner is told once, and overlapping claims are allowed
  with a note.
- **Subagents join as family.** pi-subagents children are recognized whether they run in the
  foreground (inside the parent's pi process, found through the session header) or in the
  background (a runner process, found through `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_PARENT_SESSION`
  and `PI_SUBAGENT_RUNNER_PID`). Processes a background subagent starts, such as a test suite
  or another `pi`, are not subagents.
  - A subagent is named after its parent (`alpha-1`), listed under it, and ignores the parent's
    inherited `PI_TELECOM_CALLSIGN`.
  - It is never held back by its parent's claims and may claim part of them. Siblings still hold
    each other back.
  - Subagents don't trigger join or leave notices. Other agents' briefs fold them into their
    parent's entry, and a parent and its own subagents get no briefs about each other.
- **Briefs scale past a handful of agents.** With more than three other agents, a brief describes
  in full only the peers near this agent's work: those that changed a file it is working with,
  hold a claim over its files or overlapping its claims, share its parent, or have messaged with
  it. The rest share one roster line, and their task changes and new claims are held back from
  later briefs (the guard still stops an edit inside their claims). Joins, departures and
  releases are always reported. A peer that comes near is described when it does, and news held
  back meanwhile is reported then.
- **Wait cycles are found, not guessed.** Each agent publishes whom its open asks wait on. An
  ask to an agent that is itself waiting now interrupts that wait only when the two waits form a
  cycle, for example A waits on B, B on C, and C asks A. Before, any ask interrupted any wait, so
  with three agents a plain queue broke up and an answer that was coming was abandoned. The
  board and `send` results show who is waiting on whom.
- **Asking by path.** `send` and `ask` take `paths` instead of `to`, and reach the agent that
  claims those paths, or else the one that changed a file there last. If that's ambiguous, or
  nobody fits, the call is refused with the choices.
- **Broadcasts that don't interrupt.** A `broadcast` with `paths` reaches agents working there
  at once. The others get it when their next run starts, not in the middle of their current one.
- An ask that would close a wait cycle at an agent inside a foreground subagent run (which can't
  read anything until that run ends) is refused at once, naming the waiting ask to answer instead.
- Presence records carry optional `repo`, `parent`, `waitingOn` and `waitingSince` fields,
  broadcasts an optional `paths` list, and `claim.contested` an optional `lane` flag. Older
  sessions ignore them, group by checkout as before, and are treated as unknown in the wait
  graph, so an ask from or through one interrupts as it always did.

### Fixed

- An ask that stopped waiting (timed out or interrupted) lost its late answer's wake-up after a
  `/reload`: the answer arrived as an ordinary reply, without starting a turn.
- When two agents asked each other at once, both waits were interrupted, and each answer came
  back later as a separate message instead of as the ask's result. Now only one side stops
  waiting, answers, and the other gets that answer as its result.
- A foreground subagent that asked its parent waited out the whole ask timeout, because the
  parent was blocked waiting for that subagent. The ask is now refused at once, with what to do
  instead, and so is an ask to any foreground ancestor further up. Peers messaging a parent that
  is waiting on a subagent are told so.
- An error inside telecom's background loop could crash the process hosting the session, which
  for a subagent is the parent's pi or the runner. The loop now catches its own errors, step by
  step, so one failing step never stops the heartbeat or ask timeouts.
- A directory inside an inbox raised an error on every tick. It is now removed like any other
  unreadable entry.
- A session that pi disposed without `session_shutdown` kept heartbeating as a live peer for as
  long as its process lived. Telecom now notices and leaves the switchboard. A subagent record
  that stays silent for 5 minutes while another session in its process keeps checking in is
  dropped. A suspended process keeps all its sessions.
- When a session ended, peers held back by its claims were never told those claims were free.
  They now get the same notice as for a release.
- A peer's checkout path reached other models without validation. Records whose `cwd` or
  `projectRoot` contain control characters are now ignored.

### Changed

- Checked against pi 1.4.0, whose extension API is unchanged from 1.3; the pi devDependency is
  now 1.4.0.

## [0.1.1] - 2026-10-21

### Fixed

- The board showed the same id for agents started within the same minute (pi's session ids are
  UUIDv7, whose first characters are a timestamp). Ids now show their random tail, and `send` and
  `ask` accept that short form as well as the start of an id.
- A claim note ending in a period no longer prints as `note.. Peers …`.
- Event payloads from peers (change summaries and excerpts, claim patterns, paths, ask ids) are
  now validated, flattened to one line and capped before they reach the model, like presence
  records already were. Malformed payloads and unknown topics are ignored.
- `/telecom release` now tells the peers that were held back by the released claims, as the
  tool's `release` action already did.
- `/telecom broadcast` reports agents it could not reach.
- The `telecom` tool's `action` and `scope` parameters use `StringEnum`, as pi's examples
  require. Google's API rejects the previous union-of-literals schema.
- A telecom hook that hits an internal error no longer blocks the tool it watches. pi treats a
  throwing `tool_call` handler as a block. Every hook now catches its own errors, reports them,
  and lets the tool run.

### Added

- A real screenshot in the README, captured from two pi sessions (`npm run screenshots`).
- `npm run e2e:matrix`: the live scenario on every model in `scripts/lab-models.mjs` (Claude
  Opus 5.5 and GPT-6.1 Sol).
- In the transcript, wrapped lines in telecom messages keep their indent, and a change notice's
  diff excerpt is colored like pi's own diffs.
- Tool `annotations` (not read-only, not destructive, local only), so permission extensions
  don't ask for confirmation needlessly.
- `outputSchema` and `structuredContent` on every result, so codemode scripts get structured
  data. It isn't sent to the model, so it costs no tokens.
- Folded tool results: long results show 8 lines until expanded, and a pending `ask` shows
  "waiting for …".
- Themed footer status.
- The board lists at most 25 agents.
- `AGENTS.md` with the development guide.

### Changed

- Internal cleanup with no change to model-facing text: the static tool definition moved to
  `src/tool.ts` and change-notice text to `src/notices.ts`; each tool action is its own function;
  bounded maps share one helper; `PI_TELECOM_TICK_MS` is read in `config.ts` with the other knobs.
- UI calls are skipped in modes without a UI (`ctx.hasUI`).
- The callsign is restored from the active session branch (`getBranch()`), not from every entry.
- `@earendil-works/pi-ai` is declared as a peer dependency.
- The README is rewritten around what the agents see.

## [0.1.0] - 2026-10-21

First release.

- Callsigns and presence for every pi session in a project; team briefs, full first and then
  only what changed.
- Change notices when a peer edits a file this agent read or edited, or one inside its claim.
- An edit guard against overwriting a peer's change you haven't read, plus claims that hold
  peers back once and tell the owner.
- The `telecom` tool (`board`, `send`, `ask`, `reply`, `broadcast`, `status`, `claim`,
  `release`) and the `/telecom` command.
- Durable delivery: messages are removed from the inbox only after they're handled, and
  duplicates are handled once. `/reload` loses nothing, a session opened twice is detected, and
  presence repairs itself.
- Prompt cache unaffected: 84.4 % hit rate with and without telecom on Claude Sonnet 5.5.

[Unreleased]: https://github.com/Justar96/pi-telecom/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Justar96/pi-telecom/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Justar96/pi-telecom/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Justar96/pi-telecom/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/Justar96/pi-telecom/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Justar96/pi-telecom/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Justar96/pi-telecom/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Justar96/pi-telecom/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Justar96/pi-telecom/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Justar96/pi-telecom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Justar96/pi-telecom/releases/tag/v0.1.0
