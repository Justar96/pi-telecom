/**
 * lifecycle — joining and leaving the switchboard, and the loop that keeps this session on it.
 *
 * `connect` publishes this agent's record (keeping what a reloaded runtime parked for it) and
 * starts the loop; `stop` ends it, and either parks the state for the runtime a `/reload` brings
 * or removes the record and tells the peers waiting on this agent. The loop (`tick`, AGENTS.md
 * "The loop") drains the inbox, keeps the record written, refreshes the team, flushes notices,
 * expires asks and heartbeats. The session hooks here follow pi's lifecycle: start, shutdown,
 * compaction, renames and model changes.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childCallsign, mustYield, pickCallsign } from "./callsign.ts";
import { readConfig } from "./config.ts";
import { detectLineage, parentOf } from "./family.ts";
import { isResource } from "./glob.ts";
import type { Guard } from "./guard.ts";
import type { Inbound } from "./inbound.ts";
import type { AsyncAsk, EndedAsync, LateAsk } from "./ledger.ts";
import { findProjectRoot, findRepo, readBranch, sameRepo } from "./project.ts";
import { MESSAGE_TYPES } from "./render.ts";
import { rememberedCallsign, rememberedEnabled, type Runtime } from "./runtime.ts";
import {
	type Claim,
	openTransport,
	type Presence,
	processStartTicks,
	type QueueEntry,
	transportRoot,
	WIRE_VERSION,
} from "./transport.ts";
import { clip, messageOf, plural } from "./util.ts";
import type { Waiting } from "./waiting.ts";

/** The team is re-read every this many ticks; the inbox is drained on every tick. */
const TEAM_REFRESH_TICKS = 2;
/** Joins seen in the first ticks are the team as it was at startup, not news (departures always are). */
const STARTUP_TICKS = 2;
/** A reload handoff older than this belongs to a runtime that did not come back. */
const HANDOFF_MAX_AGE_MS = 5 * 60_000;
/** The expired path claims a notice names, in characters. */
const EXPIRED_SHOWN = 400;
/**
 * While this agent is busy, each lock it holds is kept at least this far from expiring. A lock
 * guards a job (a build, a test run) that usually runs inside the agent's run, often in one long
 * tool call the agent cannot interrupt to renew it: a lock that lapsed there was handed to the
 * next in line while the job still ran. Once the agent is idle, the lock lapses as before.
 */
const LOCK_BUSY_HOLD_MS = 5 * 60_000;
/** A run that never ends must not hold a lock forever: past this long since the lock was taken,
 *  only claiming it again keeps it. */
const LOCK_BUSY_MAX_MS = 12 * 60 * 60_000;

/** What a runtime parks for its replacement on `/reload`. */
interface Handoff {
	pid: number;
	at: number;
	callsign: string;
	startedAt: number;
	claims: Claim[];
	task?: string;
	taskAt?: number;
	/** The task was set with `status` or by a team task, not taken from a prompt. */
	taskExplicit?: boolean;
	inboundAsks: Array<{ id: string; from: string; fromCallsign: string; text: string; at: number; async?: true }>;
	contesters: Array<[string, Array<[string, string]>]>;
	/** Asks whose answer now arrives late: it must still wake the replacement runtime. */
	abandonedAsks?: Array<[string, LateAsk]>;
	/** Asks made with `wait: false` still open: the replacement still says when one goes unanswered. */
	asyncAsks?: Array<[string, AsyncAsk]>;
	/** Places in line for locks, and declared waits: a reload must not lose them. */
	queued?: QueueEntry[];
	blockedOn?: string[];
}

export interface Lifecycle {
	/** Join the switchboard as this session; null when it could not (`rt.unavailable` says why). */
	connect(ctx: ExtensionContext): Presence | null;
	/** Leave it: remove the record and tell whoever waits on this agent, or with `keepLine` (a
	 *  reload) park the state for the next runtime and leave the record in place. */
	stop(keepLine?: boolean): void;
}

/**
 * A session that started outside git is grouped by its folder alone. When `git init` (or a
 * clone) later makes that folder a checkout, its worktrees' agents must find it in their
 * repository. Only the repository is re-read: the checkout stays, since claims and views are
 * spelled relative to it, and a session in a subfolder keeps its folder.
 */
