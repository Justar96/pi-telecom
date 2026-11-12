# Telecom's implicit state machines

This is a maintainer's map of the production state in `src/`, not a new runtime framework.
The names below describe states already represented by records, maps, flags, timestamps and
closures. These machines run together; `busy`, for example, does **not** imply that the agent
holds a lock, waits on an ask, or has read a message.

## Decision

Keep the machines local to their existing owners. Make their transitions and invariants explicit
here, and add regression tests at boundaries where machines interact. Do not replace them with
one giant status enum or add a state-machine dependency.

The first repairs are at the run-settlement boundary in `src/turns.ts`:

1. Pi's boundary result **replaces** the accumulated draft entries. Telecom must append its
   deferred messages and ask reminder to `event.entries`, not discard earlier extensions' drafts.
2. `context.canContinue` describes the current preview, not permission to propose new context.
   An ordinary final assistant response makes it false; the custom messages telecom adds make
   the final preview runnable. Let pi validate that final proposal, and skip aborted/error
   outcomes rather than skipping completed runs that need new context.

When telecom has nothing to add, it must return nothing, leaving both entries and continuation
untouched. Request continuation only together with at least one new custom-message draft.

- **UX:** another extension's queued message/state survives, and deferred messages receive a
  response before the activity is reported settled.
- **DX:** extension load order does not require a workaround; tests check the host's real events.
- **AX:** owed-ask reminders and held messages provide their own runnable context; all earlier
  proposals stay in order, without spending another idle wake-up.

This is additive at the existing boundary: no tool/schema change, wire-version change,
new background job, system-prompt mutation, or new coordination requirement.

## Inventory

`→` denotes an event-driven transition; states in parentheses are conditions represented by
fields rather than named enums. Sources name the transition owners, not just display helpers.

### Session, identity and presence

| Machine | Existing representation and transitions | Owner / checks |
| --- | --- | --- |
| Connection and enablement | Factory registers only → `session_start` connects if enabled → connected (`self`, timer). Off or shutdown stops; reload parks a handoff; connection failure leaves `unavailable`; duplicate ownership backs off. `/telecom on` retries. `enabled` is the human/environment preference, not proof of a connection. | `runtime.ts`, `lifecycle.ts`, `command.ts`; `team.test.ts`, `e2e-rpc.mjs` |
| Ownership of a session's line | One writer → another live pid writes the same session → compare start time, then pid → younger process backs off without deleting the owner's record/inbox/log. | `lifecycle.ts: refreshTeam`, `backOff`; `e2e-rpc.mjs` |
| Reload continuity | Connected → stop loop and flush held messages to pi's next-turn queue → park selected state, keep presence/inbox → same-pid, fresh replacement takes handoff → reconnect. Missing, stale or wrong-pid handoff starts fresh. | `lifecycle.ts: stop`, `parkForReload`, `takeReloadHandoff`; `asks.test.ts`, `locks.test.ts`, `log.test.ts`, RPC checks |
| Callsign convergence | Preferred/remembered/inherited name → available name → collision → younger session yields → persist new name and request a full brief when needed. Children use a parent's name with a suffix. A new top-level session is `provisional` until its first run or a human rename: a session that has run takes its preferred name back from provisional holders (`reclaimable`), and between two records that both publish `provisional` the provisional one yields whatever their ages. A session renamed although it had run publishes `formerly` (kept over a reload, not over a restart). | `callsign.ts`, `lifecycle.ts`, `command.ts`; `team.test.ts`, RPC rename/reload checks |
| Repository adoption | Started outside git (`repo === projectRoot`) → repository discovered on a run start/heartbeat → grouped with that repository's worktrees. The original checkout root does not change. | `lifecycle.ts: adoptRepo`, `project.ts`; `team.test.ts` |
| Presence publication | Clean → write fails (previous record remains) → retry on each tick → success resets failure counter. Repeated failure warns the human. | `runtime.ts: publish`, `lifecycle.ts: tick`; `portability.test.ts` |
| Peer liveness and membership | Read live record → first unexplained missing refresh (departing, still present) → record returns (present), or second miss (gone). A dead process or explicit leave mark removes it immediately. Read errors may retain the last valid record; child silence is compared to its own host process. | `transport.ts: isLive`, `readPeers`, `settleDepartures`; `runtime.ts: settleTeam`; `presence-live.test.ts`, `portability.test.ts` |

