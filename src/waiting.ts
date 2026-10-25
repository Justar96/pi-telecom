/**
 * waiting — acting for an agent that waits on its teammates, so it never has to poll or negotiate
 * in prose. Two kinds of wait:
 *
 *   - a LOCK it queued for (`claim` with `queue: true` on a held `@resource`): when the holder
 *     releases it, leaves, or lets it expire, the first live waiter takes it and is woken. Two
 *     sessions that took one free lock at once settle on the same winner (`locks.ts`, `lostRaces`);
 *     the loser goes back to the front of the line and, once it was told the lock was its own, is
 *     told it is not. Who holds a lock and who is next is decided on the debounced team (a record
 *     missing from one read still holds its locks and keeps its place), but a race only against
 *     records actually read: a record kept only because it may come back must never win one;
 *   - a teammate it DECLARED it waits for (`status` with `waitingFor`, published as `blockedOn`):
 *     it is woken when that teammate finishes a run or leaves (then the wait is dropped), and the
 *     wait ends by itself: when that teammate sends a message or answer marked `unblocks`, when the
 *     agent gets to work after hearing from it (a go-ahead and an FYI look alike, but only a
 *     go-ahead is followed by work, so nobody has to clear waits by hand), or when it hands the
 *     agent a lock it queued for. Declared waits
 *     that form a cycle are pointed out to each agent on it once everyone on it has sat idle a
 *     while: a cycle with a busy member is usually someone writing the go-ahead, not a stall.
 *
 * The wake-ups use `wake` (wake-limited) although they carry no peer's words: the agent asked for
 * exactly this signal, the way an ask asks for its answer, so it is the reply to its own request,
 * not information pushed at it (AGENTS.md, rule 8). So is the notice of a stalled cycle: it is
 * news about teammates the agent declared it waits for, and without it nobody ever moves.
 */
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { lineOf } from "./family.ts";
import { isResource, resourceKey, sameResource } from "./glob.ts";
import { callsignsOf, cycleKey, declaredCycle, holdsOf, lineFor, lostRaces } from "./locks.ts";
import { MESSAGE_TYPES } from "./render.ts";
import type { Runtime } from "./runtime.ts";
import { type Presence, QUEUED_CAP } from "./transport.ts";
import { ago, clip, elapsed, setBounded, shortId } from "./util.ts";

/** A teammate's task, as a wake-up quotes it. */
const TASK_SHOWN = 120;
/** Locks whose last holder is remembered, to say how each freed. */
const HOLDERS_CAP = 64;
/** How a lock freed when no holder was ever seen. */
const FREE = "it was free";
/**
 * A teammate this agent waits for that stays idle this many heartbeats (30 min) since the wait
 * began is pointed out, once per idle spell: it may never have got, or seen, what it needed to
 * move, and an idle agent never "finishes a run". In one team a message that started no run left
 * its recipient idle all night, and every agent waiting down the line with it.
 */
const STALE_WAIT_BEATS = 120;
/**
 * A wait cycle is a stall once every agent on it has been idle this long (5 min). One busy member
 * is most likely writing the go-ahead the others wait for: telling them then was noise (21 notices
 * in one two-day team, all two-agent cycles with a busy side).
 */
const CYCLE_STALL_MS = 5 * 60_000;

export interface Waiting {
	/** After a team refresh: settle lock races against `read` (this refresh's read), take a freed
	 *  lock when first in line, wake declared waits, and point out a wait cycle, all against
	 *  `present` (the debounced team). Costs nothing for an agent that holds and awaits nothing. */
	refresh(present: readonly Presence[], read: readonly Presence[]): void;
	/** A peer released `patterns` (its event sent `at`): note those this agent queues for, to take
	 *  once the inbox is drained (`afterDrain`). Returns them (the caller says nothing else about
	 *  them). */
	released(fromId: string, fromCallsign: string, patterns: readonly string[], at: number): string[];
	/** The inbox was drained: take the locks released in it, if first in line. */
	afterDrain(): void;
	/** A peer sent this agent a message or answer. With `unblocks` a declared wait on it is over;
	 *  without, the wait ends when the agent next gets to work (`refresh`, `endHeardWaits`). */
	heard(id: string, unblocks: boolean): void;
	/** The agent declared whom it waits for: note how each looks now, so a change is news. Returns
	 *  a warning when the declaration closes a wait cycle. */
	declare(peers: readonly Presence[]): string | null;
	/** Give up the locks a rival took first, judged on `read` (a fresh read); returns their names.
	 *  The caller tells the model: this is the claim being made. */
	settleRaces(read: readonly Presence[]): string[];
	/** Forget everything: the session left the switchboard. */
	clear(): void;
}

