# AGENTS.md — pi-telecom

A pi extension, published as `@justar_96/pi-telecom`, that connects pi sessions working in the
same project. It gives each session a callsign, presence, team briefs and change notices, and
adds an edit guard, claims, and a `telecom` tool and `/telecom` command for messaging. The
README is the user-facing description. This file is for working on the code.

## Commands

```bash
npm install            # dev tooling only — the package has no runtime dependencies
npm run typecheck      # tsc --noEmit: strict, erasable syntax only, covers src/ test/ scripts/
npm test               # node:test over test/*.test.ts and test/*.test.mjs
npm run e2e            # real `pi --mode rpc` processes, no model calls (~1 min)
npm run check          # all three; run before every commit

# one test:
node --experimental-strip-types --no-warnings --test --test-name-pattern="claims" test/team.test.ts

# with real models (spends a few short turns each):
TELECOM_LIVE_PROVIDER=<provider> npm run e2e:matrix        # the live scenario on every model in lab-models.mjs
TELECOM_LIVE_MODEL=<provider/model> npm run e2e:live       # one model; TELECOM_LIVE_ONLY=core|claims for one part
TELECOM_LIVE_MODEL=<provider/model> npm run e2e:cache      # the prompt-cache proof (TELECOM_CACHE_RUNS per side, default 3)
TELECOM_LIVE_PROVIDER=<provider> npm run screenshots       # docs/images/team.png from real pi sessions (needs tmux, Chrome)
```

`npm test` uses `scripts/test.mjs` to expand test files without a shell. CI runs `npm run check`
on Linux, macOS and Windows with Node 24 and 26. The RPC driver invokes the local pi package's JS
entry with Node (no global `pi` or `.cmd` shell shim), decodes UTF-8 across pipe reads, and exposes
`stop()`; await it before deleting a process's scratch directory.

Use native canonical paths on macOS/Windows; never globally lowercase or Unicode-normalize
filenames, since a volume may distinguish them. Glob syntax uses `/` internally, with native
Windows separators converted at the boundary. Filesystem read errors must stay distinct from
malformed JSON: locked messages and presence files are retried on later ticks, not discarded.

**Models.** Live tests, results and docs use exactly the models in `scripts/lab-models.mjs`:
Claude Opus 5.5 and GPT-6.1 Sol. Don't name other models in docs or examples. When a lab ships a
newer model, replace its entry there, re-run `e2e:matrix`, `e2e:cache` and `screenshots`, and
update the README where it names them.

**No measured numbers in the README.** Cache hit rates and live-test timings depend on the
provider, proxy and machine the tests ran on, not on telecom, so they don't belong in user-facing
docs. `e2e:cache` and `e2e:matrix` are checks that pass or fail; report their results in the
pull request or release notes, not in the README.

The scripts exit `0` on pass, `1` when a check fails, and `2` when a precondition is missing (for
example, no model configured). Never treat `2` as a pass. The live scripts load only this
extension (`--no-extensions`). If the model's provider is itself an extension, pass its entry with
`TELECOM_LIVE_EXTENSIONS=/path/to/provider/index.ts`.

Run `e2e:matrix` and `e2e:cache` before a release whenever model-facing text, the tool schema, or
message delivery changed, and `screenshots` when what the transcript shows changed.

Live checks judge outcomes, not one path: a model may re-read before writing *or* be stopped by
the guard, and may ask a claim's owner first *or* be held back. Both are correct. Only an unsafe
result fails a check, such as a stale write that landed or an uncoordinated edit inside a claim.
For the cache, compare from the second request on. The first request is warm or cold depending on
what ran before it. Providers cache best-effort, so `e2e:cache` repeats each side
(`TELECOM_CACHE_RUNS`, default 3), compares medians, and reports misses apart from the new tokens
per request that hit: that is the text telecom adds, the number its changes can move.

## Layout