### Runs, tasks and message delivery

| Machine | Existing representation and transitions | Owner / checks |
| --- | --- | --- |
| Agent run and settlement | Idle → `before_agent_start` busy → tools/model turns → `agent_before_settle` may request one continuation → `agent_settled` idle. `agent_end` is **not** final idle on pi. Aborted/error outcomes leave held messages for settlement; a completed assistant-ending preview can become continuable through new drafts. On omp (`host.ts: hostOf`), which has no settle hooks: `agent_start` busy (a wake-up run skips `before_agent_start`) → `session_stop` may continue with the owed-ask reminder → `agent_end` idle, held messages delivered as a wake-up. | `turns.ts`, `runtime.ts: setState`, `host.ts`; `deferred.test.ts`, `state-machines.test.ts`, `host.test.ts`, RPC checks, `e2e-omp.mjs` |
| Published tool step | Tool call tracked locally → long enough to publish → result/execution-end removes it → next oldest long-running tool takes its place. Final idle/disconnect clears every step; nested calls belong to their outer tool. | `runtime.ts: noteStepStart`, `noteStepEnd`, `publishStep`; `turns.ts`; `presence-live.test.ts` |
| Task provenance | Inferred from a prompt ↔ explicitly set by `status`/team task. Short acknowledgements preserve an explicit task; while any task stands, a short question or a short go-ahead/wrap-up (`CARRY_ON`: "go ahead", "commit and merge") preserves it too, but a short new task replaces it; a sufficiently substantive prompt can replace an inferred task, and an explicit one only once it is older than `EXPLICIT_TASK_HOLD_MS`. Changes are logged; the provenance survives reload. The task, its time and provenance are written to the session (`telecom-task`) at settlement and on the heartbeat, only when changed, and a restart restores the session's own entry (a fork's inherited entry is ignored; children write none); a restored task is not logged again. | `runtime.ts: setTask`, `persistTask`, `rememberedTask`; `turns.ts: taskFromPrompt`; `lifecycle.ts: connect`; `actions.ts: statusAction`; `team.test.ts`, `teamflow.test.ts`, `e2e-rpc.mjs` |
| Envelope lifecycle and deduplication | Validate → atomic inbox write → drain in filename order → handle → remove. Read failures leave files to retry; malformed/wrong-recipient files and handler failures are removed. Seen envelope ids suppress duplicate handling within the bounded, runtime-local dedupe window. | `transport.ts: deliver`, `drain`; `inbound.ts: receive`; `asks.test.ts`, `portability.test.ts`, `team.test.ts` |
| Direct-message routing | Arrival → hold with a blocking ask to its sender, else defer if requested and busy, else inject now. Human team tasks bypass ordinary routing and wake limits. An `unblocks` message/answer updates declared waits before its model delivery. | `inbound.ts: handleEnvelope`, `runtime.ts: injectMessage`; `asks.test.ts`, `deferred.test.ts`, `waits.test.ts` |
| Deferred-message queue | Busy + `interrupt: false` → held in arrival order → boundary entries and continuation; if a run exits without processing the boundary, settlement appends all and wakes once on the last. Overflow steers the oldest rather than dropping it. Leaving flushes remaining messages to pi's next-turn queue. | `runtime.ts: holdDeferred`, `deferredEntries`, `deliverDeferred`, `flushLater`; `deferred.test.ts`, `state-machines.test.ts`, RPC checks |
| Broadcast relevance and aging | Near/no-path broadcast → passive delivery; far-path broadcast → `later` queue → next run's brief. Old held broadcasts become summaries; overflow is counted. Leaving transfers remaining held text to pi's queue. Recent direct contact can make the sender near. | `inbound.ts: concernsMe`, `runtime.ts: takeLater`, `noteContact`; `briefs.test.ts`, `team.test.ts` |
| Idle wake budget | Idle direct-message wake → record time in rolling window → allowance exhausted → append without starting a run. Busy steering spends no allowance; asks/human tasks use `wake-always`; informational delivery stays passive/later. | `runtime.ts: inject`, `allowWake`; `team.test.ts`, RPC busy/wake-limit checks |
| Unanswered wake recovery | Idle wake starts run → unread obligation → successful assistant message clears it. If idle and overdue: retry, publish `unreadSince`, eventually warn the human once. Busy pauses retries; compaction makes the reminder repeat more text; stopping forgets obligations. | `runtime.ts: noteWake`, `checkWakes`, `noteModelTurn`, `noteCompaction`; `locks.test.ts` |

