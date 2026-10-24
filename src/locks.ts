/**
 * locks — named resource locks (`@cargo`) and declared waits, as pure decisions over presence
 * records: who holds a lock and who is next in line for it, which of two sessions that took the
 * same free lock at once keeps it, and whether declared waits (`blockedOn`) close a cycle. The
 * `waiting` part acts on these; the board and briefs show them.
 *
 * A lock is a claim whose pattern is a resource (`glob.ts`, `isResource`). It is the repository's,
 * not a checkout's, so unlike a path claim it binds across lanes. Its line is published by the
 * waiters themselves (`queued`), so no one has to hand it over: when it frees, the first live
 * waiter takes it.
 */
import { isResource, isResourceName, resourceKey, sameResource } from "./glob.ts";
import type { Claim, Presence } from "./transport.ts";
import { shortId } from "./util.ts";

/** Wait chains are short; this bounds a walk over hostile records. */
const MAX_CYCLE_DEPTH = 16;
/** The board flags at most this many wait cycles. */
const CYCLES_SHOWN = 4;

/** A live claim on a lock, and the session holding it. */
export interface Hold {
	peer: Presence;
	claim: Claim;
}

/** A session's place in the line for a lock. */
export interface InLine {
	peer: Presence;
	since: number;
}

/** Earlier first; at the same instant, the lower session id. Every session orders alike. */
function first(aSince: number, aId: string, bSince: number, bId: string): number {
	return aSince - bSince || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

/** The live holds on `resource` among `records`, the rightful holder (earliest claim) first. */
export function holdsOf(resource: string, records: readonly Presence[], now: number): Hold[] {
	const holds: Hold[] = [];
	for (const peer of records) {
		for (const claim of peer.claims) {
			if (claim.expiresAt > now && sameResource(claim.pattern, resource)) holds.push({ peer, claim });
		}
	}
	return holds.sort((a, b) => first(a.claim.since, a.peer.id, b.claim.since, b.peer.id));
}

/** The line for `resource` among `records`, first in line first. */
export function lineFor(resource: string, records: readonly Presence[]): InLine[] {
	const line: InLine[] = [];
	for (const peer of records) {
		const entry = peer.queued?.find((q) => sameResource(q.pattern, resource));
		if (entry) line.push({ peer, since: entry.since });
	}
	return line.sort((a, b) => first(a.since, a.peer.id, b.since, b.peer.id));
}

/**
 * The locks `me` holds that a rival took first. Two sessions that see a lock free at the same
 * moment both take it; each then sees the other's claim, and both settle on the same winner: the
 * earlier claim, then the lower id. The loser goes back in line.
 */
export function lostRaces(me: Presence, rivals: readonly Presence[], now: number): Claim[] {
	return me.claims.filter(
		(mine) =>
			isResource(mine.pattern) &&
			mine.expiresAt > now &&
			holdsOf(mine.pattern, rivals, now).some((h) => first(h.claim.since, h.peer.id, mine.since, me.id) < 0),
	);
}

/**
 * A cycle of declared waits through `startId`: the ids from `startId` round to it again, or null.
 * Nobody on such a cycle moves until one of them does, which is worth telling them.
 */
export function declaredCycle(startId: string, records: readonly Presence[]): string[] | null {
	const byId = new Map(records.map((r) => [r.id, r]));
	const path = [startId];
	// A node explored without reaching the start never will: one visit each bounds the walk.
	const explored = new Set<string>([startId]);
	const walk = (id: string, depth: number): string[] | null => {
		for (const next of byId.get(id)?.blockedOn ?? []) {
			if (next === startId) return [...path, startId];
			if (explored.has(next) || depth >= MAX_CYCLE_DEPTH || !byId.has(next)) continue;
			explored.add(next);
			path.push(next);
			const found = walk(next, depth + 1);
			if (found) return found;
			path.pop();
		}
		return null;
	};
	return walk(startId, 0);
}

/** The cycles of declared waits among `records`, each once. */
export function declaredCycles(records: readonly Presence[]): string[][] {
	const keys = new Set<string>();
	const cycles: string[][] = [];
	for (const r of records) {
		if (!r.blockedOn?.length) continue;
		const cycle = declaredCycle(r.id, records);
		if (!cycle) continue;
		const key = cycleKey(cycle);
		if (keys.has(key)) continue;
		keys.add(key);
		cycles.push(cycle);
		if (cycles.length >= CYCLES_SHOWN) break;
	}
	return cycles;
}

/** One key per cycle, wherever it is entered. */
export function cycleKey(cycle: readonly string[]): string {
	return [...new Set(cycle)].sort().join("\u0000");
}

/** Callsigns for session ids: "you" for the viewer, the short id for a session that is gone. */
export function callsignsOf(ids: readonly string[], records: readonly Presence[], viewerId: string): string[] {
	return ids.map((id) => (id === viewerId ? "you" : (records.find((r) => r.id === id)?.callsign ?? shortId(id))));
}

/**
 * Each lock in use among `records`, as the board lists it: `@cargo — charlie (queue: echo, bravo)`.
 * A lock with a line and no holder is about to be taken by the first in it.
 */
export function lockLines(records: readonly Presence[], viewerId: string, now: number): string[] {
	const names = new Set<string>();
	for (const r of records) {
		// A peer's claim pattern is any one line it wrote: only a well-formed name is listed as a lock.
		for (const c of r.claims) if (c.expiresAt > now && isResourceName(resourceKey(c.pattern))) names.add(resourceKey(c.pattern));
		for (const q of r.queued ?? []) names.add(resourceKey(q.pattern));
	}
	return [...names].sort().map((name) => {
		const holders = holdsOf(name, records, now).map((h) => (h.peer.id === viewerId ? "you" : h.peer.callsign));
		const line = lineFor(name, records).map((w) => (w.peer.id === viewerId ? "you" : w.peer.callsign));
		return `${name} — ${holders.length > 0 ? [...new Set(holders)].join(", ") : "free"}${line.length > 0 ? ` (queue: ${line.join(", ")})` : ""}`;
	});
}
