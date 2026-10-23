/**
 * actions — the `execute` half of the `telecom` tool: one function per action, each given the
 * session state it acts on, already checked present. The static half (schema, model-facing text,
 * renderers) is `tool.ts`; it is fixed at registration (AGENTS.md, rule 1).
 */
import { resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { ownerOf, resolveTarget, stateHint, type Target, targetName } from "./address.ts";
import { MAX_ASK_TIMEOUT_MS } from "./config.ts";
import { blockedOnMe, isForegroundChild, lineOf, parentOf } from "./family.ts";
import { absolutePattern, claimsOverlap, laneRelativePattern } from "./glob.ts";
import { type AskOutcome, closesCycle, type InboundAsk, waitedOn } from "./ledger.ts";
import { displayPath, isWithin, laneName } from "./project.ts";
import { OFF_TEXT, type Runtime } from "./runtime.ts";
import { deliveryReport, fail, ok, TOOL_SPEC, type ToolAction, type ToolParams, type ToolResult } from "./tool.ts";
import type { Presence, Transport } from "./transport.ts";
import { clip } from "./util.ts";

const CLAIM_NOTE_CAP = 120;
/** A claim refused again for the same conflicts within this window is a blind retry. */
const CLAIM_RETRY_WINDOW_MS = 10 * 60_000;

/** One `telecom` tool call, with the session state it acts on already checked present. */
interface ActionCall {
	me: Presence;
	net: Transport;
	params: ToolParams;
	/** `params.message`, trimmed. */
	message: string;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback | undefined;
}

/** `params.paths`, trimmed, without blanks. */
function pathsOf(params: ToolParams): string[] {
	return (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
}

function listAsks(asks: readonly InboundAsk[]): string {
	return asks.map((a) => `${a.id} (${a.fromCallsign})`).join(", ");
}

/** Why paths outside the repository were not claimed, and what to do instead. */
function outsideRefusal(me: Presence, outside: readonly string[]): string {
	return `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside this repository (${me.projectRoot} and its worktrees), and claims cover only its files. Peers who read a file there still hear when you change it, and the guard still stops a write over a change you have not read. To keep others out of one, tell them: telecom({ action: "broadcast", message: "editing …; please leave it to me until I say" }).`;
}

export function registerTool(rt: Runtime): void {
	/** The last claim refused for a conflict: an identical retry is told nothing has changed. */
	let lastClaimRefusal: { key: string; at: number } | null = null;

	function boardAction({ me, params }: ActionCall): ToolResult {
		return ok(rt.boardText(params.scope ?? "project"), { callsign: me.callsign, peers: rt.team().map((p) => p.callsign) });
	}

	function statusAction({ me, message }: ActionCall): ToolResult {
		if (!message) return ok(`your task as peers see it: ${me.task ?? "(none)"}`);
		rt.setTask(me, message, true);
		rt.publish();
		return ok(`status set — peers now see ${me.callsign}: ${me.task}`);
	}

	/** The checks `send` and `ask` share: a target (`to`, or whoever owns `paths`) and a message. */
	function messageTarget({ me, params, message }: ActionCall): Target {
		const paths = pathsOf(params);
		if (!params.to?.trim() && paths.length === 0) {
			return { ok: false, reason: `"${params.action}" needs \`to\` (a callsign from the board), or \`paths\` to reach whoever claims or last changed them` };
		}
		if (!message) return { ok: false, reason: `"${params.action}" needs a \`message\`` };
		const peers = rt.readPeers();
		return params.to?.trim() ? resolveTarget(params.to, me, peers) : ownerOf(paths, params.action, me, peers);
	}

	function sendAction(call: ActionCall): ToolResult {
		const target = messageTarget(call);
		if (!target.ok) return fail(target.reason);
		const sent = call.net.deliver(rt.envelope(target.peer.id, "message", call.message));
		if (!sent.ok) return fail(sent.reason);
		rt.noteContact(target.peer.id);
		return ok(`sent to ${targetName(target)} (${stateHint(target.peer, call.me, rt.peers)})`, { to: target.peer.callsign });
	}

	async function askAction(call: ActionCall): Promise<ToolResult> {
		if (call.signal?.aborted) return fail("the ask was abandoned: the tool call was aborted");
		const target = messageTarget(call);
		if (!target.ok) return fail(target.reason);
		const { me, net, message, signal, onUpdate } = call;
		const peer = target.peer;
		const peers = rt.readPeers();
		if (blockedOnMe(me, peer, peers)) {
			// The parent (or a foreground ancestor further up) is inside its `subagent` tool call,
			// waiting for this very run: an ask could only reach it after this run ends, so waiting
			// for the answer would deadlock.
			const parent = parentOf(me, peers);
			const who = parent?.id === peer.id ? "your parent session" : "above you in a chain of foreground subagents";
			return fail(
				`${peer.callsign} is ${who}, and it is blocked waiting for your run to end, so it cannot read an ask until you finish. Decide yourself and state the assumption in your final answer, or end your run with the question. If you have pi-subagents' contact_supervisor tool, it reaches ${parent?.callsign ?? "your parent"} mid-run: contact_supervisor({ reason: "need_decision", message: "…" }).`,
			);
		}
		const deadlock = foregroundDeadlock(me, peer, peers);
		if (deadlock) return fail(deadlock);
		const requested = call.params.timeoutSec && call.params.timeoutSec > 0 ? call.params.timeoutSec * 1000 : rt.cfg.askTimeoutMs;
		const timeoutMs = Math.min(requested, MAX_ASK_TIMEOUT_MS);
		const env = rt.envelope(peer.id, "ask", message);
		// Wait before delivering, so an answer that arrives at once has an ask to settle.
		const waiting = rt.ledger.awaitAnswer(env.id, { to: peer.id, toCallsign: peer.callsign, text: message }, timeoutMs, signal);
		// Published before the ask is delivered, so the peer sees the wait when the ask arrives.
		rt.publishWaits();
		const sent = net.deliver(env);
		if (!sent.ok) {
			rt.ledger.abandon(env.id, sent.reason);
			await waiting;
			if (rt.self === me) rt.publishWaits();
			return fail(sent.reason);
		}
		rt.noteContact(peer.id);
		onUpdate?.({
			content: [{ type: "text", text: `waiting for ${targetName(target)} (${stateHint(peer, me, rt.peers)})…` }],
			details: { waiting: peer.callsign },
		});
		const answer: AskOutcome = await waiting;
		// This session may have disconnected (or reconnected as a new record) while it waited.
		const connected = rt.self === me;
		if (connected) rt.publishWaits();
		if (answer.ok) {
			const asked = target.via ? `${answer.fromCallsign} (it ${target.via}) answered` : `${answer.fromCallsign} answered`;
			return ok(`${asked}:\n\n${answer.text}`, { from: answer.fromCallsign, askId: env.id });
		}
		if (answer.interruptedBy) {
			const by = answer.interruptedBy;
			return ok(
				`${answer.reason}\n\n${by.fromCallsign} asks: ${by.text}\n\nReply with telecom({ action: "reply", askId: "${by.id}", message: "…" }).`,
				{ interrupted: true, askId: env.id, inboundAskId: by.id },
			);
		}
		if (answer.aborted && connected && rt.readPeers().some((p) => p.id === peer.id)) {
			// Nobody is waiting any more: take the question off the peer's to-do list.
			rt.sendEvent(peer.id, { topic: "ask.withdrawn", data: { askId: env.id } }, `${me.callsign} withdrew an ask`);
		}
		return fail(answer.reason, { askId: env.id });
	}

	/**
	 * Why asking `peer` would deadlock, or null. A peer inside a foreground subagent run reads
	 * nothing until that run ends. If the run waits, through any chain of asks, on this agent, the
	 * ask would close a cycle that only this agent can break, by answering what waits on it.
	 */
	function foregroundDeadlock(me: Presence, peer: Presence, peers: readonly Presence[]): string | null {
		const running = peers.find((c) => c.state === "busy" && isForegroundChild(c, peer));
		if (!running) return null;
		const asking = { ...me, waitingOn: [...new Set([...rt.ledger.waits().on, peer.id])] };
		const graph = peers.map((p) => (p.id === me.id ? asking : p));
		if (closesCycle(me.id, peer, graph) !== true) return null;
		// The asks waiting on this agent from sessions on the cycle come first: answering one of
		// those is what unblocks the run.
		const cycle = waitedOn(peer, graph);
		const owed = rt.ledger.inbound().sort((x, y) => Number(cycle.has(y.from)) - Number(cycle.has(x.from)));
		const first = owed[0];
		return `${peer.callsign} is inside its subagent ${running.callsign}'s run, which is waiting, directly or through others, on you, so ${peer.callsign} cannot read an ask until you unblock it: waiting for an answer would deadlock. ${
			first
				? `Answer what waits on you first: telecom({ action: "reply", askId: "${first.id}", message: "…" })${owed.length > 1 ? ` (all waiting: ${listAsks(owed)})` : ""}. Or decide yourself.`
				: `Decide yourself, or leave the question for later: telecom({ action: "send", to: "${peer.callsign}", message: "…" }).`
		}`;
	}

	function replyAction({ me, net, params, message }: ActionCall): ToolResult {
		if (!message) return fail('"reply" needs a `message`');
		const outstanding = rt.ledger.inbound();
		let askId = params.askId?.trim() ?? "";
		if (!askId && outstanding.length === 1) askId = (outstanding[0] as InboundAsk).id;
		if (!askId) {
			return fail(
				outstanding.length === 0
					? "no inbound ask is waiting — use send for an ordinary message"
					: `which ask? Pass askId: ${listAsks(outstanding)}`,
			);
		}
		const ask = outstanding.find((a) => a.id === askId);
		let to: Presence | undefined;
		if (ask) {
			to = rt.readPeers().find((p) => p.id === ask.from);
			if (!to) {
				rt.ledger.resolveInbound(askId);
				rt.updateStatus();
				return fail(`${ask.fromCallsign} is gone — their session ended before your reply`);
			}
		} else if (params.to) {
			// An answer to an ask this session no longer tracks (it was reloaded, or it expired).
			const target = resolveTarget(params.to, me, rt.readPeers());
			if (!target.ok) return fail(target.reason);
			to = target.peer;
		} else {
			return fail(
				`no inbound ask has the handle "${askId}". ${
					outstanding.length ? `Waiting: ${listAsks(outstanding)}.` : "None is waiting."
				}`,
			);
		}
		const sent = net.deliver(rt.envelope(to.id, "answer", message, { answerTo: askId }));
		if (!sent.ok) return fail(sent.reason);
		// A failed delivery leaves the handle available for a retry, including inferred replies.
		rt.ledger.resolveInbound(askId);
		rt.noteContact(to.id);
		rt.updateStatus();
		return ok(`replied to ${to.callsign}`, { to: to.callsign, askId });
	}

	function broadcastAction({ me, net, params, message }: ActionCall): ToolResult {
		if (!message) return fail('"broadcast" needs a `message`');
		const scope = params.scope ?? "project";
		const peers = scope === "machine" ? rt.readPeers().filter((p) => p.id !== me.id) : rt.team(rt.readPeers());
		if (peers.length === 0) return fail(`no other agent is live ${scope === "machine" ? "on this machine" : "in this project"}`);
		const paths = pathsOf(params);
		const { reached, failed } = rt.deliverEach(net, peers, "broadcast", message, paths.length > 0 ? { paths } : {});
		const about = paths.length > 0 ? ` — about ${paths.join(", ")}: agents working there get it now, the rest at their next prompt` : "";
		return ok(`broadcast to ${deliveryReport(reached, failed)}${about}`, { reached, failed });
	}

	/**
	 * Peers' claims that overlap `patterns`: in this checkout they conflict; in another lane they
	 * are only worth a note (the files are separate until the merge). This agent's lineal family
	 * never conflicts: a subagent may claim part of its parent's claim, and the other way round.
	 */
	function claimConflicts(
		me: Presence,
		patterns: readonly string[],
		now: number,
	): { conflicts: { mine: string; owner: string; what: string }[]; lanes: string[] } {
		const conflicts: { mine: string; owner: string; what: string }[] = [];
		const lanes: string[] = [];
		const peers = rt.readPeers();
		const family = lineOf(me, peers);
		for (const peer of rt.team(peers)) {
			if (family.has(peer.id)) continue;
			const otherLane = peer.projectRoot !== me.projectRoot;
			for (const theirs of peer.claims) {
				if (theirs.expiresAt <= now) continue;
				const pattern = otherLane ? laneRelativePattern(theirs.pattern, peer.projectRoot) : theirs.pattern;
				if (pattern === null) continue;
				for (const mine of patterns) {
					if (!claimsOverlap(mine, pattern, me.projectRoot)) continue;
					const what = `"${mine}" overlaps ${peer.callsign}'s claim "${theirs.pattern}"${theirs.note ? ` (${theirs.note})` : ""}`;
					if (otherLane) lanes.push(`${what} in ${laneName(peer)}`);
					else conflicts.push({ mine, owner: peer.callsign, what });
				}
			}
		}
		return { conflicts, lanes };
	}

	/**
	 * A claim pattern as it is stored: as given when it lies in the checkout this agent started in.
	 * An absolute path into another worktree of the repository (agents often start in the main
	 * checkout and work in one of their own) names the same repository path, so it is stored
	 * relative, and binds in every checkout this agent works in. `null` outside the repository.
	 */
	function claimPattern(me: Presence, pattern: string): string | null {
		if (isWithin(absolutePattern(pattern, me.projectRoot), me.projectRoot)) return pattern;
		const path = resolve(me.projectRoot, pattern);
		const place = rt.awareness.placeOf(path, me);
		return place ? displayPath(path, place.checkout) : null;
	}

	function claimAction({ me, params, message }: ActionCall): ToolResult {
		const asked = pathsOf(params);
		if (asked.length === 0) return fail('"claim" needs `paths` — project-relative paths or globs');
		const patterns: string[] = [];
		const outside: string[] = [];
		for (const raw of asked) {
			const pattern = claimPattern(me, raw);
			if (pattern === null) outside.push(raw);
			else if (!patterns.includes(pattern)) patterns.push(pattern);
		}
		// Like a held path below, a path outside the repository does not cost the ones inside it.
		const away = outside.length > 0 ? outsideRefusal(me, outside) : "";
		if (patterns.length === 0) return fail(away, { refused: outside });
		const now = Date.now();
		const { conflicts, lanes } = claimConflicts(me, patterns, now);
		// A held path does not cost the free ones: models that got an all-or-nothing refusal
		// tended to drop the whole claim and edit unclaimed.
		const held = new Set(conflicts.map((c) => c.mine));
		const granted = patterns.filter((p) => !held.has(p));
		const refused = [...held, ...outside];
		let refusal = "";
		if (conflicts.length > 0) {
			const owners = [...new Set(conflicts.map((c) => c.owner))];
			const key = `${[...held].sort().join("\u0000")}\u0001${owners.sort().join("\u0000")}`;
			const repeated = lastClaimRefusal?.key === key && now - lastClaimRefusal.at < CLAIM_RETRY_WINDOW_MS;
			lastClaimRefusal = { key, at: now };
			refusal = `${conflicts.map((c) => c.what).join("; ")}. ${
				repeated ? `Nothing has changed since this was last refused: retrying will not help. ` : ""
			}Ask ${owners.join(" or ")} to release or split it — telecom({ action: "ask", to: "${owners[0]}", message: "…" }) — or pick other work.`;
			if (granted.length === 0) return fail(away ? `${refusal}\n${away}` : refusal, { refused });
		}
		// Stored without closing punctuation (a clip "…" stays): it is quoted mid-sentence elsewhere.
		const note = message ? clip(message, CLAIM_NOTE_CAP).replace(/[\s.!?]+$/, "") : "";
		for (const pattern of granted) {
			me.claims = me.claims.filter((c) => c.pattern !== pattern);
			me.claims.push({ pattern, since: now, expiresAt: now + rt.cfg.claimTtlMs, ...(note ? { note } : {}) });
		}
		rt.publish();
		rt.updateStatus();
		const overlap =
			lanes.length > 0
				? ` Note: ${lanes.join("; ")}. Your checkouts are separate, so both claims stand, but the work meets when the branches merge; agree on one owner if it may conflict.`
				: "";
		return ok(
			`claimed ${granted.join(", ")}${note ? ` — ${note}` : ""}. Peers editing there are held back and you are told. Release with telecom({ action: "release" }) when done; idle claims expire after ${rt.claimTtlMinutes()} min.${overlap}${
				refusal ? `\nNot claimed: ${refusal}` : ""
			}${away ? `\nNot claimed: ${away}` : ""}`,
			{
				claims: me.claims.map((c) => c.pattern),
				...(refused.length > 0 ? { refused } : {}),
				...(lanes.length > 0 ? { laneOverlaps: lanes.length } : {}),
			},
		);
	}

	function releaseAction({ me, params }: ActionCall): ToolResult {
		const wanted = pathsOf(params);
		const releasing = wanted.length === 0 ? me.claims : me.claims.filter((c) => wanted.includes(c.pattern));
		if (releasing.length === 0) {
			return fail(
				me.claims.length === 0
					? "you hold no claims"
					: `none of those match your claims: ${me.claims.map((c) => c.pattern).join(", ")}`,
			);
		}
		const names = releasing.map((c) => c.pattern);
		const told = rt.releaseClaims(me, names);
		return ok(
			`released ${names.join(", ")}${told.length ? ` — told ${told.join(", ")}, who had been waiting` : ""}`,
			{ released: names },
		);
	}

	const actions: Record<ToolAction, (call: ActionCall) => ToolResult | Promise<ToolResult>> = {
		board: boardAction,
		status: statusAction,
		send: sendAction,
		ask: askAction,
		reply: replyAction,
		broadcast: broadcastAction,
		claim: claimAction,
		release: releaseAction,
	};

	rt.pi.registerTool({
		...TOOL_SPEC,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!rt.enabled) return fail(OFF_TEXT);
			if (!rt.self || !rt.transport) {
				return fail(
					rt.unavailable
						? `the switchboard is unavailable: ${rt.unavailable}`
						: "this session is not connected yet (it connects at session start)",
				);
			}
			// Schema validation should rule this out, but a model can still send anything.
			if (!Object.hasOwn(actions, params.action)) return fail(`unknown action "${String(params.action)}"`);
			const message = params.message?.trim() ?? "";
			return actions[params.action]({ me: rt.self, net: rt.transport, params, message, signal, onUpdate });
		},
	});
}
