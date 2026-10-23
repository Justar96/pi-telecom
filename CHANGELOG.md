# Changelog

All notable changes to `@justar_96/pi-telecom`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Justar96/pi-telecom/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/Justar96/pi-telecom/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Justar96/pi-telecom/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Justar96/pi-telecom/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Justar96/pi-telecom/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Justar96/pi-telecom/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Justar96/pi-telecom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Justar96/pi-telecom/releases/tag/v0.1.0