### Asks, claims, locks and declared waits

| Machine | Existing representation and transitions | Owner / checks |
| --- | --- | --- |
| Blocking outbound ask | Register promise and publish wait edge **before** sending → pending → matched answer resolves; timeout, abort, disconnect, peer departure or cycle interruption ends the wait. Abandoned asks remain recognizable for a late reply. Held peer messages precede the answer, or transfer to another ask on that peer, or return to normal delivery. | `ledger.ts: awaitAnswer`, `stop`, `settle`; `actions.ts: askAction`; `asks.test.ts`, `units.test.ts`, `team.test.ts` |
| Nonblocking outbound ask | Send with `async` → track deadline without a wait edge → reply wakes and consumes open entry. Timeout/departure ends it with a passive notice; late reply remains recognizable. Reload transfers open deadlines; disconnect withdraws it. | `ledger.ts: trackAsync`, `endAsync`, `wasAbandoned`; `actions.ts: askWithoutWaiting`; `asks.test.ts` |
| Inbound ask obligation | Receive → unanswered/unreminded → one settlement reminder → still answerable. Successful reply consumes it; failed delivery keeps it. Withdrawal or asker departure removes it. Reload restores obligations; remembered late answers are a separate outbound concern. | `ledger.ts: noteInbound`, `resolveInbound`; `inbound.ts`, `actions.ts: replyAction`, `turns.ts`; `asks.test.ts`, `teamflow.test.ts`, `state-machines.test.ts` |
| Path-claim lifetime and scope | Requested patterns → independently granted/refused → active with expiry and optional checkout/process → renewed by matching edits/reclaim → explicit release, expiry, process exit or departure. Expiry releases at `expiresAt`; only the model's notice is held (`tellLapsed`) while another claim is due within the hold (min 60 s, TTL/4), bounded by that hold from the first lapse, so close lapses share one notice. A relative claim is not silently narrowed to one checkout; sibling-lane overlap is advisory. | `actions.ts: claimAction`, `releaseAction`; `guard.ts: announceChange`; `lifecycle.ts: heartbeat`; `team.test.ts`, `claims-hold.test.ts`, `teamflow.test.ts` |
| Resource lock and queue | Free → claimed, or held → queued (refused only with `queue: false`) → first responsive waiter takes a freed lock and wakes. A lock its claimant already holds live is never in conflict, whoever is in line: it is renewed. Concurrent holders converge by earliest claim, then session id; loser requeues at its original place and is told if it believed it held the lock. Renewing a live lock preserves seniority; reclaim after expiry does not. Release can also leave a queue. | `locks.ts` pure decisions; `actions.ts`, `waiting.ts: takeFreeLocks`, `settle`; `locks.test.ts` |
| Claim keepalive | Active claim nearing expiry → held for a busy owner's lock, a live attached process, or a declared wait on a teammate at work → expiry extended within the maximum hold age. Process exit releases first: path claims and an idle owner's locks at once; a busy owner's lock is untied from the process and kept for `Runtime.exitGraceMs` (`Runtime.exitGrace`), told at once, then released unless claimed again (`claimAction` and any release end the grace; a disconnect clears it, and over a reload the lock continues as an ordinary one). Inactive/expired claims are not resurrected by heartbeat. Ordinary file edits do not renew resource locks. | `lifecycle.ts: holdClaims`, `releaseExited`, `heartbeat`; `claims-hold.test.ts`, `locks.test.ts` |
| Declared wait | `status.waitingFor` declares/replaces (`blockedOn`) → later status without it keeps it; `[]` clears. Ordinary message marks heard, but does not clear; subsequent work clears heard waits. `unblocks`, a lock handoff from the awaited holder, or departure clears them directly. Run completion wakes an otherwise-uninformed waiter without clearing the wait. A message that leaves the wait carries the "still waiting" line once per sender and declaration (`blockedSince`); compaction forgets what was told. A wait ended by work is told once, briefly, naming the task only if it still reads as waiting. | `actions.ts: statusAction`; `runtime.ts: stillWaitingNote`; `waiting.ts: declare`, `heard`, `endHeardWaits`, `wakeDeclared`; `waits.test.ts`, `teamflow.test.ts` |
| Outbound wait-acknowledgement hints | Successful `unblocks` sends/replies and answered asks record separate bounded timestamps. Compare them with the peer's wait start: an explicitly ended wait is omitted from local cycle-declaration/hint projections while presence catches up; a reply alone suppresses only the reply hint, not a cycle. FYIs leave both intact, and a later declared wait is visible again. This never rewrites the peer's actual record. | `actions.ts: unblockedAt`, `answeredAt`, `withoutEnded`; `session-audit.test.ts` |
| Wait stalls and cycle notices | Declaration establishes comparison baseline → awaited peer becomes idle/unread long enough → notify once per stall. A declared cycle is named once when declared; wake only after every member has stalled. New idle spells can be new stalls. A message sent during the awaited run suppresses a redundant completion wake. | `waiting.ts: stallNews`, `flagCycle`, `lastHeard`, `cyclesTold`; `locks.test.ts`, `waits.test.ts`, `teamflow.test.ts` |

