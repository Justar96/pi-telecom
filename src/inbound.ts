/**
 * inbound — what arrives in this session's inbox, and what the model hears of it: messages, asks
 * and answers, broadcasts, explicit team tasks, and peer events. A peer's file change becomes a
 * change notice, coalesced per peer and path and sent once the burst is over.
 */
import { join } from "node:path";
import type { PeerChange } from "./awareness.ts";
import { claimMatcher, claimsOverlap, laneRelativePattern, matchesClaim } from "./glob.ts";
import { closesCycle, type InboundAsk } from "./ledger.ts";
import { type PendingNotice, renderNotice } from "./notices.ts";
import { displayPath, isWithin, laneName, sameRepo } from "./project.ts";
import { MESSAGE_TYPES } from "./render.ts";
import { type MessageDetails, type Runtime, taskLine } from "./runtime.ts";
import { type Envelope, type FileChangedData, parseEvent } from "./transport.ts";
import { clip, pairKey, setBounded } from "./util.ts";

/** Peer changes arriving within this window are folded into one notice. */
const NOTICE_COALESCE_MS = 1_200;
/** Envelope ids already handled, so an at-least-once redelivery is not handled twice. */
const SEEN_CAP = 2_048;

export interface Inbound {
	/** Handle one drained envelope; a redelivery of one already handled is dropped. */
	receive(env: Envelope): void;
	/** Send the queued change notices once the coalescing window has passed, or now with `force`. */
	flushNotices(force?: boolean): void;
	/** Start an explicit team task from a human in this session; false when it did not arrive. */
	runTask(env: Envelope): boolean;
	/** Drop the queued notices: the session left the switchboard. */
	clear(): void;
}