| file | owns |
|---|---|
| `src/index.ts` | The entry point. The factory creates the session's `Runtime` and registers the parts below it in this table, which act on it. It starts nothing (rule 4). |
| `src/runtime.ts` | One session runtime's state (`Runtime`: the record, the transport, the ask ledger, awareness, brief state, the footer and widget) and the operations every part shares: `publish`, `readPeers`/`team`, the debounced team (`present`, `settleTeam`, `presentNow`), `envelope`/`deliverEach`/`sendEvent`, `inject` (the delivery modes; `later` held in `takeLater`/`flushLater`), wake-ups owed a model reply (`checkWakes`, `noteModelTurn`), `injectMessage`, `setState` and the step (`noteStepStart`/`noteStepEnd`/`publishStep`), `nextBrief`, the team log handle (`logEntry`/`flushLog`/`teamLog`), `report`/`step`, the hook wrapper `on` (rule 3), and the settings kept in the session (`telecom-callsign`, `telecom-enabled`). |
| `src/lifecycle.ts` | `connect` and `stop`, the loop (`tick`), the team refresh, the heartbeat, backing off when the session is open twice, the reload handoff, and the `session_*` and `model_select` hooks. |
| `src/inbound.ts` | The inbox: messages, asks, answers, broadcasts, team tasks (`runTask`), peer events, and the change-notice queue. |
| `src/guard.ts` | The `tool_call`/`tool_result` hooks: acting on `awareness` verdicts, and announcing this agent's own changes. |
| `src/turns.ts` | Around each run: `before_agent_start` (the task from the prompt, the brief, `LOG_HINT` on a full brief), the step (the tool call a run is inside: `tool_call`/`tool_result`/`tool_execution_end`, published from the tick once it runs `STEP_PUBLISH_AFTER_MS`), `agent_before_settle` (asks still owed an answer), `agent_settled`. |
| `src/actions.ts` | The `execute` half of the `telecom` tool: one function per action. |
| `src/command.ts` | `/telecom`: its subcommands, the board panel, the command list and completions. |
| `src/address.ts` | Whom a message is for (`resolveTarget`, `ownerOf`) and what its sender is told about them (`stateHint`). Pure. |
| `src/tool.ts` | The static half of the `telecom` tool: schema, description, guidelines, renderers (its own panels: `renderShell: "self"`), `ok`/`fail`. Fixed at registration (rule 1). |
| `src/notices.ts` | Change-notice text: the summary sent about an own edit, and the notice shown about a peer's. Pure. |
| `src/transport.ts` | The wire: root directory, liveness (`readStartTicks`: unreadable `/proc` is unknown, not dead), debounced departures (`settleDepartures`) and leave marks (`markLeft`), presence records, envelopes, typed event payloads (`parseEvent`), `deliver`/`drain`, reload handoff, and **all validation of peer data**. |
| `src/awareness.ts` | What this agent has seen (views), what peers changed, and the guard's verdicts (stale files, claims, lane overlaps). Pure decisions; the caller acts on them. |
| `src/family.ts` | pi-subagents children: detecting a session's parent (`detectLineage`), its lineal family (`lineOf`), and foreground children (`isForegroundChild`). |
| `src/ledger.ts` | Asks this agent is waiting on (blocking, with the messages held for them, and `wait: false` asks tracked apart), asks it owes an answer, and the wait-for graph (`closesCycle`). |
| `src/locks.ts` | Resource locks (`@name`) and declared waits as pure decisions: holders, the line (`queued`: earliest `since`, then lower id), races (`lostRaces`), declared-wait cycles, the board's lock lines. |
| `src/waiting.ts` | Acting on locks and declared waits: a freed lock goes to the first live waiter (woken), a lost race sends the loser back to its place in line (told, passively, once it believed it held the lock), declared waits wake on a finished run, a new task or a departure and end on a message or answer, cycles are told once, passively. |
| `src/log.ts` | The team log: this session's own `log/<session>.jsonl` (kept in memory, rewritten whole on the tick, bounded to `LOG_CAP`), reading and validating every entry in this repository (`parseLogEntry`; departed sessions for `LOG_RETENTION_MS`), the sweep, and the log's text (`renderLog`, `LOG_HINT`). |
| `src/board.ts` | Board text and team briefs (full, then only the changes; with many agents, only the relevant peers in full). |
| `src/glob.ts` | Claim patterns: matching and overlap, and `@name` resource names (`isResource`, `resourceKey`), which match no path. |
| `src/project.ts` | Checkout (project root), repository (`findRepo`: the git common dir), lanes (`sameRepo`, `laneName`, `laneIn`, `inCheckout`), where a file lies (`placeOf`) and where an agent works (`workingCheckout`), git branch, canonical paths. |
| `src/callsign.ts` | Callsign choice and collision handling. |
| `src/config.ts` | Every `PI_TELECOM_*` variable, read at session start (never at import). |
| `src/render.ts` | The transcript look: renderers for telecom messages, and the pieces every telecom surface shares (one colour per agent, `Panel`, board styling, dimmed model instructions). Display only; nothing here reaches the model. |
| `src/view.ts` | Human-only views: the footer text, the live widget, the `/telecom` board panel and command list (TUI components), and the command table that help and completions share. RPC clients get plain text. |
| `src/util.ts` | Small helpers (`clip`, `ago`, `fileFingerprint`, `newId`, `setBounded` for maps keyed by peer input, `pairKey`). |
| `test/harness.ts` | A fake `pi` that drives the real extension; many sessions in one process. |
| `scripts/` | e2e drivers (`rpc-driver.mjs`), the probe extension for the cache test, `lab-models.mjs` (the models live tests use), and `e2e-matrix.mjs`. |
| `scripts/screenshots/` | `capture.mjs` runs two real pi TUIs in tmux and captures both screens together, `ansi-html.mjs` converts terminal cells to HTML, and `render.mjs` screenshots it with headless Chrome. Re-render saved screens without model calls: `node scripts/screenshots/render.mjs <moment.json> <out.png>`. |
| `docs/images/` | README images. Generated by `npm run screenshots`; don't edit or retouch them by hand. |
| `reference/` | Gitignored. A clone of tinoy1336/pi-extensions at `6a71be3`, the code the transport was derived from. Recreate it with `git clone https://github.com/tinoy1336/pi-extensions.git reference/pi-extensions`. |

