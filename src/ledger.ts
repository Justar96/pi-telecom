/**
 * ledger — the asks this agent sent and is owed an answer to, and the asks it owes an answer.
 *
 * Derived from @tinoy/pi-ipc `poller.ts` (MIT), without its blocking wait. An ask never blocks:
 * it is delivered, the call returns, and the answer arrives as a message that wakes the asker.
 * Over a day of a nine-agent team only two asks in a thousand messages waited for their answer,
 * and the wait needed a wait-for graph, cycle detection, interrupts, messages held back from the
 * model, and a refusal for asks through foreground subagents. None of that can deadlock now.
 *
 *   - an open ask expires after its timeout, or when its peer leaves: the caller tells the asker,
 *     and an answer after that still arrives, as a reply to that ask;
 *   - asks it owes are kept until answered, withdrawn, or their asker leaves.
 *
 * Older telecoms still send asks without `async: true` and block on them: those are listed as
 * owed like any other, and the inbound text says the asker is blocked.
 */
import { setBounded } from "./util.ts";

export interface InboundAsk {
	id: string;
	from: string;
	fromCallsign: string;
	text: string;
	at: number;
	/** Whether the settle reminder has already nudged the model about it. */
	reminded: boolean;
	/** The asker is not waiting: every ask from this version, and `wait: false` from older ones. */
	async?: true;
}

/** An ask this agent sent that is still open. Parked over a `/reload` as it is (`asyncOpen`). */
export interface AsyncAsk {
	to: string;
	toCallsign: string;
	text: string;
	deadline: number;
	timeoutMs: number;
}

/** An open ask that ended without an answer, for the caller to tell the asker about. */
export interface EndedAsync {
	id: string;
	to: string;
	toCallsign: string;
	text: string;
	timeoutMs: number;
}

/** What an answer needs to name the ask it answers. `to` is absent only in a handoff written by
 *  an older runtime. */
export interface LateAsk {
	to?: string;
	toCallsign: string;
	text: string;
}

export interface AskLedger {
	noteInbound(ask: Omit<InboundAsk, "reminded">): void;
	/** Drop the inbound ask a reply answers; `null` when the handle is unknown. */
	resolveInbound(askId: string, from?: string): InboundAsk | null;
	inbound(): InboundAsk[];
	/** Forget inbound asks from sessions that are gone: nobody is waiting on them any more. */
	dropInboundFrom(sessionIds: ReadonlySet<string>): InboundAsk[];
	/** Track an ask just delivered: its answer arrives as a message. */
	track(askId: string, meta: { to: string; toCallsign: string; text: string }, timeoutMs: number): void;
	/** The ask `askId` named, when it was ours and `from` is whom it went to: open, or ended
	 *  without an answer. Taken: a second answer to it reads as a plain reply. */
	answered(askId: string, from: string): LateAsk | null;
	/** End every open ask when this runtime disconnects; returns them, for withdrawal. */
	abandonAll(): Array<{ id: string; to: string }>;
	/** End the asks whose peer is gone. */
	failPeerGone(isGone: (sessionId: string) => boolean): EndedAsync[];
	/** End the asks past their deadline. */
	expire(now: number): EndedAsync[];
	/** Asks that ended without an answer: kept over a `/reload`, so their answers still name them. */
	lateCandidates(): Array<[string, LateAsk]>;
	restoreAbandoned(entries: ReadonlyArray<[string, LateAsk]>): void;
	/** Open asks, deadlines included: kept over a `/reload`, so each still expires with its "did
	 *  not answer" notice in the replacement runtime. */
	asyncOpen(): Array<[string, AsyncAsk]>;
	/** Take over the open asks a previous runtime of this session parked (`asyncOpen`). */
	restoreAsync(entries: ReadonlyArray<[string, AsyncAsk]>): void;
}

const ABANDONED_CAP = 64;
/** Inbound asks kept at once. Each is a peer's question and is listed on the board, so a flood
 *  of them must not grow without limit; the oldest gives way (its asker times out). */