export function adoptRepo(me: Presence): void {
	if (me.repo !== me.projectRoot) return;
	const repo = findRepo(me.projectRoot);
	if (repo !== me.projectRoot) me.repo = repo;
}

export function registerLifecycle(rt: Runtime, inbound: Inbound, guard: Guard, waiting: Waiting): Lifecycle {
	let timer: ReturnType<typeof setInterval> | null = null;
	let tickCount = 0;
	/** When the heartbeat last ran. Its own clock: `rt.lastHeartbeat` moves with every write of the
	 *  record, and an agent that writes often (edits, long steps) would otherwise never expire a
	 *  claim, nor keep a busy agent's locks (`holdLocks`). */
	let lastBeat = 0;
	/** The team as of the last refresh, with each member's role (subagents come and go quietly)
	 *  and callsign (the human is told who left by name). */
	let teamIds = new Map<string, { role: Presence["role"]; callsign: string }>();

	// ------------------------------------------------------------------ the loop

	/**
	 * pi invalidates an extension's API when it disposes the session (every `pi.*` call throws
	 * from then on). A host that disposes without `session_shutdown` — or stops waiting for it, as
	 * pi-subagents does with a finished child after a timeout — would otherwise leave this timer
	 * heartbeating a dead session for as long as the process lives.
	 */
	function runtimeDisposed(): boolean {
		try {
			rt.pi.getSessionName();
			return false;
		} catch {
			return true;
		}
	}

	function tick(): void {
		const transport = rt.transport;
		const me = rt.self;
		if (!transport || !me) return;
		if (runtimeDisposed()) {
			stop();
			return;
		}
		tickCount++;
		// A throw from a timer is an uncaught exception, and the process it would take down may be
		// the parent's pi or a runner hosting other subagents. Each step is caught on its own: a
		// step that keeps failing (an unreadable inbox) must not stop the heartbeat, without which
		// peers stop honoring this agent's claims, or the ask timeouts, without which an ask hangs.
		rt.step("inbound", () => {
			const drained = transport.drain(me.id, (env) => inbound.receive(env));
			for (const failure of drained.failed) rt.report("inbound", failure);
		});
		rt.step("releases", () => waiting.afterDrain());
		if (!rt.self) return; // handling may have backed this session off
		// The last write of our record failed (on Windows, a reader held the file): peers still see
		// the record before it, so write it again now.
		if (rt.presenceFailures > 0) rt.step("presence", () => rt.publish());
		rt.step("step", () => rt.publishStep());
		if (tickCount % TEAM_REFRESH_TICKS === 0) rt.step("team", refreshTeam);
		rt.step("notices", () => inbound.flushNotices());
		rt.step("log", () => rt.flushLog());
		rt.step("asks", () => {
			for (const ask of rt.ledger.expire(Date.now())) {
				tellUnanswered(ask, `No reply within ${Math.round(ask.timeoutMs / 1000)}s. If one comes later, it still arrives as a message. Decide without it, or ask again: telecom({ action: "ask", to: "${ask.toCallsign}", message: "…", wait: false }).`);
			}
		});
		rt.step("wakes", () => rt.checkWakes());
		if (Date.now() - lastBeat >= rt.cfg.heartbeatMs) {
			lastBeat = Date.now();
			rt.step("heartbeat", heartbeat);
		}
	}

	function refreshTeam(): void {
		const me = rt.self;
		if (!me) return;
		const peers = rt.readPeers();
		const mine = peers.find((p) => p.id === me.id);
		if (mine && mine.pid !== process.pid) {
			// This same session is open in another live pi process (`pi -c` in two terminals). Two
			// writers of one record and two readers of one inbox would garble both, so the younger
			// process steps back and the older keeps the line.
			const theirsOlder = mine.startedAt < me.startedAt || (mine.startedAt === me.startedAt && mine.pid < process.pid);
			if (theirsOlder) {
				backOff(`this session is also open in pi process ${mine.pid}, which keeps the telecom line`);
				return;
			}
			rt.publish();
		} else if (!mine) {
			// Our record vanished (a sweep raced a rewrite, or the runtime dir was cleaned): restore it.
			rt.publish();
		}
		// Departures are debounced (`settleDepartures`): a record missing from one read may be back on
		// the next, and a false leave would fail asks to the peer and tell everyone it left and joined.
		// The footer and widget redrawn below, and the briefs, show this same team.
		const present = rt.settleTeam(peers, true);
		const live = new Set(present.map((p) => p.id));
		for (const ask of rt.ledger.failPeerGone((id) => !live.has(id))) {
			tellUnanswered(ask, "Their session ended before it answered. Decide without it, or ask whoever took over their work.");
		}
		const gone = new Set(rt.ledger.inbound().map((ask) => ask.from).filter((id) => !live.has(id)));
		if (gone.size > 0) rt.ledger.dropInboundFrom(gone);
		if (mustYield(me, peers)) {
			const old = me.callsign;
			yieldCallsign(me, peers);
			rt.notifyUser(`📡 callsign ${old} was taken; you are now ${me.callsign}`);
		}
		const mates = rt.team(present);
		const ids = new Map(mates.map((p) => [p.id, { role: p.role, callsign: p.callsign }]));
		// Subagents come and go with every delegation; their arrivals are not news for the human.
		// Keyed by session, so a peer that renames itself has neither left nor joined.
		const joined = mates.filter((p) => !teamIds.has(p.id) && p.role !== "child");
		const left = [...teamIds].filter(([id, was]) => !ids.has(id) && was.role !== "child").map(([id, was]) => rt.seenAs.get(id) ?? was.callsign);
		teamIds = ids;
		if (joined.length > 0 || left.length > 0) {
			// Only joins wait out the startup ticks: a session that started alongside this one is the
			// team as it was, not news. A departure is always news, since connect already knew the
			// peer. Ticks are not time: a loaded machine may tick only twice before a peer leaves.
			const news = tickCount > STARTUP_TICKS ? joined : [];
			const parts: string[] = [];
			if (left.length) parts.push(`${left.join(", ")} left`);
			if (news.length) parts.push(`${news.map((p) => p.callsign).join(", ")} joined`);
			if (parts.length) rt.notifyUser(`📡 ${parts.join("; ")}`);
			// Not held for the startup ticks: a model briefed already compares with its brief.
			tellTeamNews(me, present);
		}
		// Locks freed and teammates moved: the waits this agent declared or queued for. Races for a
		// lock are judged on this read alone: a record kept only because it is departing must not
		// win one (`Waiting.refresh`).
		rt.step("waiting", () => waiting.refresh(present, peers));
		rt.updateStatus();
	}

	/**
	 * An ask made with `wait: false` ended without an answer. Nothing waits on it, so this is news,
	 * not a reason to start a turn: passive (AGENTS.md, rule 8).
	 */
	function tellUnanswered(ask: EndedAsync, why: string): void {
		rt.inject(
			MESSAGE_TYPES.reply,
			`**📡 ${ask.toCallsign} did not answer your ask** "${clip(ask.text, 80)}" (${ask.id})\n\n${why}`,
			{ fromCallsign: ask.toCallsign, tone: "warning" },
			"passive",
		);
	}

	/**
	 * A teammate joined or left while this agent is in a run: tell the model now, not at its next
	 * prompt, which may be an hour away. It is the brief's own update (`nextBrief`), so the next
	 * brief does not repeat it, and it follows the brief's relevance rules. Passive: an idle agent
	 * is not woken for it (rule 8) and hears it in its next brief instead. Only an agent that was
	 * briefed already, and is not due a full brief (after a compaction), which its next prompt sends.
	 */
	function tellTeamNews(me: Presence, present: readonly Presence[]): void {
		if (me.state !== "busy" || !rt.briefState || rt.briefState.fullAt === 0) return;
		const update = rt.nextBrief(me, present);
		if (update.text) rt.inject(MESSAGE_TYPES.brief, update.text, update.details, "passive");
	}

	/** Converge on unique callsigns: the younger of two sessions with the same word moves. */
	function yieldCallsign(me: Presence, peers: readonly Presence[]): void {
		const taken = new Set(rt.team(peers).map((p) => p.callsign));
		// A subagent whose parent is live is named after it again; anyone else takes a free word.
		const parent = parentOf(me, peers);
		me.callsign = parent ? childCallsign(parent.callsign, taken) : pickCallsign(taken);
		rt.persistCallsign();
		rt.publish();
	}

	/** Keep the locks a busy agent holds from lapsing under the job they guard (`LOCK_BUSY_HOLD_MS`). */
	function holdLocks(me: Presence, now: number): void {
		for (const claim of me.claims) {
			if (!isResource(claim.pattern) || claim.expiresAt <= now || now - claim.since >= LOCK_BUSY_MAX_MS) continue;
			claim.expiresAt = Math.max(claim.expiresAt, now + Math.min(LOCK_BUSY_HOLD_MS, rt.cfg.claimTtlMs));
		}
	}

	function heartbeat(): void {
		const me = rt.self;
		if (!me || !rt.transport) return;
		const now = Date.now();
		if (me.state === "busy") holdLocks(me, now);
		const before = me.claims.length;
		const lapsed = me.claims.filter((c) => c.expiresAt <= now).map((c) => c.pattern);
		const locks = me.claims.filter((c) => c.expiresAt <= now && isResource(c.pattern)).map((c) => c.pattern);
		me.claims = me.claims.filter((c) => c.expiresAt > now);
		const expired = before - me.claims.length;
		if (expired > 0) {
			rt.logEntry("release", `claim expired unused: ${lapsed.join(", ")}`, lapsed);
			// Edits renew a path claim but never a lock: a lock is kept by a run in progress, or by
			// claiming it again.
			const why =
				locks.length === 0
					? `No activity inside ${expired === 1 ? "it" : "them"} for ${rt.claimTtlMinutes()} minutes, so peers may work there now.`
					: `${locks.join(", ")} ${locks.length === 1 ? "was" : "were"} not claimed again within ${rt.claimTtlMinutes()} minutes while you were idle, so the next in line may take ${locks.length === 1 ? "it" : "them"} now.`;
			// Named, so "claim again" can be acted on: the model may hold claims from hours ago.
			const paths = lapsed.filter((p) => !isResource(p));
			const named = paths.length > 0 ? ` Expired: ${clip(paths.join(", "), EXPIRED_SHOWN)}.` : "";
			rt.inject(MESSAGE_TYPES.claim, `**📡 ${plural(expired, "claim")} expired**\n\n${why}${named} Claim again if you still need ${expired === 1 ? "it" : "them"}.`, {}, "passive");
		}
		adoptRepo(me);
		const branch = readBranch(me.projectRoot);
		if (branch) me.branch = branch;
		else delete me.branch;
		rt.publish();
		try {
			rt.transport.sweep();
		} catch (error) {
			rt.report("sweep", error);
		}
		rt.step("log", () => rt.log.sweep(() => new Set(rt.readPeers().map((p) => p.id))));
	}

	// ------------------------------------------------------------------ leaving

	/** Stop the loop and drop what only a connected session needs. The records are the caller's. */
	function halt(): void {
		if (timer) clearInterval(timer);
		timer = null;
		inbound.clear();
		guard.clear();
		rt.endSteps();
		waiting.clear();
		rt.briefState = null;
		rt.resetTeam([]);
	}

	/** Leave the switchboard without touching the records, which belong to someone else now. */
	function backOff(reason: string): void {
		halt();
		rt.self = null;
		// The log file is the other process's now, like the record: nothing pending is written.
		rt.log.abandon();
		rt.ledger.abandonAll(`telecom disconnected: ${reason}. Run /telecom on to reconnect before asking again.`);
		rt.unavailable = reason;
		rt.showOff("session open elsewhere");
		rt.notifyUser(`📡 telecom: ${reason}`, "warning");
	}

	function stop(keepLine = false): void {
		halt();
		rt.forgetWakes();
		rt.flushLater();
		const { transport, self: me } = rt;
		// A reload is not a departure: the next runtime of this session continues the same log.
		// Subagents come and go with every delegation; their arrivals and departures are not history.
		if (me && !keepLine && me.role !== "child") rt.logEntry("leave", "left");
		rt.step("log", () => {
			const written = rt.log.close();
			if (written && !written.ok) rt.report("log", written.reason);
		});
		if (keepLine) {
			// A reload: the replacement runtime takes over this record and inbox within moments, so
			// peers never see this agent leave and nothing sent meanwhile is lost.
			parkForReload();
			rt.self = null;
			rt.ledger.abandonAll("telecom reloaded while waiting; a later answer will arrive as a message in the new runtime");
			return;
		}
		const waiting = rt.ledger.abandonAll("telecom disconnected while waiting. Run /telecom on to reconnect before asking again.");
		if (transport && me) {
			for (const ask of waiting) {
				rt.step("withdraw", () => rt.sendEvent(ask.to, { topic: "ask.withdrawn", data: { askId: ask.id } }, ""));
			}
			// A failed release notice must not leave a disabled session on the switchboard.
			rt.step("release", () => rt.tellReleased(me, me.claims.map((c) => c.pattern)));
			// Marked before the record goes, so no peer ever finds it missing without the mark: a
			// clean leave counts at once, in their next brief and refresh, not one refresh later.
			transport.markLeft(me.id);
			try {
				transport.removePresence(me.id);
				transport.removeInbox(me.id);
			} catch {
				/* the sweep of whoever is left will clean up */
			}
		}
		rt.self = null;
		rt.hideWidget();
		rt.clearStatus();
	}

	// ------------------------------------------------------------------ reloads

	function parkForReload(): void {
		const me = rt.self;
		if (!rt.transport || !me) return;
		const state: Handoff = {
			pid: process.pid,
			at: Date.now(),
			callsign: me.callsign,
			startedAt: me.startedAt,
			claims: me.claims,
			...(me.task ? { task: me.task } : {}),
			...(me.taskAt ? { taskAt: me.taskAt } : {}),
			...(rt.taskExplicit ? { taskExplicit: true } : {}),
			inboundAsks: rt.ledger.inbound().map(({ id, from, fromCallsign, text, at, async }) => ({ id, from, fromCallsign, text, at, ...(async ? { async } : {}) })),
			contesters: [...rt.contesters].map(([pattern, who]) => [pattern, [...who]]),
			abandonedAsks: rt.ledger.lateCandidates(),
			asyncAsks: rt.ledger.asyncOpen(),
			...(me.queued?.length ? { queued: me.queued } : {}),
			...(me.blockedOn?.length ? { blockedOn: me.blockedOn } : {}),
		};
		rt.transport.writeHandoff(me.id, state);
	}

	/** The state a previous runtime of this session parked — only from this process, and only if fresh. */
	function takeReloadHandoff(id: string): Handoff | null {
		if (!rt.transport) return null;
		const raw = rt.transport.takeHandoff(id) as Partial<Handoff> | null;
		if (!raw || raw.pid !== process.pid || typeof raw.at !== "number" || Date.now() - raw.at > HANDOFF_MAX_AGE_MS) {
			return null;
		}
		return raw as Handoff;
	}

	// ------------------------------------------------------------------ joining

	function connect(ctx: ExtensionContext): Presence | null {
		rt.ctx = ctx;
		try {
			const id = ctx.sessionManager.getSessionId();
			if (!id) return null;
			if (rt.self && rt.self.id !== id) stop();
			const rootResult = transportRoot();
			if (!rootResult.ok) {
				rt.unavailable = rootResult.reason;
				rt.report("transport", rootResult.reason);
				return null;
			}
			rt.unavailable = null;
			const transport = openTransport(rootResult.path);
			rt.transport = transport;
			transport.sweep();
			const projectRoot = findProjectRoot(ctx.cwd);
			const repo = findRepo(projectRoot);
			const peers = transport.readPeers().filter((p) => p.id !== id);
			const lineage = detectLineage({
				env: process.env,
				// Optional call: a host without session headers simply has no foreground children.
				parentSessionFile: ctx.sessionManager.getHeader?.()?.parentSession,
				peers,
				pid: process.pid,
				selfId: id,
			});
			const taken = new Set(peers.filter((p) => sameRepo(p, { projectRoot, repo })).map((p) => p.callsign));
			const remembered = rememberedCallsign(ctx);
			const handoff = takeReloadHandoff(id);
			const parent = lineage.parent ? peers.find((p) => p.id === lineage.parent) : undefined;
			// A subagent inherits its parent's environment, PI_TELECOM_CALLSIGN included: that name
			// is the parent's, so a child is named after its parent instead.
			// A child forked from its parent's context also inherits the parent's remembered callsign,
			// which the parent holds: then it is named after the parent too, not given a free word.
			const wanted =
				lineage.role === "child"
					? ((remembered && !taken.has(remembered) ? remembered : undefined) ??
						(parent ? childCallsign(parent.callsign, taken) : undefined))
					: (rt.cfg.callsign ?? remembered);
			const callsign = pickCallsign(taken, handoff?.callsign ?? wanted);
			const now = Date.now();
			const branch = readBranch(projectRoot);
			const me: Presence = {
				v: WIRE_VERSION,
				id,
				callsign,
				pid: process.pid,
				ticks: processStartTicks(process.pid),
				cwd: ctx.cwd,
				projectRoot,
				repo,
				role: lineage.role,
				...(lineage.parent ? { parent: lineage.parent } : {}),
				waitingOn: [],
				state: "idle",
				stateSince: now,
				claims: handoff?.claims ?? [],
				recent: [],
				// A reloaded runtime keeps its seniority, so it never loses its callsign to a newcomer.
				startedAt: handoff?.startedAt ?? now,
				heartbeatAt: now,
				...(branch ? { branch } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				...(handoff?.task ? { task: handoff.task } : {}),
				...(handoff?.taskAt ? { taskAt: handoff.taskAt } : {}),
				...(Array.isArray(handoff?.queued) && handoff.queued.length > 0 ? { queued: handoff.queued } : {}),
				...(Array.isArray(handoff?.blockedOn) && handoff.blockedOn.length > 0 ? { blockedOn: handoff.blockedOn } : {}),
			};
			rt.self = me;
			// The log continues what this session's file holds (a resume, a reload); a reload is no join.
			rt.log.open(transport.root, id);
			if (!handoff && lineage.role !== "child") rt.logEntry("join", "joined");
			rt.taskExplicit = handoff?.taskExplicit === true;
			for (const ask of handoff?.inboundAsks ?? []) rt.ledger.noteInbound(ask);
			if (Array.isArray(handoff?.abandonedAsks)) rt.ledger.restoreAbandoned(handoff.abandonedAsks);
			if (Array.isArray(handoff?.asyncAsks)) rt.ledger.restoreAsync(handoff.asyncAsks);
			for (const [pattern, who] of handoff?.contesters ?? []) rt.contesters.set(pattern, new Map(who));
			if (callsign !== remembered) rt.persistCallsign();
			// Back after a `/telecom off` or a resume: an old leave mark must not make a later one-read
			// miss of this record count as a departure.
			transport.clearLeft(id);
			rt.publish();
			rt.peers = transport.readPeers();
			// Two sessions starting in the same instant can both pick the same free word. Settle it
			// now, before the first prompt, rather than on the first tick.
			if (mustYield(me, rt.peers)) yieldCallsign(me, rt.peers);
			rt.resetTeam(rt.peers);
			teamIds = new Map(rt.team(rt.present).map((p) => [p.id, { role: p.role, callsign: p.callsign }]));
			tickCount = 0;
			lastBeat = Date.now();
			timer ??= setInterval(tick, rt.cfg.tickMs);
			timer.unref?.();
			rt.updateStatus();
			return me;
		} catch (error) {
			rt.unavailable = messageOf(error);
			rt.report("start", error);
			stop();
			return null;
		}
	}

	// ------------------------------------------------------------------ session hooks

	rt.on("session_start", (_event, ctx) => {
		rt.ctx = ctx;
		// pi clears extension statuses when it rebinds a session: set the footer again.
		rt.forgetStatus();
		rt.cfg = readConfig();
		const remembered = rememberedEnabled(ctx);
		rt.enabled = remembered ?? !rt.cfg.disabled;
		if (rt.enabled) connect(ctx);
		// Turned off by the human (not by the environment): the footer says so, as a reminder.
		else if (remembered === false) rt.showOff();
	});

	rt.on("session_shutdown", (event) => {
		stop(event?.reason === "reload");
	});

	rt.on("session_compact", () => {
		rt.awareness.markCompacted();
		rt.noteCompaction();
		// The summary may have dropped the team picture: the next prompt gets a full brief.
		rt.requestFullBrief();
	});

	rt.on("session_info_changed", () => {
		if (rt.self) rt.publish();
	});

	rt.on("model_select", (event) => {
		if (!rt.self) return;
		rt.self.model = event.model.id;
		rt.publish();
	});

	return { connect, stop };
}
