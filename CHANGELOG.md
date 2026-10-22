# Changelog

All notable changes to `@justar_96/pi-telecom`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Justar96/pi-telecom/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Justar96/pi-telecom/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Justar96/pi-telecom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Justar96/pi-telecom/releases/tag/v0.1.0