const INBOUND_CAP = 64;
/** Open outbound asks kept at once; the oldest gives way (its answer reads as a plain reply). */
const OPEN_CAP = 64;

export function createAskLedger(): AskLedger {
	const inbound = new Map<string, InboundAsk>();
	const open = new Map<string, AsyncAsk>();
	const abandoned = new Map<string, LateAsk>();

	/** End an open ask without an answer; a later answer still reads as a reply to it. */
	function end(id: string, ask: AsyncAsk): EndedAsync {
		open.delete(id);
		setBounded(abandoned, id, { to: ask.to, toCallsign: ask.toCallsign, text: ask.text }, ABANDONED_CAP);
		return { id, to: ask.to, toCallsign: ask.toCallsign, text: ask.text, timeoutMs: ask.timeoutMs };
	}

	return {
		noteInbound(ask) {
			setBounded(inbound, ask.id, { ...ask, reminded: false }, INBOUND_CAP);
		},

		resolveInbound(askId, from) {
			const found = inbound.get(askId) ?? null;
			if (from !== undefined && found?.from !== from) return null;
			if (found) inbound.delete(askId);
			return found;
		},

		inbound() {
			return [...inbound.values()].sort((a, b) => a.at - b.at);
		},

		dropInboundFrom(sessionIds) {
			const dropped: InboundAsk[] = [];
			for (const [id, ask] of inbound) {
				if (!sessionIds.has(ask.from)) continue;
				inbound.delete(id);
				dropped.push(ask);
			}
			return dropped;
		},

		track(askId, meta, timeoutMs) {
			// Over the cap the oldest ends as if expired, unannounced: its answer still names it.
			const oldest = open.size >= OPEN_CAP ? [...open][0] : undefined;
			if (oldest) end(...oldest);
			open.set(askId, { ...meta, deadline: Date.now() + timeoutMs, timeoutMs });
		},

		answered(askId, from) {
			const ask = open.get(askId);
			if (ask) {
				if (ask.to !== from) return null;
				open.delete(askId);
				return { to: ask.to, toCallsign: ask.toCallsign, text: ask.text };
			}
			const found = abandoned.get(askId) ?? null;
			if (found?.to !== undefined && found.to !== from) return null;
			if (found) abandoned.delete(askId);
			return found;
		},

		abandonAll() {
			return [...open].map(([id, ask]) => {
				end(id, ask);
				return { id, to: ask.to };
			});
		},

		failPeerGone(isGone) {
			return [...open].filter(([, ask]) => isGone(ask.to)).map(([id, ask]) => end(id, ask));
		},

		expire(now) {
			return [...open].filter(([, ask]) => ask.deadline <= now).map(([id, ask]) => end(id, ask));
		},

		lateCandidates() {
			return [...abandoned.entries()];
		},

		restoreAbandoned(entries) {
			for (const [id, ask] of entries) setBounded(abandoned, id, ask, ABANDONED_CAP);
		},

		asyncOpen() {
			return [...open.entries()].map(([id, a]): [string, AsyncAsk] => [id, { ...a }]);
		},

		restoreAsync(entries) {
			for (const entry of entries) {
				// Parked by this same process (`takeReloadHandoff` checks the pid), but a file all the
				// same: a malformed entry is skipped rather than trusted.
				if (!Array.isArray(entry)) continue;
				const [id, a] = entry as [unknown, Partial<AsyncAsk> | null];
				if (typeof id !== "string" || !a || typeof a.to !== "string" || typeof a.toCallsign !== "string" || typeof a.text !== "string") continue;
				if (!Number.isFinite(a.deadline) || !Number.isFinite(a.timeoutMs)) continue;
				if (!open.has(id) && open.size >= OPEN_CAP) continue;
				open.set(id, { to: a.to, toCallsign: a.toCallsign, text: a.text, deadline: a.deadline as number, timeoutMs: a.timeoutMs as number });
			}
		},
	};
}
