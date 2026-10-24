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
 *     ask" instead of an unexplained message;
 *   - a message from the peer an ask waits on is HELD with that ask. The answer comes back as the
 *     ask's tool result, which the model reads before anything steered in meanwhile, so a message
 *     the peer sent before answering would otherwise be read after the answer it led up to. An
 *     answered ask shows its held messages first; an ask that ends any other way hands them back
 *     to be delivered as usual;
 *   - an ask that does not block (`wait: false`) is tracked apart from the waits: it publishes no
 *     wait-for edge, nothing interrupts it, and its answer arrives as a message.
 *
 * With more than two agents, interrupting on EVERY inbound ask breaks up waits that could never
 * deadlock (A waits on B; C asks A: B will still answer). So each agent publishes whom it waits
 * on, and an inbound ask interrupts only when it closes a cycle (`closesCycle`).
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
	/** The asker is not waiting (`wait: false`): it gets the reply whenever it is sent. */
	async?: true;
}

/** A peer's message held while an ask to that peer waits (see the module header). */
export interface HeldMessage {
	id: string;
	from: string;
	fromCallsign: string;
	text: string;
	/** A human typed it (`/telecom msg`), not the model. */
	human?: true;
}

/**
 * How a blocking ask ended. `held` is what its peer sent before answering, in send order: shown
 * ahead of the answer, or, when no answer came, for the caller to deliver as usual.
 */
export type AskOutcome =
	| { ok: true; text: string; fromCallsign: string; held: HeldMessage[] }
	| { ok: false; reason: string; interruptedBy?: InboundAsk; aborted?: boolean; held: HeldMessage[] };

interface PendingAsk {
	to: string;
	toCallsign: string;
	text: string;
	since: number;
	deadline: number;
	timeoutMs: number;
	held: HeldMessage[];
	settle(outcome: AskOutcome): void;
}

/** An ask that does not block: nothing waits on it, so it needs no `settle`. */
export interface AsyncAsk {
	to: string;
	toCallsign: string;
	text: string;
	deadline: number;
	timeoutMs: number;
}

/** An async ask that ended without an answer, for the caller to tell the asker about. */
export interface EndedAsync {
	id: string;
	to: string;
	toCallsign: string;
	text: string;
	timeoutMs: number;
}

/** `to` is absent only in a handoff written by an older runtime. */
export interface LateAsk {
	to?: string;
	toCallsign: string;
	text: string;
	/** It never blocked (`wait: false`), so its answer is not late, only a reply. */
	async?: true;
}

