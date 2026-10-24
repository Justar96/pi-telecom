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
 *     it is woken when that teammate finishes a run, takes up a new task, or leaves (then the wait
 *     is dropped), and the wait ends when that teammate messages or answers it. Declared waits that
 *     form a cycle are pointed out, once, to each agent on it.
 *
 * The wake-ups use `wake` (wake-limited) although they carry no peer's words: the agent asked for
 * exactly this signal, the way an ask asks for its answer, so it is the reply to its own request,
 * not information pushed at it (AGENTS.md, rule 8). A cycle is information: `passive`.
 */
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { lineOf } from "./family.ts";
import { isResource, resourceKey, sameResource } from "./glob.ts";
import { callsignsOf, cycleKey, declaredCycle, holdsOf, lineFor, lostRaces } from "./locks.ts";
import { MESSAGE_TYPES } from "./render.ts";
import type { Runtime } from "./runtime.ts";
import { type Presence, QUEUED_CAP } from "./transport.ts";
import { clip, setBounded, shortId } from "./util.ts";

/** A teammate's task, as a wake-up quotes it. */
const TASK_SHOWN = 120;
/** Locks whose last holder is remembered, to say how each freed. */
const HOLDERS_CAP = 64;
/** How a lock freed when no holder was ever seen. */
const FREE = "it was free";

export interface Waiting {
	/** After a team refresh: settle lock races against `read` (this refresh's read), take a freed
	 *  lock when first in line, wake declared waits, and point out a wait cycle, all against
	 *  `present` (the debounced team). Costs nothing for an agent that holds and awaits nothing. */
	refresh(present: readonly Presence[], read: readonly Presence[]): void;
	/** A peer released `patterns`: take any of them this agent queues for, if first in line. Returns
	 *  those it queues for (the caller says nothing else about them). */
	released(fromId: string, fromCallsign: string, patterns: readonly string[]): string[];
	/** A peer messaged or answered this agent: a declared wait on it is over. */
	heard(id: string): void;
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
	/** How each teammate this agent waits for looked when last checked: a change is news. */
	const seen = new Map<string, { callsign: string; state: Presence["state"]; task: string }>();
	/** The wait cycle this agent was told it is on, told once while it lasts. */
	let toldCycle: string | null = null;

	/** Teammates whose locks bind this agent: its lineal family shares, like it shares claims. */
	function rivals(me: Presence, peers: readonly Presence[]): Presence[] {
		const family = lineOf(me, peers);
		return rt.team(peers).filter((p) => !family.has(p.id));
	}

	function howFreed(name: string, peers: readonly Presence[], now: number): string {
		const last = lastHolder.get(name);
		if (!last) return FREE;
		const holder = peers.find((p) => p.id === last.id);
		if (!holder) return `${last.callsign} left`;
		const claim = holder.claims.find((c) => sameResource(c.pattern, name));
		return claim && claim.expiresAt <= now ? `${last.callsign}'s claim on it expired` : `${last.callsign} released it`;
	}

	function takeFreeLocks(me: Presence, peers: readonly Presence[]): void {
		if (!me.queued?.length) return;
		const now = Date.now();
		const others = rivals(me, peers);
		const taken: Array<{ name: string; how: string }> = [];
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
			taken.push({ name, how: howFreed(name, peers, now) });
			lastHolder.delete(name);
		}
		if (taken.length === 0) return;
		if (me.queued?.length === 0) delete me.queued;
		rt.publish();
		rt.updateStatus();
		// The log says who took a lock, not only who released it.
		for (const t of taken) rt.logEntry("claim", t.how === FREE ? `took ${t.name}, which was free` : `took ${t.name} after ${t.how}`, [t.name]);
		const heads = taken.map((t) => `**📡 ${t.name} is yours now (${t.how})**`).join("\n");
		const first = taken[0]?.name ?? "";
		rt.inject(
			MESSAGE_TYPES.claim,
			`${heads}\n\nYou queued for it, so telecom claimed it for you. Release it as soon as you are done, since others may be in line: telecom({ action: "release", paths: ["${first}"] }). Edits do not renew a lock: claim it again within ${rt.claimTtlMinutes()} min if you need it longer.`,
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
		if (me.blockedOn.length === 0) delete me.blockedOn;
		for (const id of ids) seen.delete(id);
		rt.publish();
	}