Runtime imports are acyclic. The parts `index` registers import `runtime` and the modules below
it, never the other way round, and know each other only as types (`lifecycle` takes an `Inbound`,
a `Guard` and a `Waiting`, `command` a `Lifecycle`; `actions` and `inbound` take a `Waiting`), except `turns → lifecycle` (`adoptRepo`). Below them:
`actions, command → address`, `actions, command → tool`, `runtime → board, view, ledger,
transport, log`, `actions, command, turns → log → glob, project, transport, callsign`, `actions,
board → locks → glob`, `waiting → locks, awareness, family, render, transport`, `address →
board`, `transport, runtime → glob`, `view → board, render`, `address, board → awareness → glob → project`, `inbound,
guard → notices`, `tool → render → callsign`, `glob, render, tool → util`, `address, board, guard
→ family → transport`, `transport → ledger → util`, and `transport → config → callsign →
project`. `callsign.ts` imports only *types* from `transport.ts` (erased at load), which is what
keeps that pair from forming a cycle. Keep it acyclic: an ESM import cycle can hand a module an
uninitialized binding. A brace import whose names are all `type` (`import { type A }`) still loads
the module; use `import type` for those.

## How it fits together

- **Team, lanes, family.** The team is every session in one repository: checkouts that share a
  git common directory (`findRepo`). Each checkout is a lane. Views, stale checks and change
  notices are per checkout (a peer in another worktree edits its own copy); claims and
  overlapping edits are compared across lanes by repository-relative path, and are advisory there.
  A file's lane is the checkout it physically lies in (`placeOf`), not the session's starting
  checkout: agents often start in the main checkout and edit worktrees of their own. A claim
  binds in every checkout its owner works in (`Awareness.checkoutsOf`: where it started, plus
  where its recent edits landed), unless it names one (`Claim.checkout`, optional on the wire: an
  absolute path into a worktree, stored relative to it); then it binds there only. `claim`
  conflicts where both claims bind in one checkout. Guessing the scope from recent edits could
  guess wrong and stop guarding work, so a relative claim is never narrowed silently: the claim
  result and a refusal give the exact absolute-path call instead (`everywhereHint`, `scopeHint`).
  `repo` is optional on the wire, so a peer without it is grouped by `projectRoot` alone
  (`sameRepo`). A pi-subagents child publishes `role: "child"` and `parent`; its lineal family
  (`lineOf`) is exempt from each other's claims, and briefs fold it into its parent.
