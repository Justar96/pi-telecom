/**
 * callsign — a short, speakable, unique handle per agent in a project.
 *
 * Session ids are UUIDs; models and humans address each other far more reliably as "bravo".
 * A session takes the first NATO word no live peer in its project holds. Two sessions that start
 * in the same instant can pick the same word; the younger one notices on its next tick and moves
 * to the next free word, so the set converges without a lock.
 */
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

/**
 * Does this session have to give its callsign up? Yes when an OLDER live peer in the same project
 * holds the same one (older = started first; the session id breaks a tie).
 */
export function mustYield(self: Presence, peers: readonly Presence[]): boolean {
	return peers.some(
		(peer) =>
			peer.id !== self.id &&
			peer.projectRoot === self.projectRoot &&
			peer.callsign === self.callsign &&
			(peer.startedAt < self.startedAt || (peer.startedAt === self.startedAt && peer.id < self.id)),
	);
}
