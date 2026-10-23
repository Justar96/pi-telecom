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
import type { Guard } from "./guard.ts";
import type { Inbound } from "./inbound.ts";
import type { LateAsk } from "./ledger.ts";
import { findProjectRoot, findRepo, readBranch, sameRepo } from "./project.ts";
import { MESSAGE_TYPES } from "./render.ts";
import { rememberedCallsign, rememberedEnabled, type Runtime } from "./runtime.ts";
import { type Claim, openTransport, type Presence, processStartTicks, transportRoot, WIRE_VERSION } from "./transport.ts";
import { messageOf, plural } from "./util.ts";

const HEARTBEAT_MS = 15_000;
/** The team is re-read every this many ticks; the inbox is drained on every tick. */
const TEAM_REFRESH_TICKS = 2;
/** Joins and leaves seen in the first ticks are the team as it was at startup, not news. */
const STARTUP_TICKS = 2;
/** A reload handoff older than this belongs to a runtime that did not come back. */
const HANDOFF_MAX_AGE_MS = 5 * 60_000;

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
	inboundAsks: Array<{ id: string; from: string; fromCallsign: string; text: string; at: number }>;
	contesters: Array<[string, Array<[string, string]>]>;
	/** Asks whose answer now arrives late: it must still wake the replacement runtime. */
	abandonedAsks?: Array<[string, LateAsk]>;
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

export function registerLifecycle(rt: Runtime, inbound: Inbound, guard: Guard): Lifecycle {
	let timer: ReturnType<typeof setInterval> | null = null;
	let tickCount = 0;
	/** The team as of the last refresh, with each member's role (subagents come and go quietly). */
	let teamIds = new Map<string, Presence["role"]>();

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
		if (!rt.self) return; // handling may have backed this session off
		// The last write of our record failed (on Windows, a reader held the file): peers still see
		// the record before it, so write it again now.
		if (rt.presenceFailures > 0) rt.step("presence", () => rt.publish());
		if (tickCount % TEAM_REFRESH_TICKS === 0) rt.step("team", refreshTeam);
		rt.step("notices", () => inbound.flushNotices());
		rt.step("asks", () => rt.ledger.expire(Date.now()));
		if (Date.now() - rt.lastHeartbeat >= HEARTBEAT_MS) rt.step("heartbeat", heartbeat);
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
		const live = new Set(peers.map((p) => p.id));
		rt.ledger.failPeerGone((id) => !live.has(id));
		const gone = new Set(rt.ledger.inbound().map((ask) => ask.from).filter((id) => !live.has(id)));
		if (gone.size > 0) rt.ledger.dropInboundFrom(gone);
		if (mustYield(me, peers)) {
			const old = me.callsign;
			yieldCallsign(me, peers);
			rt.notifyUser(`📡 callsign ${old} was taken; you are now ${me.callsign}`);
		}
		const mates = rt.team(peers);
		const ids = new Map(mates.map((p) => [p.id, p.role]));
		// Subagents come and go with every delegation; their arrivals are not news for the human.
		const joined = mates.filter((p) => !teamIds.has(p.id) && p.role !== "child");
		const left = [...teamIds].filter(([id, role]) => !ids.has(id) && role !== "child");
		if (tickCount > STARTUP_TICKS && (joined.length > 0 || left.length > 0)) {
			const parts: string[] = [];
			if (joined.length) parts.push(`${joined.map((p) => p.callsign).join(", ")} joined`);
			if (left.length) parts.push(`${plural(left.length, "agent")} left`);
			rt.notifyUser(`📡 ${parts.join("; ")}`);
		}
		teamIds = ids;
		rt.updateStatus();
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

	function heartbeat(): void {
		const me = rt.self;
		if (!me || !rt.transport) return;
		const now = Date.now();
		const before = me.claims.length;
		me.claims = me.claims.filter((c) => c.expiresAt > now);
		const expired = before - me.claims.length;
		if (expired > 0) {
			rt.inject(
				MESSAGE_TYPES.claim,
				`**📡 ${plural(expired, "claim")} expired**\n\nNo activity inside ${expired === 1 ? "it" : "them"} for ${rt.claimTtlMinutes()} minutes, so peers may work there now. Claim again if you still need it.`,
				{},
				"passive",
			);
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
	}

	// ------------------------------------------------------------------ leaving

	/** Stop the loop and drop what only a connected session needs. The records are the caller's. */
	function halt(): void {
		if (timer) clearInterval(timer);
		timer = null;
		inbound.clear();
		guard.clear();
		rt.briefState = null;
	}

	/** Leave the switchboard without touching the records, which belong to someone else now. */
	function backOff(reason: string): void {
		halt();
		rt.self = null;
		rt.ledger.abandonAll(`telecom disconnected: ${reason}. Run /telecom on to reconnect before asking again.`);
		rt.unavailable = reason;
		rt.showOff("session open elsewhere");
		rt.notifyUser(`📡 telecom: ${reason}`, "warning");
	}

	function stop(keepLine = false): void {
		halt();
		const { transport, self: me } = rt;
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
			inboundAsks: rt.ledger.inbound().map(({ id, from, fromCallsign, text, at }) => ({ id, from, fromCallsign, text, at })),
			contesters: [...rt.contesters].map(([pattern, who]) => [pattern, [...who]]),
			abandonedAsks: rt.ledger.lateCandidates(),
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
				claims: handoff?.claims ?? [],
				recent: [],
				// A reloaded runtime keeps its seniority, so it never loses its callsign to a newcomer.
				startedAt: handoff?.startedAt ?? now,
				heartbeatAt: now,
				...(branch ? { branch } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				...(handoff?.task ? { task: handoff.task } : {}),
				...(handoff?.taskAt ? { taskAt: handoff.taskAt } : {}),
			};
			rt.self = me;
			rt.taskExplicit = handoff?.taskExplicit === true;
			for (const ask of handoff?.inboundAsks ?? []) rt.ledger.noteInbound(ask);
			if (Array.isArray(handoff?.abandonedAsks)) rt.ledger.restoreAbandoned(handoff.abandonedAsks);
			for (const [pattern, who] of handoff?.contesters ?? []) rt.contesters.set(pattern, new Map(who));
			if (callsign !== remembered) rt.persistCallsign();
			rt.publish();
			rt.peers = transport.readPeers();
			// Two sessions starting in the same instant can both pick the same free word. Settle it
			// now, before the first prompt, rather than on the first tick.
			if (mustYield(me, rt.peers)) yieldCallsign(me, rt.peers);
			teamIds = new Map(rt.team().map((p) => [p.id, p.role]));
			tickCount = 0;
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