- **Shared directory** (`transport.ts`): `presence/<session>.json` (each written only by its
  owner) and `inbox/<session>/<seq>-<id>.json`. Every write goes to a temporary name and is then
  renamed. Presence records are checked against the process table, not heartbeats, except
  that a child record that fell `CHILD_SILENT_MS` behind another record of its own process is
  gone (children share their host's pid; `hostBeats`). A suspended process falls behind as a
  whole, so its children stay. A `/proc/<pid>/stat` that can't be read for a reason other than
  the process being gone falls back to signalling the pid: reading it as death made every
  sweeper unlink a live record. A live record can still be missing for a moment (a cleaned
  runtime dir), so peers debounce departures (`settleDepartures`). A session that leaves on
  purpose writes `presence/<session>.left` before it removes its record (`markLeft`), so its
  departure counts at once even though its process lives on (`/telecom off`, `/new`, a finished
  subagent); `connect` removes the mark, and the sweep removes marks older than a minute. Older
  sessions ignore the file.
  `log/<session>.jsonl` is the team log, also written only by its owner (temp file + rename, the
  whole file, the newest `LOG_CAP` entries). Older sessions ignore the directory.
- **The loop** (`tick()` in `lifecycle.ts`, every 500 ms, `unref`'d, never throws: a throw from a
  timer would crash the host process): leave if pi disposed the runtime → drain the inbox → take
  locks released in it (`waiting.afterDrain`: the latest release per lock, by send time, names who
  freed it) → write
  our record again if its last write failed (peers still see the one before it) → publish the
  step if a tool call has run longer than `STEP_PUBLISH_AFTER_MS` → refresh the team every 2nd
  tick (repair our own record, detect the same session open twice, resolve callsign collisions,
  notice joins and leaves, debounced: a record missing from one refresh is departing and still
  present, and gone once missing a second refresh in a row, its process is dead or it left on
  purpose; the result is `rt.present`, which briefs (`presentNow`: a fresh read settled against
  it), the footer, the widget and lock lines go by, while `rt.peers` is the last raw read; tell a
  busy, already-briefed model of them as a passive brief update; then `waiting.refresh`: settle
  lock races against this refresh's read only, hand freed locks on and wake declared waits
  against the debounced team) → flush pending change notices → write our
  log file if something was logged → expire asks → re-send wake-ups no model turn answered
  (`checkWakes`) → heartbeat every 15 s (`PI_TELECOM_HEARTBEAT_MS`, on its own clock, since
  `publish` runs often; keep a busy holder's locks from lapsing, expire claims, re-read the
  branch, sweep dead records, and at most every 10 min departed sessions' log files older than
  `LOG_RETENTION_MS`). The footer is set only when
  its text changes: every `setStatus` redraws the TUI.
- **The guard's one-time parts** (a lane note, telling a lane claim's owner) are proposed by the
  verdict and committed in `tool_result` only when the call succeeded, so a call blocked by a
  later check, or one that fails, does not use them up. A claim that blocks is told at once. An
  advisory match (another lane, an unresponsive owner) never hides a binding claim later in the
  scan.
- **Envelope kinds:** `message`, `broadcast`, `ask`, `answer`, and `event`. Event topics are
  `file.changed`, `claim.contested` (with `lane: true` when the edit was in another checkout and
  nothing was held back), `claim.released` (also sent to peers queued for a released lock) and
  `ask.withdrawn`. An `ask` may carry optional `async: true` (sent with `wait: false`: the asker
  is not waiting); older peers treat it as a blocking ask.
  A human `message` may carry optional `triggerTurn: true` for an explicit `/telecom run` task.
  Older peers ignore this field and apply their usual wake limit. Draining checks the recipient;
  answers and withdrawals are matched to the session involved in the ask.