	function wakeDeclared(me: Presence, peers: readonly Presence[]): void {
		const waits = me.blockedOn ?? [];
		for (const id of [...seen.keys()]) if (!waits.includes(id)) seen.delete(id);
		if (waits.length === 0) return;
		const gone: string[] = [];
		const news: string[] = [];
		for (const id of waits) {
			const peer = peers.find((p) => p.id === id);
			const before = seen.get(id);
			if (!peer) {
				gone.push(id);
				news.push(`${before?.callsign ?? shortId(id)} left`);
				continue;
			}
			const now = { callsign: peer.callsign, state: peer.state, task: peer.task ?? "" };
			seen.set(id, now);
			if (!before) continue;
			if (before.state === "busy" && now.state === "idle") {
				news.push(`${now.callsign} finished its run${now.task ? ` (task: ${clip(now.task, TASK_SHOWN)})` : ""}`);
			} else if (now.task && now.task !== before.task) {
				news.push(`${now.callsign} is now on: ${clip(now.task, TASK_SHOWN)}`);
			}
		}
		if (gone.length > 0) dropWaits(me, gone);
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

	/** `alpha → bravo → alpha`, and the next agent after this one on the cycle. */
	function describeCycle(cycle: readonly string[], records: readonly Presence[]): { names: string; next: string } {
		const names = callsignsOf(cycle, records, "");
		return { names: names.join(" → "), next: names[1] ?? "" };
	}

	function onCycle(me: Presence, peers: readonly Presence[]): { key: string; names: string; next: string } | null {
		if (!me.blockedOn?.length) return null;
		const records = [me, ...rt.team(peers)];
		const cycle = declaredCycle(me.id, records);
		return cycle ? { key: cycleKey(cycle), ...describeCycle(cycle, records) } : null;
	}

	function flagCycle(me: Presence, peers: readonly Presence[]): void {
		const cycle = onCycle(me, peers);
		if (!cycle) {
			toldCycle = null;
			return;
		}
		if (cycle.key === toldCycle) return;
		toldCycle = cycle.key;
		rt.inject(
			MESSAGE_TYPES.message,
			`**📡 Wait cycle: ${cycle.names}**\n\nEach of you declared it waits for the next, so nobody on it moves until one of you does. Go ahead without ${cycle.next}, or tell them what you need: telecom({ action: "send", to: "${cycle.next}", message: "…" }). Then update your wait: telecom({ action: "status", message: "…" }).`,
			{ tone: "warning" },
			"passive",
		);
	}

	return {
		refresh(present, read) {
			const me = rt.self;
			if (!me) return;
			// Solo work pays nothing (AGENTS.md, rule 2): no lock held, none awaited, no one awaited.
			if (!me.queued?.length && !me.blockedOn?.length && !me.claims.some((c) => isResource(c.pattern))) {
				toldCycle = null;
				seen.clear();
				fromLine.clear();
				return;
			}
			for (const name of [...fromLine.keys()]) if (!me.claims.some((c) => sameResource(c.pattern, name))) fromLine.delete(name);
			settle(me, read, true);
			takeFreeLocks(me, present);
			wakeDeclared(me, present);
			flagCycle(me, present);
		},

		released(fromId, fromCallsign, patterns) {
			const me = rt.self;
			const queued = me?.queued ?? [];
			const mine = patterns.filter((p) => queued.some((q) => sameResource(q.pattern, p)));
			if (!me || mine.length === 0) return [];
			for (const p of mine) setBounded(lastHolder, resourceKey(p), { id: fromId, callsign: fromCallsign }, HOLDERS_CAP);
			// The debounced team, read now: a waiter ahead of this agent whose record is missing from one
			// read keeps its place, and a holder that is only departing still holds the lock.
			takeFreeLocks(me, rt.presentNow());
			return mine;
		},

		heard(id) {
			const me = rt.self;
			if (me?.blockedOn?.includes(id)) dropWaits(me, [id]);
		},

		declare(peers) {
			const me = rt.self;
			seen.clear();
			if (!me) return null;
			for (const id of me.blockedOn ?? []) {
				const peer = peers.find((p) => p.id === id);
				if (peer) seen.set(id, { callsign: peer.callsign, state: peer.state, task: peer.task ?? "" });
			}
			const cycle = onCycle(me, peers);
			toldCycle = cycle?.key ?? null;
			return cycle
				? `⚠ This closes a wait cycle: ${cycle.names}. Nobody on it moves until one of you does: go ahead without ${cycle.next}, or tell them what you need: telecom({ action: "send", to: "${cycle.next}", message: "…" }).`
				: null;
		},

		settleRaces(read) {
			const me = rt.self;
			return me ? settle(me, read, false) : [];
		},

		clear() {
			lastHolder.clear();
			fromLine.clear();
			seen.clear();
			toldCycle = null;
		},
	};
}