export function createWaiting(rt: Runtime): Waiting {
	/** The last holder seen of each lock this agent queues for, to say how it freed. */
	const lastHolder = new Map<string, { id: string; callsign: string }>();
	/** Locks this agent took from the line (it was told "is yours now"), with its place in that line:
	 *  should a rival turn out to have taken it first, the agent goes back to that place. */
	const fromLine = new Map<string, number>();
	/** How each teammate this agent waits for looked when last checked: a change is news. `since`:
	 *  when the wait began; `told`: the stall last pointed out (see `stallNews`). */
	const seen = new Map<string, { callsign: string; state: Presence["state"]; task: string; since: number; told?: string }>();
	/** Awaited teammates that messaged or answered this agent since the wait was declared, and when:
	 *  the wait ends once the agent gets to work after that. */
	const heardAt = new Map<string, number>();
	/** The stalled wait cycle this agent was told it is on: the cycle plus when its last member went
	 *  idle, so a new idle spell is a new stall. */
	let toldCycle: string | null = null;
	/** Rivals as the last refresh saw them, to tell what freed a lock: one of them gone since. */
	let lastSeen: readonly Presence[] = [];
	/**
	 * Release events read in this drain, per lock: the latest sent names who freed it. A slow tick
	 * can read an old release (alpha's, before bravo took the lock) together with the newest
	 * (bravo's, as it left), in either order; taken event by event, the old one named alpha.
	 */
	const releases = new Map<string, { id: string; callsign: string; at: number }>();

	/** Teammates whose locks bind this agent: its lineal family shares, like it shares claims. */
	function rivals(me: Presence, peers: readonly Presence[]): Presence[] {
		const family = lineOf(me, peers);
		return rt.team(peers).filter((p) => !family.has(p.id));
	}

	/**
	 * How a lock freed, named only when it is known. A rival the last refresh saw holding it, or in
	 * line ahead of this agent (`mySince`), that has gone since is what freed it, whatever event came
	 * in: on a loaded machine a release event can be read after the next holder took the lock and
	 * left. Then `releasedBy`, the peer whose release event prompted this take. Without either, the
	 * last holder seen may not be the last holder (a peer can take a lock and release it between two
	 * refreshes), so one still present without the lock is not named.
	 */
	function howFreed(name: string, peers: readonly Presence[], now: number, mySince: number, releasedBy: string | undefined): string {
		const here = new Set(peers.map((p) => p.id));
		const gone = lastSeen.filter((p) => !here.has(p.id));
		const held = gone.find((p) => p.claims.some((c) => sameResource(c.pattern, name)));
		if (held) return `${held.callsign} left`;
		const ahead = lineFor(name, gone).find((w) => w.since < mySince);
		if (ahead) return `${ahead.peer.callsign} left`;
		const last = lastHolder.get(name);
		if (releasedBy) return last && !peers.some((p) => p.id === last.id) ? `${releasedBy} left` : `${releasedBy} released it`;
		if (!last) return FREE;
		const holder = peers.find((p) => p.id === last.id);
		if (!holder) return `${last.callsign} left`;
		const claim = holder.claims.find((c) => sameResource(c.pattern, name));
		return claim && claim.expiresAt <= now ? `${last.callsign}'s claim on it expired` : FREE;
	}

	function takeFreeLocks(me: Presence, peers: readonly Presence[], releasedBy?: ReadonlyMap<string, string>): void {
		if (!me.queued?.length) return;
		const now = Date.now();
		const others = rivals(me, peers);
		const taken: Array<{ name: string; how: string }> = [];
		/** Who held the locks taken now: a wait declared on them ends with the handoff. */
		const handedBy = new Set<string>();
		for (const entry of [...me.queued]) {
			const name = resourceKey(entry.pattern);
			const holder = holdsOf(name, others, now)[0];
			if (holder) {
				setBounded(lastHolder, name, { id: holder.peer.id, callsign: holder.peer.callsign }, HOLDERS_CAP);
				continue;
			}
			// Free. The first responsive session in line takes it: a hung waiter must not stall the
			// line (it finds the lock held when it is back, and stays in line).
			const line = lineFor(name, [me, ...others]).filter((w) => w.peer.id === me.id || now - w.peer.heartbeatAt <= UNRESPONSIVE_MS);
			if (line[0]?.peer.id !== me.id) continue;
			me.queued = (me.queued ?? []).filter((q) => !sameResource(q.pattern, name));
			me.claims = me.claims.filter((c) => !sameResource(c.pattern, name));
			me.claims.push({ pattern: name, since: now, expiresAt: now + rt.cfg.claimTtlMs });
			setBounded(fromLine, name, entry.since, HOLDERS_CAP);
			taken.push({ name, how: howFreed(name, peers, now, entry.since, releasedBy?.get(name)) });
			const previous = lastHolder.get(name);
			if (previous) handedBy.add(previous.id);
			lastHolder.delete(name);
		}
		if (taken.length === 0) return;
		if (me.queued?.length === 0) delete me.queued;
		// An agent queued for a lock often also declares it waits for the holder. The lock is what it
		// waited for: the wait ends here, as it would on a message from the holder. Left in place, it
		// read as a wait cycle the moment the holder queued behind this agent.
		const ended = (me.blockedOn ?? []).filter((id) => handedBy.has(id));
		if (ended.length > 0) dropWaits(me, ended);
		rt.publish();
		rt.updateStatus();
		// The log says who took a lock, not only who released it.
		for (const t of taken) rt.logEntry("claim", t.how === FREE ? `took ${t.name}, which was free` : `took ${t.name} after ${t.how}`, [t.name]);
		const heads = taken.map((t) => `**📡 ${t.name} is yours now (${t.how})**`).join("\n");
		const first = taken[0]?.name ?? "";
		const waits = ended.length > 0 ? ` Your wait on ${callsignsOf(ended, peers, me.id).join(", ")} ended with it.` : "";
		rt.inject(
			MESSAGE_TYPES.claim,
			`${heads}\n\nYou queued for it, so telecom claimed it for you.${waits} Release it as soon as you are done, since others may be in line: telecom({ action: "release", paths: ["${first}"] }). It stays yours while you are working; once you are idle, it lapses ${rt.claimTtlMinutes()} min after it became yours unless you claim it again.`,
			{ tone: "accent" },
			"wake",
		);
	}

	/**
	 * Give up the locks a rival took first. `read` must be records actually read, never the debounced
	 * team: a departing record still shows the claims it had, and a holder that released a lock and
	 * then left would otherwise take it back from the waiter it went to. With `tell`, the model
	 * already believes it holds them (a wake-up said so, or its claim's result did), so it is told,
	 * and the log says so; from a claim being made, the claim's result says it instead.
	 */
	function settle(me: Presence, read: readonly Presence[], tell: boolean): string[] {
		const now = Date.now();
		const others = rivals(me, read);
		const lost = lostRaces(me, others, now);
		if (lost.length === 0) return [];
		me.claims = me.claims.filter((c) => !lost.includes(c));
		const queued = me.queued ?? [];
		const news: string[] = [];
		for (const claim of lost) {
			const name = resourceKey(claim.pattern);
			// Back at the place it had: in line from when it queued (a lock it took from the line), or
			// from the moment it claimed, so ahead of anyone who queued behind the winner either way.
			const since = fromLine.get(name) ?? claim.since;
			fromLine.delete(name);
			if (!queued.some((q) => sameResource(q.pattern, name))) queued.push({ pattern: name, since });
			const winner = holdsOf(name, others, now)[0]?.peer.callsign ?? "another agent";
			news.push(`**📡 ${name} is not yours after all: ${winner} took it at the same moment, first**`);
			if (tell) rt.logEntry("release", `gave up ${name}: ${winner} took it first`, [name]);
		}
		me.queued = queued.slice(0, QUEUED_CAP);
		rt.publish();
		rt.updateStatus();
		const names = lost.map((c) => resourceKey(c.pattern));
		if (tell) {
			rt.inject(
				MESSAGE_TYPES.claim,
				`${news.join("\n")}\n\nStop any work that needs ${names.length === 1 ? "it" : "them"} until you hold ${names.length === 1 ? "it" : "them"} again. You are back at the front of the line, and are woken when ${names.length === 1 ? "it frees" : "each frees"}. If you no longer need ${names.length === 1 ? "it" : "them"}, leave the line: telecom({ action: "release", paths: [${names.map((n) => JSON.stringify(n)).join(", ")}] }).`,
				{ tone: "warning" },
				"passive",
			);
		}
		return names;
	}

	function dropWaits(me: Presence, ids: readonly string[]): void {
		me.blockedOn = (me.blockedOn ?? []).filter((id) => !ids.includes(id));
		if (me.blockedOn.length === 0) {
			delete me.blockedOn;
			delete me.blockedSince;
		}
		for (const id of ids) {
			seen.delete(id);
			heardAt.delete(id);
		}
		rt.publish();
	}

	/**
	 * A wait on a teammate it heard from ends when the agent gets to work afterwards: it got on
	 * with the work it waited to start. Merely reading the message, or going back to waiting (which
	 * it says by declaring the wait again), ends nothing. Judged on what its own record already
	 * holds (recent changes, claims, the long step), so no hook or bookkeeping beyond the time heard.
	 */
	function endHeardWaits(me: Presence): void {
		if (heardAt.size === 0) return;
		// Work is an edit, a new claim on files, or a long command (a gate or a build, which a
		// go-ahead often starts with no edit at all). Not a lock: one can be handed over while the
		// agent still waits for something else. Not a long telecom call: that is a blocking ask.
		const workedSince = (at: number) =>
			me.recent.some((r) => r.at >= at) ||
			me.claims.some((c) => !isResource(c.pattern) && c.since >= at) ||
			(me.step !== undefined && me.step.tool !== "telecom" && me.step.since >= at);
		const ended = [...heardAt].filter(([id, at]) => me.blockedOn?.includes(id) && workedSince(at)).map(([id]) => id);
		for (const id of [...heardAt.keys()]) if (!me.blockedOn?.includes(id)) heardAt.delete(id);
		if (ended.length > 0) dropWaits(me, ended);
	}

	function wakeDeclared(me: Presence, peers: readonly Presence[]): void {
		const waits = me.blockedOn ?? [];
		for (const id of [...seen.keys()]) if (!waits.includes(id)) seen.delete(id);
		if (waits.length === 0) return;
		const gone: string[] = [];
		const news: string[] = [];
		const stalls: string[] = [];
		let stalled: string | null = null;
		const at = Date.now();
		for (const id of waits) {
			const peer = peers.find((p) => p.id === id);
			const before = seen.get(id);
			if (!peer) {
				gone.push(id);
				news.push(`${before?.callsign ?? shortId(id)} left`);
				continue;
			}
			const now = { callsign: peer.callsign, state: peer.state, task: peer.task ?? "", since: before?.since ?? at, ...(before?.told ? { told: before.told } : {}) };
			const stall = stallNews(peer, now, at, peers, me.id);
			if (stall) {
				now.told = stall.key;
				stalls.push(stall.text);
				stalled ??= peer.callsign;
			}
			seen.set(id, now);
			if (!before) continue;
			if (before.state === "busy" && now.state === "idle") {
				news.push(`${now.callsign} finished its run${now.task ? ` (task: ${clip(now.task, TASK_SHOWN)})` : ""}`);
			}
			// A new task is not a wake-up: agents set status mid-run to report progress, and in a long
			// team session almost half the waiters woken by one went straight back to waiting. The
			// teammate is told who waits on it when it sets status, and messages them when it is done.
		}
		if (gone.length > 0) dropWaits(me, gone);
		if (stalls.length > 0) {
			rt.inject(
				MESSAGE_TYPES.message,
				`${stalls.map((n) => `**📡 ${n}**`).join("\n")}\n\nIt may never have got, or seen, what it needs to move. Nudge it: telecom({ action: "send", to: "${stalled}", message: "…" }). If it stays silent, tell your human; or go ahead without it and update your wait: telecom({ action: "status", message: "…" }).`,
				{ tone: "warning" },
				"wake",
			);
		}
		if (news.length === 0) return;
		const heads = news.map((n) => `**📡 ${n} — you were waiting for them**`).join("\n");
		const after = gone.length > 0 ? "Whoever left is off your waits. " : "";
		rt.inject(
			MESSAGE_TYPES.message,
			`${heads}\n\n${after}Carry on if this is what you were waiting for, and update your wait (or clear it): telecom({ action: "status", message: "…" }).`,
			{ tone: "accent" },
			"wake",
		);
	}

	/**
	 * A teammate this agent waits for that is not moving, once per stall: it has a message it never
	 * answered (its session may be stuck: `Presence.unreadSince`), or it has been idle
	 * `STALE_WAIT_BEATS` since the wait began. Null when it moves, or this stall was told.
	 */
	function stallNews(
		peer: Presence,
		entry: { since: number; told?: string },
		now: number,
		peers: readonly Presence[],
		viewerId: string,
	): { key: string; text: string } | null {
		if (peer.state !== "idle") return null;
		if (peer.unreadSince !== undefined) {
			const key = `unread ${peer.unreadSince}`;
			if (entry.told === key) return null;
			return { key, text: `${peer.callsign} has not acted on a message it got ${ago(peer.unreadSince, now)}, while you wait for it: its session may be stuck (telecom is re-waking it)` };
		}
		const idleFrom = Math.max(peer.stateSince ?? entry.since, entry.since);
		if (now - idleFrom < STALE_WAIT_BEATS * rt.cfg.heartbeatMs) return null;
		const key = `idle ${idleFrom}`;
		if (entry.told === key) return null;
		const theirs = peer.blockedOn?.length ? ` It says it waits for ${callsignsOf(peer.blockedOn, peers, viewerId).join(", ")}.` : "";
		return { key, text: `${peer.callsign} has been idle for ${elapsed(idleFrom, now)} while you wait for it.${theirs}` };
	}

	/** The cycle through this agent: its key, `alpha → bravo → alpha`, the next agent after this one
	 *  on it, and the records of everyone on it. */
	function onCycle(me: Presence, peers: readonly Presence[]): { key: string; names: string; next: string; members: Presence[] } | null {
		if (!me.blockedOn?.length) return null;
		const records = [me, ...rt.team(peers)];
		const cycle = declaredCycle(me.id, records);
		if (!cycle) return null;
		const names = callsignsOf(cycle, records, "");
		const members = [...new Set(cycle)].flatMap((id) => records.find((r) => r.id === id) ?? []);
		return { key: cycleKey(cycle), names: names.join(" → "), next: names[1] ?? "", members };
	}

	/**
	 * When the last of them went idle, if everyone on the cycle is idle and has been for
	 * `CYCLE_STALL_MS`; else null. A record without `stateSince` (an older telecom) cannot be judged
	 * stalled, so it never is: better silent than a notice about a cycle someone is working on.
	 */
	function stalledSince(members: readonly Presence[], now: number): number | null {
		let latest = 0;
		for (const m of members) {
			if (m.state !== "idle" || m.stateSince === undefined || now - m.stateSince < CYCLE_STALL_MS) return null;
			latest = Math.max(latest, m.stateSince);
		}
		return latest > 0 ? latest : null;
	}

	function flagCycle(me: Presence, peers: readonly Presence[]): void {
		const cycle = onCycle(me, peers);
		if (!cycle) {
			toldCycle = null;
			return;
		}
		const now = Date.now();
		const since = stalledSince(cycle.members, now);
		if (since === null) return;
		const key = `${cycle.key}@${since}`;
		if (key === toldCycle) return;
		toldCycle = key;
		// `wake`: the agent declared it waits for these teammates, and with all of them idle nothing
		// else will ever move (AGENTS.md, rule 8).
		rt.inject(
			MESSAGE_TYPES.message,
			`**📡 Wait cycle stalled: ${cycle.names}**\n\nEach of you declared it waits for the next, and everyone on it has been idle for ${elapsed(since, now)} or more, so nobody moves unless you do. Give ${cycle.next} what it needs, or go ahead without it: telecom({ action: "send", to: "${cycle.next}", message: "…", unblocks: true }). Then drop the wait: telecom({ action: "status", message: "…", waitingFor: [] }).`,
			{ tone: "warning" },
			"wake",
		);
	}

	return {
		refresh(present, read) {
			const me = rt.self;
			if (!me) return;
			// Solo work pays nothing (AGENTS.md, rule 2): no lock held, none awaited, no one awaited.
			if (!me.queued?.length && !me.blockedOn?.length && !me.claims.some((c) => isResource(c.pattern))) {
				lastSeen = [];
				toldCycle = null;
				seen.clear();
				heardAt.clear();
				fromLine.clear();
				return;
			}
			for (const name of [...fromLine.keys()]) if (!me.claims.some((c) => sameResource(c.pattern, name))) fromLine.delete(name);
			settle(me, read, true);
			takeFreeLocks(me, present);
			endHeardWaits(me);
			wakeDeclared(me, present);
			flagCycle(me, present);
			lastSeen = rivals(me, present);
		},

		released(fromId, fromCallsign, patterns, at) {
			const queued = rt.self?.queued ?? [];
			const mine = patterns.filter((p) => queued.some((q) => sameResource(q.pattern, p)));
			for (const p of mine) {
				const key = resourceKey(p);
				const before = releases.get(key);
				if (!before || at >= before.at) releases.set(key, { id: fromId, callsign: fromCallsign, at });
			}
			return mine;
		},

		afterDrain() {
			if (releases.size === 0) return;
			const batch = new Map(releases);
			releases.clear();
			const me = rt.self;
			if (!me) return;
			for (const [name, r] of batch) setBounded(lastHolder, name, { id: r.id, callsign: r.callsign }, HOLDERS_CAP);
			// The debounced team, read now: a waiter ahead of this agent whose record is missing from one
			// read keeps its place, and a holder that is only departing still holds the lock.
			takeFreeLocks(me, rt.presentNow(), new Map([...batch].map(([name, r]) => [name, r.callsign])));
		},

		heard(id, unblocks) {
			const me = rt.self;
			if (!me?.blockedOn?.includes(id)) return;
			if (unblocks) dropWaits(me, [id]);
			else heardAt.set(id, Date.now());
		},

		declare(peers) {
			const me = rt.self;
			seen.clear();
			// Declaring again, after hearing, is the agent saying it still waits.
			heardAt.clear();
			if (!me) return null;
			for (const id of me.blockedOn ?? []) {
				const peer = peers.find((p) => p.id === id);
				if (peer) seen.set(id, { callsign: peer.callsign, state: peer.state, task: peer.task ?? "", since: Date.now() });
			}
			// The stall notice (`flagCycle`) is told apart from this one: this agent is mid-run, and may
			// well resolve the cycle itself, so it only learns the fact now.
			const cycle = onCycle(me, peers);
			return cycle
				? `This closes a wait cycle: ${cycle.names}. It resolves only when one of you moves, and you are told if all of you sit idle: to move first, go ahead without ${cycle.next}, or tell them what you need: telecom({ action: "send", to: "${cycle.next}", message: "…", unblocks: true }).`
				: null;
		},

		settleRaces(read) {
			const me = rt.self;
			return me ? settle(me, read, false) : [];
		},

		clear() {
			releases.clear();
			lastSeen = [];
			lastHolder.clear();
			fromLine.clear();
			seen.clear();
			heardAt.clear();
			toldCycle = null;
		},
	};
}