- **Delivery to the model** (`inject` modes):

  | mode | used for | when busy | when idle |
  |---|---|---|---|
  | `wake` | direct messages, late answers, answers to `wait: false` asks, a lock handed to a waiter, news of a teammate the agent declared it waits for (its run ended, it left, it stalled) | steered in | starts a turn (wake-limited) |
  | `wake-always` | asks and explicit human team tasks | steered in | starts a turn |
  | `passive` | notices, broadcasts, claim news, mid-run team updates (joins/departures), wait cycles, an expired `wait: false` ask | steered in | appended, no turn |
  | `later` | broadcasts about paths away from this agent's work | held by the runtime for the next run | held by the runtime for the next run |

  `later` messages ride with the next run's brief (`takeLater`, from `before_agent_start`): ones
  held longer than `LATER_FRESH_MS` are cut to a line. On leaving they go to pi's queue
  (`deliverAs: "nextTurn"`). A `wake` or `wake-always` that starts a run is owed a model reply
  (`message_end` from the assistant): unanswered, `checkWakes` re-sends it with `triggerTurn` at
  `WAKE_RETRY_BEATS`, publishes `unreadSince`, then tells the human once.

- **Human commands.** `/telecom run <prompt>` targets this session and its repository team.
  `/telecom off` stops the transport loop, releases claims and ends outbound waits; `/telecom on`
  reconnects. `telecom-enabled` custom entries persist the override on the active session branch.
  Tools and hooks stay registered with their static definitions, including while disconnected.
