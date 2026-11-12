/**
 * callsign — a short, speakable, unique handle per agent in a project.
 *
 * Session ids are UUIDs; models and humans address each other far more reliably as "bravo".
 * A session takes the first NATO word no live peer in its project holds. Two sessions that start
 * in the same instant can pick the same word; the younger one notices on its next tick and moves
 * to the next free word, so the set converges without a lock.
 *
 * Callsigns are unique across a repository, not just a checkout: agents in sibling worktrees are
 * one team. A subagent is named after its parent (`alpha-1`, `alpha-2`), so a family reads as one
 * at a glance and children never use up the words top-level sessions start with.
 *
 * A session keeps its callsign over a resume, also when a session newer than its last run holds
 * the word: every `pi` starts in a new session, which takes the first free word before the human
 * resumes the one they came for. Such a session holds its word only for now and gives it back.
 */
import { sameRepo } from "./project.ts";
import type { Presence } from "./transport.ts";

export const NATO = [
	"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
	"juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo",
	"sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu",
] as const;

export const CALLSIGN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The first free callsign, preferring `wanted` (a persisted or configured one) when free. */
export function pickCallsign(taken: ReadonlySet<string>, wanted?: string): string {
	if (wanted && !taken.has(wanted)) return wanted;
	for (const word of NATO) if (!taken.has(word)) return word;
	for (let n = 2; ; n++) {
		for (const word of NATO) {
			const candidate = `${word}${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}

/** Longest stem of a child callsign: room for `-` and a five-digit number within 32 characters. */
const CHILD_STEM_CAP = 26;

/** The first free callsign for a subagent of `parent`: `alpha-1`, `alpha-2`, … */
export function childCallsign(parent: string, taken: ReadonlySet<string>): string {
	const stem = parent.slice(0, CHILD_STEM_CAP);
	for (let n = 1; ; n++) {
		const candidate = `${stem}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Does this session have to give its callsign up? Yes when a live peer in the same repository
 * holds the same one and keeps it (`keepsOver`).
 */
export function mustYield(self: Presence, peers: readonly Presence[]): boolean {
	return peers.some((peer) => peer.id !== self.id && sameRepo(peer, self) && peer.callsign === self.callsign && keepsOver(peer, self));
}

/**
 * Of two sessions holding one callsign, does `peer` keep it? A session in which nothing has run
 * yet gives way to one that has: the team knows the latter by that word, and a resumed session
 * always starts after the new session that took its word meanwhile. Only between two records
 * that both say which they are (`Presence.provisional`): an older telecom judges by age alone,
 * and both sides must reach the same verdict or both would move, or neither. Otherwise the older
 * session keeps it (started first; the session id breaks a tie).
 */
function keepsOver(peer: Presence, self: Presence): boolean {
	if (peer.provisional !== undefined && self.provisional !== undefined && peer.provisional !== self.provisional) return self.provisional;
	return peer.startedAt < self.startedAt || (peer.startedAt === self.startedAt && peer.id < self.id);
}

/**
 * May a session that has run before take `wanted` although a peer holds it? Yes when every
 * holder holds it only for now (`Presence.provisional`): they move on their next refresh
 * (`mustYield`). A record that does not say (an older telecom) holds it firmly.
 */
export function reclaimable(wanted: string, mates: readonly Presence[]): boolean {
	const holders = mates.filter((p) => p.callsign === wanted);
	return holders.length > 0 && holders.every((p) => p.provisional === true);
}