### File awareness, briefs, durability and human views

| Machine | Existing representation and transitions | Owner / checks |
| --- | --- | --- |
| Per-file view and taint | Unseen → read/current fingerprint → attributable peer change + changed bytes makes view stale. Successful anchored edit over an unread change leaves a tainted view; re-read clears it. Compaction removes context relevance, not stale protection. Standard/strict/off choose the verdict; repeated stale blocks eventually step aside. | `awareness.ts: noteRead`, `noteOwnWrite`, `checkStale`, `block`; `guard.ts`; `units.test.ts`, `team.test.ts` |
| Claim-contention warning | Binding live/responsive claim → first edit attempt blocked and owner told → standard-mode retry in the warning window may proceed; strict keeps blocking. Unresponsive owner or another checkout is advisory. Advisory matches never hide a later binding claim. | `awareness.ts: checkClaims`, `contested`; `guard.ts`; `team.test.ts`, `teamflow.test.ts` |
| One-time lane advice and guard-call bookkeeping | Detect proposed lane note/owner notification → stage under tool-call id → commit only on successful edit/write. Failed/blocked calls do not consume the advice. Already committed peer/path notes suppress repeats. | `awareness.ts: checkLanes`, `commitLaneNotes`, `noteContested`; `guard.ts: calls`, `tool_result`; `team.test.ts`, `teamflow.test.ts` |
| Explanations in tool results | First time a kind comes up in this context (path claim, lock, lock for a process, queue, declared wait, a set of waiters) → explained in full → later results say only what happened. A compaction forgets all of it; a new runtime (reload, resume) explains once more. Only successful results use one up. | `runtime.ts: firstTime`, `noteCompaction`; `actions.ts: statusAction`, `claimAction`, `joinLines`; `teamflow.test.ts` |
| Change-notice coalescing | Relevant change → pending by peer/path → subsequent burst updates count/excerpt → coalescing deadline or final settlement flush → passive notice. A view's notified/context flags suppress unnecessary new bursts; disconnect drops pending notices. | `inbound.ts: queueNotice`, `enqueueNotice`, `flushNotices`; `awareness.ts: notePeerChange`; `team.test.ts` |
| Brief knowledge and relevance | No peers → no initial brief; first peer/full requested → full brief → subsequent deltas against **what was told**, not merely observed. Far units retain untold news; becoming near reveals it. Task/lane-only changes are held briefly; compaction or callsign change requests another full brief. Family folding retains actual claim holders. | `board.ts: BriefState`, `renderBrief`; `runtime.ts: nextBrief`, `requestFullBrief`; `briefs.test.ts`, `teamflow.test.ts`, `team.test.ts` |
| Own durable log | Closed → open (load existing history, or defer if unreadable) → record makes dirty → atomic flush makes clean; failure keeps dirty and retries. Reload/resume continues history. A provisional session logs no join or leave; it joins when it settles in (`Runtime.settleIn`). Close flushes then abandons; backing off abandons without writing another owner's file. | `log.ts: TeamLog`; `runtime.ts`, `lifecycle.ts`; `log.test.ts`, RPC log/reload checks |
| Peer-log cache and retention | Read/validate → cache by file metadata → unchanged file reuses cache; transient read errors keep prior entries. Departed-session history remains until retention expires; sweep removes old files/temp files. Live sessions are retained regardless of file age. Private messages/asks/answers never enter this log. | `log.ts: read`, `sweep`; `log.test.ts` |
| Human-surface lifecycle | Footer only writes when text changes; session rebind forgets the shown value. Widget off/on is separate from mounted/disposed component; refresh invalidates cached lines. Board open/closed has repository/machine scope and scroll position. Help selection runs a command or prefills the editor. RPC gets plain text rather than TUI components. | `runtime.ts: updateStatus`, `toggleWidget`, `showWidget`; `view.ts`, `command.ts`; `view.test.ts`, `presence-live.test.ts`, RPC checks |