- **Asks and the wait-for graph.** A session publishes `waitingOn` (the sessions its open asks
  wait on, at most `WAITS_CAP`) before it delivers an ask and again when the wait ends. An
  inbound ask interrupts this agent's own wait only when `closesCycle` says this agent already
  waits, directly or through others, on the asker. A busy foreground subagent counts as an edge
  from its parent. New sessions always publish `waitingOn`, possibly empty. A record without it
  is an older telecom, and a list at the cap may have been cut: either way the graph is unknown
  (`null`) and the ask interrupts, as it always did. Reaching the search depth limit also leaves
  the graph unknown; a known cycle wins over an unknown branch. An asker whose record no longer waits on us
  has stopped waiting, and closes no cycle. A peer inside a foreground subagent run cannot be
  interrupted at all, so `askAction` refuses an ask that would close a cycle there, and names the
  inbound ask to answer instead.
  A message from the peer a blocking ask waits on is held with that ask (`AskLedger.hold`): the
  answer comes back as the ask's tool result, which the model reads before anything steered in,
  so a held message is shown in that result ahead of the answer. An ask that ends any other way
  hands its held messages to another ask still waiting on the same peer, or else to
  `rt.injectMessage`, in order. An ask with `wait: false` is tracked apart from waits: it is never
  in `waitingOn`, closes no cycle, is not interrupted, and its answer arrives through the
  late-answer path; when it expires or its peer leaves, the asker gets a `passive` notice. Over a
  `/reload` it is parked with its deadline (`asyncOpen`/`restoreAsync`), so the replacement
  runtime still sends that notice. A blocking ask can be open during a reload only when a host
  or extension reloads mid-run (pi's `/reload` waits for the run to end); it ends inside
  `session_shutdown`, and its held messages are delivered then, before pi invalidates the old
  runtime's API.
- **Locks and declared waits.** A claim pattern starting with `@` is a resource lock
  (`glob.ts`, `isResource`): it matches no path, overlaps only the same name (without case), and
  binds across lanes. Waiters publish `queued` (`{ pattern, since }`, a past time: a forged `0`
  or future `since` is dropped). When the lock frees (release, departure, expiry), the first
  responsive waiter claims it; simultaneous claims keep the earlier `since`, then the lower id.
  Who holds a lock and who is first in line is read from the debounced team (a departing holder
  still holds, a departing waiter keeps its place), but a race is judged only against records
  actually read: a departing record shows the claims it had before its owner released and left,
  and must never take the lock back from the waiter it went to. The loser re-queues at its old
  place (its queue `since` when it took the lock from the line); if it already believed it held
  the lock (a wake-up or its claim's result said so), it is told, passively. Claiming again
  renews a live lock and keeps its `since`; after its expiry it is a new claim. Edits never renew
  one, but the heartbeat of a busy holder keeps its locks from lapsing (`holdLocks`, up to
  `LOCK_BUSY_MAX_MS` after the claim): a lock guards a job, and the job outlasts the TTL. Taking a
  lock ends the taker's declared wait on whoever held it. A declared wait is woken when the
  teammate finishes a run or leaves (not on a new task: progress reports woke waiters for nothing),
  and once per stall when the teammate has `unreadSince` or stays idle `STALE_WAIT_BEATS`. `blockedOn` (from `status` with
  `waitingFor`) is separate from `waitingOn` and never feeds `closesCycle`. Older peers read
  `@cargo` as the path `<checkout>/@cargo`, which matches no real file.
- **Live state.** A record carries `stateSince` (when it last went idle ↔ busy) and, while busy,
  `step` (`{ tool, since }`: the oldest tool call still running, published only once it has run
  `STEP_PUBLISH_AFTER_MS`, cleared at its end). Both are optional and display-only. The board and
  widget show `busy · bash 14m` and `idle 12m`; `stateHint` names a step older than
  `LONG_STEP_MS` and points to `wait: false`. Briefs show the bare state: times are never brief
  news. `unreadSince` (a wake-up no model turn answered) and `asksOwed` are optional too: the board
  shows `unread 20m` and `owes 3 asks`, and `stateHint` says the session may be stuck, or to
  expect a wait.
- **The team log** (`log.ts`): each session logs what teammates need later: joins and leaves (not
  for subagents, and a reload is neither), task changes, broadcasts, claims, releases and
  expiries. Lock claims are logged once their races settle; a renewal is not logged; a lock
  handed on is logged by its taker (`took @cargo after alpha released it`), and a lost race by
  its loser. Direct messages, asks and answers are private and never logged.
  `telecom({ action: "log" })` and `/telecom log` show the newest `LOG_SHOWN` entries in this
  repository, oldest first. A full brief (the first, or after a compaction) ends with `LOG_HINT`
  when another session has logged.
- **Addressing by path** (`ownerOf`): `send`/`ask` with `paths` and no `to` go to the one agent
  claiming them (this checkout first, then other lanes), else the latest to change a file there.
  Several claimants, or none at all, is a refusal with the exact calls.
- **Briefs with many agents.** Up to `DESCRIBE_ALL_UP_TO` other units (a top-level agent with its
  subagents folded in), a brief describes everyone. Beyond that it describes only units that
  touch this agent's focus (`Focus`: `awareness.focusPaths()` and the sessions it messaged
  with), and the rest share a roster line. Deltas hold back a far unit's task, lane and new
  claims, but always report joins, departures, callsign changes and releases of told claims.
  `BriefState` stores what the model was TOLD, so held-back news is reported once the unit is
  near again; `holders` (current, per claim) decides which claims a departure frees.
- **Full briefs and updates.** A full brief goes out once, then again only when `fullAt` is 0
  (a compaction, a callsign change): everything told since is still in the context, so a timed
  repeat only spends tokens. An update made only of moves (a near unit's new task or lane, where
  `workplace` is the checkout of its newest in-repository edit) waits up to `TASK_ONLY_HOLD_MS`
  for other news; a unit that moves back meanwhile is no news at all.

## Rules the code must keep

Each rule has a test or an e2e check. Read the reason before bending a rule.

1. **Never break the prompt cache.** Never mutate `systemPromptOptions`, return `systemPrompt`,
   or register, re-register or re-describe tools at runtime. Tool `description`,
   `promptSnippet` and `promptGuidelines` are static strings: no callsigns, counts or anything
   else that varies. Every model-facing text is appended, via a `before_agent_start` `message`,
   `pi.sendMessage`, a `tool_result` edit of the *current* result, or `agent_before_settle`
   entries. `npm run e2e:cache` proves it; re-run it when touching any of these.
2. **Solo work costs nothing.** No brief without peers. The `tool_call` guard returns before doing
   any work when there is no teammate, no peer history for the path, and no tainted view. Extra
   tokens and latency for a lone agent are bugs.
3. **Hooks never throw.** Register hooks with `rt.on(...)` (the `Runtime`'s wrapper), never
   `pi.on(...)`. pi treats a throwing `tool_call` handler as a block, so the wrapper reports the
   error once and returns nothing: the guard **fails open**. Telecom is a teammate, not a
   security boundary.
4. **Start nothing at import or factory time.** pi loads extensions in invocations that never
   start a session, so the factory only registers things. No timers, processes, watchers or file
   I/O there: start them in `session_start` (which also re-reads the config).
   `session_shutdown` must be idempotent. Timers are `unref`'d.
5. **All state lives in the runtime the factory creates:** the `Runtime` object, and the closures
   of the parts registered with it. pi creates a new runtime on `/reload`, and the tests run many
   sessions in one process. Only id counters may live at module level.
6. **Keep the wire backward compatible.** Sessions on one machine can run *different* telecom
   versions during an upgrade. Add optional fields only, and have parsers ignore unknown fields.
   Changing the meaning of a field requires bumping `WIRE_VERSION`, and older and newer sessions
   then ignore each other's records.
7. **Peer data is untrusted model input.** Anything a peer writes (callsign, name, task, notes,
   paths, event data, log entries) passes through `parsePresence`/`parseEnvelope`/`parseEvent`
   (or `parseLogEntry` in `log.ts`, built on transport's checks), which validate
   it, flatten it to one line, and cap it. A new event topic gets a case in `parseEvent` and a
   member in `TelecomEvent`; handlers never read `envelope.data` directly. Never put raw peer text into a model message without `clip`.
8. **Information never wakes an idle agent.** Only direct messages, late answers and asks start
   turns, and `wake` respects `PI_TELECOM_MAX_WAKES`, counting only idle wake-ups. Explicit human
   tasks use `wake-always`. A new passive kind must use `passive`. A lock handed to a waiter, the
   answer to a `wait: false` ask, and news about a teammate an agent declared it waits for use
   `wake`: the agent asked for exactly that signal, like an ask's answer.
9. **Every refusal says what happened and what to do next,** including the exact
   `telecom({ ... })` call when one helps. Models follow these literally; the live tests show it.
10. **Tool schema conventions:** string enums use `StringEnum` from `@earendil-works/pi-ai`
    (Google rejects unions of literals). Every result carries `structuredContent` equal to
    `details` (`outputSchema`: `{ ok, ... }`). Keep `annotations` accurate. Keep the description
    short, since every session pays for it in tokens.

## pi API facts this code relies on (pi 1.3 and 1.4)

The extension types are identical in 1.3.0 and 1.4.0; the devDependency tracks 1.4.0.

- `pi.sendMessage(msg)` with no options **steers** the message in while the agent is streaming,
  and appends it without a turn while idle. With `{ triggerTurn: true }` it steers while
  streaming and starts a run while idle. `deliverAs: "nextTurn"` waits for the next user prompt.
- A `before_agent_start` `message` lands **after** the user prompt of that run, so it is safe for
  the cache.
- `session_shutdown.reason` is `quit`, `reload`, `new`, `resume` or `fork`. On `reload`, telecom
  keeps its presence record and inbox and parks state with `transport.writeHandoff()`. The new
  runtime takes it if it has the same pid and the handoff is less than 5 minutes old.
- Rebuild session state from `ctx.sessionManager.getBranch()`, not `getEntries()`, because
  abandoned branches aren't history.
- Call UI only through `ui()`, which returns `null` unless `ctx.hasUI`. Use `ctx.ui.theme` for
  colors, and rebuild themed strings on every refresh; never store them.
- The edit tool's `details.patch` and `details.firstChangedLine` feed change-notice excerpts.
- Session ids are UUIDv7: the first 8 characters are a timestamp that every session started in
  the same minute shares. Show ids with `shortId()` (the random tail) and match them with
  `idMatches()`; never `id.slice(0, 8)`.
- Disposing a session invalidates its extension API: every later `pi.*` call throws ("ctx is
  stale"). `tick()` probes `pi.getSessionName()` and leaves the switchboard when it throws.
- RPC mode (`pi --mode rpc`) runs extension commands with no model call. The e2e scripts drive it
  and read `extension_ui_request` records (`notify`, `setStatus`).

## pi-subagents facts this code relies on (0.80)

- A **foreground** child is an SDK session inside the parent's own pi process (same pid), while
  the parent waits in its `subagent` tool call. Nothing in the environment marks it; its session
  header's `parentSession` is the parent's session file. It loads only the extensions its agent
  lists (`extensions`, `subagentOnlyExtensions`, `subagents.defaultSubagentOnlyExtensions`).
- A **background** child runs in a detached runner process with `PI_SUBAGENT_CHILD=1`,
  `PI_SUBAGENT_PARENT_SESSION=<root parent id>` and `PI_SUBAGENT_RUNNER_PID=<runner pid>`; it
  loads the ambient extensions. One runner can host several children, so they share a pid. Every
  process the runner starts (a child's `bash`, a test suite, another `pi`) inherits all three, so
  only a process whose pid equals `PI_SUBAGENT_RUNNER_PID` hosts children.
- Children get `session_start` with reason `startup`, and `session_shutdown` with reason `quit`
  raced against a timeout before `dispose()`.
- `worktree: true` runs a child in `<dirname(repo)>/worktrees/<repo>/pi-worktree-<run>-<n>`, a
  real `git worktree add`.
- A foreground child that calls `contact_supervisor` detaches its run, so the parent can answer;
  telecom's `ask` cannot, which is why an ask to a foreground parent is refused.

The docs ship with pi: `<pi install>/node_modules/@earendil-works/pi-coding-agent/docs/`, mainly
`extensions.md`, `packages.md` and `tui.md`, plus `examples/extensions/README.md` (Key Patterns).
The exact types are in `dist/core/extensions/types.d.ts`.

## Code style

- TypeScript, `strict`, **erasable syntax only**. Sources ship raw and Node strips the types, so
  no `enum`, `namespace` or constructor parameter properties. Relative imports carry `.ts`; use
  `import type` for types.
- No runtime dependencies. Host packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`,
  `typebox`) are `peerDependencies` with `"*"`, and `devDependencies` only for typechecking.
- Tabs, double quotes, trailing commas.
- Comments explain *why*, especially for anything a reader could "simplify" into a bug. Module
  headers say what the module owns.
- Name constants by meaning (`UNRESPONSIVE_MS`, not `TIMEOUT_2`) and keep them at the top of
  their module.

## Tests

- **Unit tests** (`test/units.test.ts`): pure modules and the transport against a scratch
  directory.
- **Scenario tests** (`test/team.test.ts`): real extension instances via `test/harness.ts`.
  - Each test calls `makeProject("p-<unique>")`, so tests can't see each other.
  - `session(dir)` starts a session and registers it for cleanup. Scenario files call
    `afterEach(stopSessions)`: every live session ticks and reads every presence record, so
    sessions kept for a whole file slow later tests until they time out.
  - `eventually()` polls asynchronous delivery; never use a fixed `sleep` as the assertion.
  - The harness sets `PI_TELECOM_TICK_MS=20` and a scratch `PI_TELECOM_DIR` *before* importing
    the extension.
  - To simulate a different live process, write a presence record with `pid: process.ppid`.
  - Every harness session shares the test's pid, so `new Session(dir, { parentSession:
    a.sessionFile() })` is a foreground subagent of `a`. `session.disposed = true` simulates pi
    disposing it.
- **View tests** (`test/view.test.ts`): what the human sees. A tagged theme (`<color>text</color>`)
  shows which colour each run got, and `asTui()` gives a harness session a fake TUI (`custom`,
  `setWidget`, `setEditorText`) so the board panel and command list can be driven by keys.
- **Coverage:** a new behavior needs a scenario test, and a fix needs a test that fails without
  it. Anything that depends on pi's real lifecycle (reload, RPC, session ids) also needs a check
  in `scripts/e2e-rpc.mjs`.
  Its `rpc-fixture.ts` provider completes turns locally and can hold a stream until released by
  a command, so team tasks, busy delivery and toggle persistence need no external model calls.
- **Live scripts:** `run()` waits for idle, then for its *own* run's start and end. A peer's ask
  can wake an agent at any moment, so never wait for the next `agent_settled` alone.

## Releasing

1. Update `CHANGELOG.md`, bump `version` in `package.json`, and run `npm run check`. For changes
   that reach the model, also run `e2e:live` and `e2e:cache`.
2. Commit (Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`) and push `main`.
3. Publish: `npm publish --access public --otp=<code>`. The scope is the npm user `justar_96`.
   `prepublishOnly` runs the typecheck and tests. The tarball contains only `src/`, `README.md`,
   `CHANGELOG.md`, `LICENSE` and `package.json`. Check them with `npm pack --dry-run`.
4. Tag and release:
   `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z && gh release create vX.Y.Z`.
5. Verify in a clean config: `PI_CODING_AGENT_DIR=$(mktemp -d) pi install npm:@justar_96/pi-telecom`,
   then start two RPC sessions in one directory and check that `/telecom` lists both.
