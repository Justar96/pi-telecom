/**
 * ledger — the asks this agent is blocked on, and the asks it owes an answer to.
 *
 * Derived from @tinoy/pi-ipc `poller.ts` (MIT). Additions:
 *   - an outbound ask is INTERRUPTED when an inbound ask arrives while it waits. Two agents that
 *     ask each other at the same moment would otherwise both sit blocked inside a tool call,
 *     unable to see the other's question until a timeout; interrupting hands the inbound question
 *     to the model now, and the original ask stays answerable (its answer arrives as a message);
 *   - an outbound ask fails at once when the peer it waits on goes away;
 *   - asks that stopped waiting are remembered, so a late answer reads as "late reply to your
 *     ask" instead of an unexplained message.
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
}

export type AskOutcome =
	| { ok: true; text: string; fromCallsign: string }
	| { ok: false; reason: string; interruptedBy?: InboundAsk; aborted?: boolean };

interface PendingAsk {
	to: string;
	toCallsign: string;
	text: string;
	deadline: number;
	timeoutMs: number;
	settle(outcome: AskOutcome): void;
}

export interface AskLedger {
	noteInbound(ask: Omit<InboundAsk, "reminded">): void;
	/** Drop the inbound ask a reply answers; `null` when the handle is unknown. */
	resolveInbound(askId: string): InboundAsk | null;
	inbound(): InboundAsk[];
	/** Forget inbound asks from sessions that are gone: nobody is waiting on them any more. */
	dropInboundFrom(sessionIds: ReadonlySet<string>): InboundAsk[];
	awaitAnswer(
		askId: string,
		meta: { to: string; toCallsign: string; text: string },
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AskOutcome>;
	/** Complete the waiting ask an answer names. False when no ask is waiting on it. */
	settle(answerTo: string, text: string, fromCallsign: string): boolean;
	/** True when `askId` was ours but stopped waiting (timed out, interrupted, aborted). */
	wasAbandoned(askId: string): { toCallsign: string; text: string } | null;
	abandon(askId: string, reason: string): void;
	interruptAll(by: InboundAsk): void;
	failPeerGone(isGone: (sessionId: string) => boolean): void;
	expire(now: number): void;
	outboundCount(): number;
}

const ABANDONED_CAP = 64;

export function createAskLedger(): AskLedger {
	const inbound = new Map<string, InboundAsk>();
	const outbound = new Map<string, PendingAsk>();
	const abandoned = new Map<string, { toCallsign: string; text: string }>();

	function stop(id: string, outcome: AskOutcome & { ok: false }): void {
		const pending = outbound.get(id);
		if (!pending) return;
		setBounded(abandoned, id, { toCallsign: pending.toCallsign, text: pending.text }, ABANDONED_CAP);
		pending.settle(outcome);
	}

	return {
		noteInbound(ask) {
			inbound.set(ask.id, { ...ask, reminded: false });
		},

		resolveInbound(askId) {
			const found = inbound.get(askId) ?? null;
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

		awaitAnswer(askId, meta, timeoutMs, signal) {
			return new Promise<AskOutcome>((resolve) => {
				let done = false;
				const finish = (outcome: AskOutcome) => {
					if (done) return;
					done = true;
					outbound.delete(askId);
					signal?.removeEventListener("abort", onAbort);
					resolve(outcome);
				};
				const onAbort = () =>
					stop(askId, { ok: false, reason: "the ask was abandoned: the tool call was aborted", aborted: true });
				outbound.set(askId, {
					...meta,
					deadline: Date.now() + timeoutMs,
					timeoutMs,
					settle: finish,
				});
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},

		settle(answerTo, text, fromCallsign) {
			const pending = outbound.get(answerTo);
			if (!pending) return false;
			pending.settle({ ok: true, text, fromCallsign });
			return true;
		},

		wasAbandoned(askId) {
			const found = abandoned.get(askId) ?? null;
			if (found) abandoned.delete(askId);
			return found;
		},

		abandon(askId, reason) {
			stop(askId, { ok: false, reason });
		},

		interruptAll(by) {
			for (const [id, pending] of [...outbound]) {
				stop(id, {
					ok: false,
					reason: `interrupted while waiting for ${pending.toCallsign}: ${by.fromCallsign} is asking you something (handle ${by.id}). ${pending.toCallsign}'s answer, when it comes, will arrive as a message.`,
					interruptedBy: by,
				});
			}
		},

		failPeerGone(isGone) {
			for (const [id, pending] of [...outbound]) {
				if (!isGone(pending.to)) continue;
				stop(id, {
					ok: false,
					reason: `${pending.toCallsign}'s session ended before it answered`,
				});
			}
		},

		expire(now) {
			for (const [id, pending] of [...outbound]) {
				if (pending.deadline > now) continue;
				stop(id, {
					ok: false,
					reason: `${pending.toCallsign} did not answer within ${Math.round(pending.timeoutMs / 1000)}s. If they answer later, the reply arrives as a message — carry on with other work meanwhile.`,
				});
			}
		},

		outboundCount() {
			return outbound.size;
		},
	};
}