export function createInbound(rt: Runtime): Inbound {
	const notices = new Map<string, PendingNotice>();
	let noticeSince = 0;
	const seen = new Map<string, true>();

	/** An explicit team task from a human wakes idle sessions even when automatic wakes are off. */
	function runTask(env: Envelope): boolean {
		if (!rt.self) return false;
		rt.setTask(rt.self, taskLine(env.text), true);
		rt.publish();
		return rt.inject(
			MESSAGE_TYPES.message,
			`**📡 Team task from ${env.fromCallsign}'s human**\n\n${env.text}`,
			{ from: env.from, fromCallsign: env.fromCallsign, id: env.id, tone: "accent" },
			"wake-always",
		);
	}

	/**
	 * Is anything at `patterns` (written in the sender's checkout) part of this agent's work: a file
	 * it is working with or changed, or one of its claims?
	 */
	function concernsMe(patterns: readonly string[], senderId: string): boolean {
		const me = rt.self;
		if (!me) return false;
		const sender = rt.peers.find((p) => p.id === senderId);
		const lane = sender !== undefined && sender.projectRoot !== me.projectRoot;
		const work = [...rt.awareness.focusPaths(), ...me.recent.map((r) => r.path)];
		for (const raw of patterns) {
			const pattern = lane ? laneRelativePattern(raw, sender.projectRoot) : raw;
			if (pattern === null) continue;
			if (me.claims.some((c) => claimsOverlap(c.pattern, pattern, me.projectRoot))) return true;
			const inside = claimMatcher(pattern, me.projectRoot);
			if (work.some(inside)) return true;
		}
		return false;
	}

	function handleEnvelope(env: Envelope): void {
		const from = env.fromCallsign;
		const human = env.human ? " (from their human)" : "";
		const base: MessageDetails = { from: env.from, fromCallsign: from, id: env.id };
		if (env.kind === "message" || env.kind === "ask" || env.kind === "answer") rt.noteContact(env.from);
		switch (env.kind) {
			case "message":
				if (env.human && env.triggerTurn) {
					runTask(env);
					return;
				}
				rt.inject(
					MESSAGE_TYPES.message,
					`**📡 Message from ${from}${human}**\n\n${env.text}\n\n(Reply only if needed: action "send", to "${from}".)`,
					{ ...base, tone: "accent" },
					"wake",
				);
				return;
			case "broadcast": {
				// A broadcast about paths away from this agent's work waits for its next run instead
				// of breaking into the current one.
				const about = env.paths?.length ? ` — about ${env.paths.map((p) => clip(p, 80)).join(", ")}` : "";
				const near = !env.paths?.length || concernsMe(env.paths, env.from);
				rt.inject(MESSAGE_TYPES.broadcast, `**📡 Broadcast from ${from}${human}${about}**\n\n${env.text}`, base, near ? "passive" : "later");
				return;
			}
			case "ask": {
				const ask: Omit<InboundAsk, "reminded"> = {
					id: env.id,
					from: env.from,
					fromCallsign: from,
					text: env.text,
					at: env.ts,
				};
				rt.ledger.noteInbound(ask);
				// Stop waiting only when this ask closes a cycle (we, directly or through others,
				// wait on the asker): then nobody on it could ever answer. Any other ask waits
				// until our own wait ends. Unknown graph (an older peer on the way): interrupt.
				const me = rt.self;
				if (me && rt.ledger.outboundCount() > 0 && closesCycle(env.from, { ...me, waitingOn: rt.ledger.waits().on }, rt.readPeers()) !== false) {
					rt.ledger.interruptAll({ ...ask, reminded: false });
				}
				rt.inject(
					MESSAGE_TYPES.ask,
					`**📡 Ask from ${from}${human}** — they are blocked until you reply\n\n${env.text}\n\nReply with telecom({ action: "reply", askId: "${env.id}", message: "<your answer>" }).`,
					{ ...base, tone: "warning", askId: env.id },
					"wake-always",
				);
				rt.updateStatus();
				return;
			}
			case "answer": {
				const answerTo = env.answerTo ?? "";
				if (rt.ledger.settle(answerTo, env.text, from, env.from)) return;
				const late = rt.ledger.wasAbandoned(answerTo, env.from);
				rt.inject(
					MESSAGE_TYPES.reply,
					late
						? `**📡 Late reply from ${from}** to your ask "${clip(late.text, 80)}"\n\n${env.text}`
						: `**📡 Reply from ${from}**\n\n${env.text}`,
					{ ...base, tone: "accent" },
					late ? "wake" : "passive",
				);
				return;
			}
			case "event":
				handleEvent(env);
				return;
		}
	}

	function handleEvent(env: Envelope): void {
		if (!rt.self) return;
		const event = parseEvent(env);
		if (!event) return;
		const peer = { from: env.from, fromCallsign: env.fromCallsign };
		switch (event.topic) {
			case "file.changed":
				queueNotice(env, event.data);
				return;
			case "claim.contested": {
				const { path, pattern } = event.data;
				if (event.data.lane) {
					// Nothing was held back (their checkout is separate), so there is no one to tell
					// on release: this is news about the merge ahead.
					const sender = rt.peers.find((p) => p.id === env.from);
					rt.inject(
						MESSAGE_TYPES.claim,
						`**📡 ${env.fromCallsign} changed a path you claimed, in another checkout**\n\n${env.fromCallsign} edited ${displayPath(path, sender?.projectRoot ?? rt.root())} in ${sender ? laneName(sender) : "another checkout of this repository"}, inside your claim "${pattern}". Nothing was held back, since your checkouts are separate, but the two changes meet when the branches merge. If they may conflict, agree on one owner: telecom({ action: "send", to: "${env.fromCallsign}", message: "…" }).`,
						{ ...peer, tone: "warning" },
						"passive",
					);
					return;
				}
				const waiting = rt.contesters.get(pattern) ?? new Map<string, string>();
				waiting.set(env.from, env.fromCallsign);
				rt.contesters.set(pattern, waiting);
				rt.inject(
					MESSAGE_TYPES.claim,
					`**📡 ${env.fromCallsign} needs a path you claimed**\n\n${env.fromCallsign} tried to change ${displayPath(path, rt.root())}, inside your claim "${pattern}". They were asked to check with you first. If you no longer need the whole area, narrow or release it: telecom({ action: "release", paths: ["${pattern}"] }).`,
					{ ...peer, tone: "warning" },
					"passive",
				);
				return;
			}
			case "ask.withdrawn": {
				const { askId } = event.data;
				if (!rt.ledger.resolveInbound(askId, env.from)) return;
				rt.inject(
					MESSAGE_TYPES.reply,
					`**📡 ${env.fromCallsign} withdrew their ask** (${askId})\n\nNo reply is needed any more.`,
					peer,
					"passive",
				);
				rt.updateStatus();
				return;
			}
			case "claim.released": {
				const patterns = event.data.patterns.join(", ");
				rt.inject(
					MESSAGE_TYPES.claim,
					`**📡 ${env.fromCallsign} released ${patterns || "their claim"}**\n\nYou can work there now.`,
					peer,
					"passive",
				);
				return;
			}
		}
	}

	/** Note a peer's change, and queue a notice when this agent works with the file. */
	function queueNotice(env: Envelope, data: FileChangedData): void {
		const me = rt.self;
		if (!me) return;
		const change: PeerChange = {
			peerId: env.from,
			callsign: env.fromCallsign,
			path: data.path,
			op: data.op,
			at: env.ts,
			...(data.summary ? { summary: data.summary } : {}),
		};
		// A sender that joined since the last team refresh is not cached yet: look again before
		// telling its own copy of a file from this agent's. Gone already: go by where the path lies.
		const sender = rt.peers.find((p) => p.id === env.from) ?? rt.readPeers().find((p) => p.id === env.from);
		let mine: string | null = data.path;
		if (!sender) {
			if (!isWithin(data.path, me.projectRoot)) mine = null;
		} else if (sameRepo(sender, me)) {
			// Lanes are told apart by where the files lie: agents started in one checkout may each
			// work in a worktree of their own. A file in a checkout this agent works in (or one it
			// has looked at) is this agent's very file; else its copy here is the one it has looked
			// at, or the one in its own checkout.
			const theirs = rt.awareness.placeOf(data.path, sender);
			const checkouts = rt.awareness.checkoutsOf(me);
			if (theirs && !checkouts.has(theirs.checkout) && !rt.awareness.hasView(data.path)) {
				const copies = [...checkouts].map((c) => join(c, theirs.rel));
				mine = copies.find((c) => rt.awareness.hasView(c)) ?? join(me.projectRoot, theirs.rel);
			}
		}
		// `mine === data.path` from another lane: the peer reached into this checkout (nested in
		// its own) and changed this agent's very file, so it is an ordinary peer change below.
		if (mine !== data.path) {
			// A peer in another worktree changed ITS copy: this agent's file did not move, so it is
			// not a peer change here (the guard must not see one), only news about the merge.
			if (!sender || !mine) return;
			const laneChange = { ...change, path: mine };
			if (!rt.awareness.noteLaneChange(env.from, mine) && !notices.has(noticeKey(laneChange))) return;
			enqueueNotice({ change: laneChange, relation: "lane", lane: laneName(sender), ...(data.excerpt ? { excerpt: data.excerpt } : {}) });
			return;
		}
		const { relation, firstNotice } = rt.awareness.notePeerChange(change);
		const claim = me.claims.find((c) => matchesClaim(data.path, c.pattern, me.projectRoot));
		// Suppress later interruptions, but keep a pending notice's count and excerpt current.
		if (!claim && !notices.has(noticeKey(change)) && !(relation && firstNotice)) return;
		enqueueNotice({
			change,
			relation: claim ? "claimed" : (relation ?? "read"),
			...(claim ? { claim: claim.pattern } : {}),
			...(data.excerpt ? { excerpt: data.excerpt } : {}),
		});
	}

	function noticeKey(change: PeerChange): string {
		return pairKey(change.peerId, change.path);
	}

	/** Queue a notice for the next flush, counted with a pending one about the same peer and path. */
	function enqueueNotice(notice: Omit<PendingNotice, "count">): void {
		const key = noticeKey(notice.change);
		if (notices.size === 0) noticeSince = Date.now();
		notices.set(key, { ...notice, count: (notices.get(key)?.count ?? 0) + 1 });
	}

	return {
		receive(env) {
			if (seen.has(env.id)) return;
			setBounded(seen, env.id, true, SEEN_CAP);
			handleEnvelope(env);
		},

		flushNotices(force = false) {
			if (notices.size === 0 || !rt.self) return;
			if (!force && Date.now() - noticeSince < NOTICE_COALESCE_MS) return;
			const byPeer = new Map<string, PendingNotice[]>();
			for (const notice of notices.values()) {
				const list = byPeer.get(notice.change.callsign) ?? [];
				list.push(notice);
				byPeer.set(notice.change.callsign, list);
			}
			notices.clear();
			for (const [callsign, list] of byPeer) {
				const { content, summary } = renderNotice(callsign, list, rt.root());
				rt.inject(MESSAGE_TYPES.change, content, { fromCallsign: callsign, tone: "warning", summary }, "passive");
			}
		},

		runTask,

		clear() {
			notices.clear();
		},
	};
}