## Important coupled boundaries

```text
before_agent_start       agent_before_settle                  agent_settled
       │                         │                                 │
 idle ─┴─→ busy ─→ model/tools ────┤                                 │
                                 ├─ prior drafts + telecom drafts ──┤
                                 │       continue → model/tools     │
                                 └─ no continuation / abort ────────┴─→ idle
                                                                       │
                                                        deliver held messages once
```

The boundary's entries belong to **all** extensions. Preserve their order and content; do not
mutate the array passed by the host. Its `context` previews the accumulated drafts so far; a
false `canContinue` before adding a new custom message does not forbid that message. Pi validates
the final preview. Request continuation only for new telecom work on a completed outcome. A reminder
already issued or a deferred message already consumed must not create an endless continuation.

```text
blocking ask:  register → publish edge → send → await → settle → publish edge removal
                                                    │
                                                    ├─ answer: held messages, then answer
                                                    └─ no answer: hand held messages onward

lock handoff:  drain releases → fresh/debounced team → first waiter takes → publish → wake
lock race:     compare actually-read records → loser requeues → publish → passive correction
```

The debounced team intentionally keeps a temporarily missing holder/waiter. Those retained
records must **not** win a lock race against an actually-read successor. Similarly, a late answer
is not a new unanswered ask, and a declared wait (`blockedOn`) is not a blocking ask edge
(`waitingOn`). Keeping those state spaces separate prevents false deadlocks and duplicate wakes.

## Durability and guarantees

- Session-branch entries persist the callsign (with the session that held it, and whether its
  human chose it) and enabled override. Reload handoff transfers
  selected coordination state, including claims, open inbound asks, late-answer metadata,
  nonblocking deadlines, queues and declared waits; it is not a snapshot of every runtime field.
- Presence is replaceable current state. The bounded team log is retained history, not a private
  message archive or durable delivery acknowledgement.
- Inbox delivery is at-least-once across a process interruption before removal. The bounded
  in-memory seen-id cache is not a permanent exactly-once guarantee; handler exceptions are
  reported and their message files removed rather than retried forever.
- An envelope being written, being injected, starting a run, receiving an assistant response,
  and its recipient actually completing the requested work are different events. Telecom
  cannot infer completion from delivery.
- Pure functions such as `closesCycle`, `declaredCycle`, `stateHint`, `ownerOf`, glob matching,
  parsers and renderers compute decisions/projections; they do not own additional mutable
  lifecycles. Parent/family and lane relationships are likewise derived from records and paths.
- Small caches, bounded maps and counters (places, contact recency, diagnostic dedupe, claim
  retry hints, render caches) support the machines above. They are not independent workflow
  statuses and must not become a second source of truth.

## Change checklist

For a new transition or bug fix, check the relevant row above and ask:

1. Which event owns the transition, and what if it arrives twice or never arrives?
2. Is the source of truth local state, an actually-read record, the debounced team, or what the
   model was told? Does reload/off/on preserve exactly what it should?
3. Does a failed write/delivery keep pending state, and can an exception escape a hook/timer?
4. Is an informational event passive, and does an authorized wake spend only the intended budget?
5. Does the change preserve other extensions' drafts, static prompts/tools, and older peers?
6. Is there a scenario that fails before the fix, plus a real RPC check for host-lifecycle work?

`test/state-machines.test.ts` covers settlement composition for deferred messages, ask reminders,
assistant-ending previews, no-op/aborted/error/disconnected paths, ordering, immutability and
one-shot continuation. The local provider in `scripts/rpc-fixture.ts` adds an earlier extension's
draft during a real run; `scripts/e2e-rpc.mjs` checks that it survives telecom and precedes the
deferred message exactly once. A separate check requires a boundary `entry_appended` and a
subsequent assistant response **before** final settlement, not an idle wake-up afterward. This
provides an outcome check without paid model calls.