export interface AskLedger {
	noteInbound(ask: Omit<InboundAsk, "reminded">): void;
	/** Drop the inbound ask a reply answers; `null` when the handle is unknown. */
	resolveInbound(askId: string, from?: string): InboundAsk | null;
	inbound(): InboundAsk[];
	/** Forget inbound asks from sessions that are gone: nobody is waiting on them any more. */
	dropInboundFrom(sessionIds: ReadonlySet<string>): InboundAsk[];
	awaitAnswer(
		askId: string,
		meta: { to: string; toCallsign: string; text: string },
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AskOutcome>;
	/** Track an ask that does not block (`wait: false`): its answer arrives as a message. */
	trackAsync(askId: string, meta: { to: string; toCallsign: string; text: string }, timeoutMs: number): void;
	/** Complete the waiting ask an answer names. False when no ask is waiting on it. */
	settle(answerTo: string, text: string, fromCallsign: string, from: string): boolean;
	/** Hold a message from a peer a blocking ask waits on; false when no ask waits on its sender. */
	hold(message: HeldMessage): boolean;
	/** The ask `askId` named, when it was ours and stopped waiting (timed out, interrupted,
	 *  aborted) or never blocked (`wait: false`): its answer is delivered as a message. */
	wasAbandoned(askId: string, from: string): LateAsk | null;
	abandon(askId: string, reason: string): void;
	/** End every local wait, and every async ask, when this runtime disconnects. */
	abandonAll(reason: string): Array<{ id: string; to: string }>;
	interruptAll(by: InboundAsk): void;
	/** Fail the asks whose peer is gone; returns the async ones, which have no caller to tell. */
	failPeerGone(isGone: (sessionId: string) => boolean): EndedAsync[];
	/** Time out the asks past their deadline; returns the async ones, which have no caller to tell. */
	expire(now: number): EndedAsync[];
	/** Blocking asks only: an async ask waits on nobody. */
	outboundCount(): number;
	/** Asks whose answer would now arrive late (abandoned, or still waiting): kept over a `/reload`.
	 *  Open async asks are not late yet, and go with `asyncOpen`. */
	lateCandidates(): Array<[string, LateAsk]>;
	restoreAbandoned(entries: ReadonlyArray<[string, LateAsk]>): void;
	/** Async asks still open, deadlines included: kept over a `/reload`, so each still expires with
	 *  its "did not answer" notice in the replacement runtime. */
	asyncOpen(): Array<[string, AsyncAsk]>;
	/** Take over the async asks a previous runtime of this session parked (`asyncOpen`). */
	restoreAsync(entries: ReadonlyArray<[string, AsyncAsk]>): void;
	/** The sessions outbound asks are waiting on, and when the oldest wait began. */
	waits(): { on: string[]; since?: number };
}

/** What the wait-for graph needs from a presence record. */
export interface WaitNode {
	id: string;
	pid: number;
	state: "idle" | "busy";
	parent?: string;
	waitingOn?: string[];
}

/** Wait chains are short; this bounds a walk over hostile records. */
const MAX_WAIT_DEPTH = 32;
/**
 * At most this many waits are published per session. A list this long may have been cut, so the
 * graph past it is unknown (never "no cycle": a missing edge could be the one closing it).
 */
export const WAITS_CAP = 8;

/** Does `node` publish its whole wait list? Absent (an older telecom) or at the cap (maybe cut) is unknown. */
function waitsKnown(node: WaitNode): node is WaitNode & { waitingOn: string[] } {
	return node.waitingOn !== undefined && node.waitingOn.length < WAITS_CAP;
}

/** Index foreground children once per walk instead of scanning all peers for every edge. */
function waitGraph(start: WaitNode, peers: readonly WaitNode[]): Map<string, { node: WaitNode; edges: string[] }> {
	const graph = new Map([...peers, start].map((node) => [node.id, { node, edges: [...(node.waitingOn ?? [])] }]));
	for (const { node } of graph.values()) {
		const parent = node.parent ? graph.get(node.parent) : undefined;
		if (parent && node.pid === parent.node.pid && node.state === "busy") parent.edges.push(node.id);
	}
	return graph;
}

/**
 * Would `askerId`'s ask to `self` close a wait cycle? The ask makes the asker wait on `self`, so
 * it closes one exactly when `self` already waits, directly or through others, on the asker. Then
 * `self` must stop waiting and answer, or every agent on the cycle waits until its timeout. A
 * session blocked on a busy foreground subagent (one running in its own process) waits on it too,
 * though no ask says so. `null` when a session on the way publishes no waits (an older telecom):
 * the graph cannot be known, so the caller interrupts.
 */
export function closesCycle(askerId: string, self: WaitNode, peers: readonly WaitNode[]): boolean | null {
	const graph = waitGraph(self, peers);
	// An asker whose record no longer waits on us has stopped waiting (it was interrupted itself,
	// or gave up): its ask closes nothing, and our wait can go on.
	const asker = graph.get(askerId)?.node;
	if (asker && waitsKnown(asker) && !asker.waitingOn.includes(self.id)) return false;
	const seen = new Set<string>([self.id]);
	let unknown = !waitsKnown(self);
	let frontier = graph.get(self.id)?.edges ?? [];
	for (let depth = 0; frontier.length > 0 && depth < MAX_WAIT_DEPTH; depth++) {
		const next: string[] = [];
		for (const id of frontier) {
			if (id === askerId) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = graph.get(id);
			if (!entry) continue;
			if (!waitsKnown(entry.node)) unknown = true;
			// A known cycle on another branch still wins over incomplete information here.
			next.push(...entry.edges.filter((edge) => !seen.has(edge)));
		}
		frontier = next;
	}
	return unknown || frontier.some((id) => !seen.has(id)) ? null : false;
}

/** The sessions `start` waits on, directly or through others (bounded like `closesCycle`). */
export function waitedOn(start: WaitNode, peers: readonly WaitNode[]): Set<string> {
	const graph = waitGraph(start, peers);
	const seen = new Set<string>();
	let frontier = [start.id];
	for (let depth = 0; frontier.length > 0 && depth < MAX_WAIT_DEPTH; depth++) {
		const next: string[] = [];
		for (const nodeId of frontier) {
			for (const id of graph.get(nodeId)?.edges ?? []) {
				if (seen.has(id) || id === start.id) continue;
				seen.add(id);
				if (graph.has(id)) next.push(id);
			}
		}
		frontier = next;
	}
	return seen;
}

const ABANDONED_CAP = 64;
/** Inbound asks kept at once. Each is a peer's question and is listed on the board, so a flood
 *  of them must not grow without limit; the oldest gives way (its asker times out). */
const INBOUND_CAP = 64;

/** What a late answer needs to name the ask it answers. */
function lateOf(ask: PendingAsk): LateAsk {
	return { to: ask.to, toCallsign: ask.toCallsign, text: ask.text };
}

export function createAskLedger(): AskLedger {
	const inbound = new Map<string, InboundAsk>();
	const outbound = new Map<string, PendingAsk>();
	const asyncOut = new Map<string, AsyncAsk>();
	const abandoned = new Map<string, LateAsk>();

	function stop(id: string, outcome: Omit<AskOutcome & { ok: false }, "held">): void {
		const pending = outbound.get(id);
		if (!pending) return;
		setBounded(abandoned, id, lateOf(pending), ABANDONED_CAP);
		// Another ask still waiting on the same peer takes the held messages: delivered now, they
		// would be steered in behind that ask's answer, which they came before.
		const next = [...outbound].find(([other, p]) => other !== id && p.to === pending.to)?.[1];
		if (next) next.held = [...pending.held, ...next.held];
		pending.settle({ ...outcome, held: next ? [] : pending.held });
	}

	/** End an async ask without an answer; a later answer still reads as a reply to it. */
	function endAsync(id: string, ask: AsyncAsk): EndedAsync {
		asyncOut.delete(id);
		setBounded(abandoned, id, { to: ask.to, toCallsign: ask.toCallsign, text: ask.text, async: true }, ABANDONED_CAP);
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
					since: Date.now(),
					deadline: Date.now() + timeoutMs,
					timeoutMs,
					held: [],
					settle: finish,
				});
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},

		trackAsync(askId, meta, timeoutMs) {
			asyncOut.set(askId, { ...meta, deadline: Date.now() + timeoutMs, timeoutMs });
		},

		settle(answerTo, text, fromCallsign, from) {
			const pending = outbound.get(answerTo);
			if (!pending || pending.to !== from) return false;
			pending.settle({ ok: true, text, fromCallsign, held: pending.held });
			return true;
		},

		hold(message) {
			// With the oldest ask waiting on the sender: the one answered (or ended) first.
			for (const pending of outbound.values()) {
				if (pending.to !== message.from) continue;
				pending.held.push(message);
				return true;
			}
			return false;
		},

		wasAbandoned(askId, from) {
			const open = asyncOut.get(askId);
			if (open) {
				if (open.to !== from) return null;
				asyncOut.delete(askId);
				return { to: open.to, toCallsign: open.toCallsign, text: open.text, async: true };
			}
			const found = abandoned.get(askId) ?? null;
			if (found?.to !== undefined && found.to !== from) return null;
			if (found) abandoned.delete(askId);
			return found;
		},

		abandon(askId, reason) {
			const open = asyncOut.get(askId);
			if (open) endAsync(askId, open);
			stop(askId, { ok: false, reason });
		},

		abandonAll(reason) {
			const stopped: Array<{ id: string; to: string }> = [];
			for (const [id, pending] of [...outbound]) {
				stopped.push({ id, to: pending.to });
				stop(id, { ok: false, reason });
			}
			for (const [id, ask] of [...asyncOut]) {
				stopped.push({ id, to: ask.to });
				endAsync(id, ask);
			}
			return stopped;
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
			return [...asyncOut].filter(([, ask]) => isGone(ask.to)).map(([id, ask]) => endAsync(id, ask));
		},

		expire(now) {
			for (const [id, pending] of [...outbound]) {
				if (pending.deadline > now) continue;
				stop(id, {
					ok: false,
					reason: `${pending.toCallsign} did not answer within ${Math.round(pending.timeoutMs / 1000)}s. If they answer later, the reply arrives as a message — carry on with other work meanwhile.`,
				});
			}
			return [...asyncOut].filter(([, ask]) => ask.deadline <= now).map(([id, ask]) => endAsync(id, ask));
		},

		outboundCount() {
			return outbound.size;
		},

		lateCandidates() {
			return [
				...abandoned.entries(),
				...[...outbound.entries()].map(([id, p]): [string, LateAsk] => [id, lateOf(p)]),
			].slice(-ABANDONED_CAP);
		},

		restoreAbandoned(entries) {
			for (const [id, ask] of entries) setBounded(abandoned, id, ask, ABANDONED_CAP);
		},

		asyncOpen() {
			return [...asyncOut.entries()].map(([id, a]): [string, AsyncAsk] => [id, { ...a }]);
		},

		restoreAsync(entries) {
			for (const entry of entries) {
				// Parked by this same process (`takeReloadHandoff` checks the pid), but a file all the
				// same: a malformed entry is skipped rather than trusted.
				if (!Array.isArray(entry)) continue;
				const [id, a] = entry as [unknown, Partial<AsyncAsk> | null];
				if (typeof id !== "string" || !a || typeof a.to !== "string" || typeof a.toCallsign !== "string" || typeof a.text !== "string") continue;
				if (!Number.isFinite(a.deadline) || !Number.isFinite(a.timeoutMs)) continue;
				asyncOut.set(id, { to: a.to, toCallsign: a.toCallsign, text: a.text, deadline: a.deadline as number, timeoutMs: a.timeoutMs as number });
			}
		},

		waits() {
			const pending = [...outbound.values()];
			if (pending.length === 0) return { on: [] };
			return { on: [...new Set(pending.map((p) => p.to))], since: Math.min(...pending.map((p) => p.since)) };
		},
	};
}
