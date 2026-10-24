/**
 * actions — the `execute` half of the `telecom` tool: one function per action, each given the
 * session state it acts on, already checked present. The static half (schema, model-facing text,
 * renderers) is `tool.ts`; it is fixed at registration (AGENTS.md, rule 1).
 */
import { resolve } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { ownerOf, resolveTarget, stateHint, type Target, targetName } from "./address.ts";
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { MAX_ASK_TIMEOUT_MS } from "./config.ts";
import { blockedOnMe, isForegroundChild, lineOf, parentOf } from "./family.ts";
import { absolutePattern, claimsOverlap, isResource, isResourceName, laneRelativePattern, resourceKey, sameResource } from "./glob.ts";
import { type AskOutcome, closesCycle, type InboundAsk, waitedOn } from "./ledger.ts";
import { broadcastText, entryTouches, LOG_SHOWN, renderLog } from "./log.ts";
import { callsignsOf, holdsOf, lineFor } from "./locks.ts";
import { displayPath, isWithin, laneName } from "./project.ts";
import { OFF_TEXT, type Runtime } from "./runtime.ts";
import { deliveryReport, fail, ok, TOOL_SPEC, type ToolAction, type ToolParams, type ToolResult } from "./tool.ts";
import { BLOCKED_CAP, type Presence, QUEUED_CAP, type Transport } from "./transport.ts";
import { ago, clip, plural } from "./util.ts";
import type { Waiting } from "./waiting.ts";

const CLAIM_NOTE_CAP = 120;
/** A lock holder's task, as a refused claim quotes it. */
const HOLDER_TASK_CAP = 80;
/**
 * How long an ask with `wait: false` stays open when no `timeoutSec` is given. Nothing blocks on
 * it, so it can outlast a blocking ask's default: it is meant for "tell me when your job is done",
 * and peers' jobs (a test suite, a build) run for tens of minutes. It is capped like any ask
 * (`MAX_ASK_TIMEOUT_MS`): a reply after the expiry still arrives, and wakes this agent, as a late
 * one, so a longer cap would only postpone the "did not answer" notice. The `timeoutSec`
 * description in `tool.ts` names this default (1800 s): keep the two in step.
 */
const ASYNC_ASK_TIMEOUT_MS = 30 * 60_000;
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

/**
 * An answered ask's result. The peer's messages sent while the ask waited come first, oldest
 * first, and are marked as older than the answer: the model reads this result before anything
 * steered in, so a message shown after the answer would read as the newer instruction.
 */
function answerText(asked: string, answer: AskOutcome & { ok: true }): string {
	if (answer.held.length === 0) return `${asked}:\n\n${answer.text}`;
	const from = answer.fromCallsign;
	const count = answer.held.length;
	const messages = answer.held.map(
		(m, i) => `**Message ${count > 1 ? `${i + 1} of ${count} ` : ""}from ${m.fromCallsign}${m.human ? " (from their human)" : ""}** (sent before the answer):\n\n${m.text}`,
	);
	return `${asked}. Before answering, ${from} sent you ${plural(count, "message")}, shown first in the order sent; the answer, the newest, is last.\n\n${messages.join("\n\n")}\n\n**${from}'s answer** (newest):\n\n${answer.text}`;
}

/** Why paths outside the repository were not claimed, and what to do instead. */
function outsideRefusal(me: Presence, outside: readonly string[]): string {
	return `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside this repository (${me.projectRoot} and its worktrees), and claims cover only its files. Peers who read a file there still hear when you change it, and the guard still stops a write over a change you have not read. To keep others out of one, tell them: telecom({ action: "broadcast", message: "editing …; please leave it to me until I say" }).`;
}

/** Why lock names were refused, and how to write a lock (or a path that starts with `@`). */
function badNameRefusal(names: readonly string[]): string {
	return `${names.map((n) => JSON.stringify(n)).join(", ")} ${names.length === 1 ? "is not a lock name" : "are not lock names"}: a lock is @ followed by letters, digits, ".", "_" or "-" (at most 48), such as "@cargo". To claim a path that starts with @, write it as "./@…".`;
}

/** `["@cargo", "@runtime"]`, for the exact call a result suggests. */
function listCall(names: readonly string[]): string {
	return `[${names.map((n) => JSON.stringify(n)).join(", ")}]`;
}

/** How a lock's holder is doing, for a peer refused or queued behind it. */
function holderState(peer: Presence, now: number): string {
	const state = now - peer.heartbeatAt > UNRESPONSIVE_MS ? `unresponsive, last seen ${ago(peer.heartbeatAt, now)}` : peer.state;
	return `${state}${peer.task ? `, task: ${clip(peer.task, HOLDER_TASK_CAP)}` : ""}`;
}

export function registerTool(rt: Runtime, waiting: Waiting): void {
	/** The last claim refused for a conflict: an identical retry is told nothing has changed. */
	let lastClaimRefusal: { key: string; at: number } | null = null;

	function boardAction({ me, params }: ActionCall): ToolResult {
		return ok(rt.boardText(params.scope ?? "project"), { callsign: me.callsign, peers: rt.team().map((p) => p.callsign) });
	}

	/**
	 * Set the task peers see, and whom this agent waits for (`waitingFor`, published as `blockedOn`).
	 * Setting status without `waitingFor` clears the wait: a new status is a new situation.
	 */
	function statusAction({ me, params, message }: ActionCall): ToolResult {
		const declaring = params.waitingFor !== undefined;
		if (!message && !declaring) {
			const waits = me.blockedOn?.length ? `; waiting for ${callsignsOf(me.blockedOn, rt.readPeers(), me.id).join(", ")}` : "";
			return ok(`your task as peers see it: ${me.task ?? "(none)"}${waits}`);
		}
		const peers = rt.readPeers();
		const ids: string[] = [];
		for (const name of (params.waitingFor ?? []).map((w) => w.trim()).filter(Boolean)) {
			const target = resolveTarget(name, me, peers);
			if (!target.ok) return fail(`waitingFor: ${target.reason} Nothing was changed.`);
			if (!ids.includes(target.peer.id)) ids.push(target.peer.id);
		}
		if (ids.length > BLOCKED_CAP) {
			return fail(`waitingFor names ${ids.length} agents, and at most ${BLOCKED_CAP} are kept. Name the ones you are blocked on right now. Nothing was changed.`);
		}
		const waited = (me.blockedOn?.length ?? 0) > 0;
		if (message) rt.setTask(me, message, true);
		if (ids.length > 0) me.blockedOn = ids;
		else delete me.blockedOn;
		const cycle = waiting.declare(peers);
		rt.publish();
		const names = callsignsOf(ids, peers, me.id);
		const task = message ? `peers now see ${me.callsign}: ${me.task}` : `your task stays: ${me.task ?? "(none)"}`;
		const waits =
			ids.length > 0
				? ` · waiting for ${names.join(", ")}. You are woken when one of them finishes a run, takes up a new task or leaves; a message from one ends your wait on it. Setting status without waitingFor clears it.`
				: waited
					? " · no longer waiting for anyone"
					: "";
		return ok(`status set — ${task}${waits}${cycle ? `\n${cycle}` : ""}`, ids.length > 0 ? { waitingFor: names } : {});
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
		if (call.params.wait === false) return askWithoutWaiting(call, target);
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
			return ok(answerText(asked, answer), {
				from: answer.fromCallsign,
				askId: env.id,
				...(answer.held.length > 0 ? { heldMessages: answer.held.map((m) => m.id) } : {}),
			});
		}
		// No answer came: what the peer sent meanwhile is delivered as it would have been on arrival.
		for (const held of answer.held) rt.injectMessage(held);
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
	 * `ask` with `wait: false`: deliver it and return. Nothing waits on the answer, so the ask is
	 * not published in `waitingOn` (it closes no wait cycle, and nothing interrupts it); the answer
	 * arrives as a reply message, which wakes this agent like a late answer does.
	 */
	function askWithoutWaiting({ me, net, params, message }: ActionCall, target: Target & { ok: true }): ToolResult {
		const peer = target.peer;
		const requested = params.timeoutSec && params.timeoutSec > 0 ? params.timeoutSec * 1000 : ASYNC_ASK_TIMEOUT_MS;
		const timeoutMs = Math.min(requested, MAX_ASK_TIMEOUT_MS);
		const env = rt.envelope(peer.id, "ask", message, { async: true });
		const sent = net.deliver(env);
		if (!sent.ok) return fail(sent.reason);
		// Tracked after delivery: an answer is drained on a later tick, never within this call.
		rt.ledger.trackAsync(env.id, { to: peer.id, toCallsign: peer.callsign, text: message }, timeoutMs);
		rt.noteContact(peer.id);
		return ok(
			`asked ${targetName(target)} (${stateHint(peer, me, rt.peers)}) — handle ${env.id}\nYou are not waiting: carry on with other work. The answer arrives as a message and wakes you; if none comes within ${Math.round(timeoutMs / 1000)}s, you are told.`,
			{ to: peer.callsign, askId: env.id, async: true },
		);
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
		if (reached.length > 0) rt.logEntry("broadcast", broadcastText(message, paths), paths);
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

	/**
	 * The locks among `names` this agent cannot take now: held by a rival (its lineal family shares,
	 * as with paths, and unlike a path claim a lock binds across lanes), or free with others in line
	 * before this agent (they take it within a moment; claiming it would jump the line).
	 */
	function lockConflicts(me: Presence, names: readonly string[], now: number): Map<string, string> {
		/** Lock name → why it is not free: "held by …" or "free, but … is first in line". */
		const conflicts = new Map<string, string>();
		if (names.length === 0) return conflicts;
		const rivals = lockRivals(me);
		for (const name of names) {
			const hold = holdsOf(name, rivals, now)[0];
			if (hold) {
				const { peer, claim } = hold;
				conflicts.set(name, `held by ${peer.callsign} since ${ago(claim.since, now)} (${holderState(peer, now)})${claim.note ? ` — ${claim.note}` : ""}`);
				continue;
			}
			const line = lineFor(name, [me, ...rivals]).filter((w) => w.peer.id === me.id || now - w.peer.heartbeatAt <= UNRESPONSIVE_MS);
			const first = line[0];
			if (first && first.peer.id !== me.id) conflicts.set(name, `free, but ${first.peer.callsign} is first in line for it and takes it now`);
		}
		return conflicts;
	}

	/**
	 * The teammates whose locks bind this agent: all but its lineal family. The last read, settled
	 * against the debounced team (`presentNow`): a holder whose record one read missed still holds
	 * its lock, and a waiter still has its place, so a claim never jumps either.
	 */
	function lockRivals(me: Presence): Presence[] {
		const present = rt.presentNow(rt.peers);
		const family = lineOf(me, present);
		return rt.team(present).filter((p) => !family.has(p.id));
	}

	/** Put this agent in line for `names` (or keep its place); what it is told about each. */
	function joinLines(
		me: Presence,
		names: readonly string[],
		conflicts: ReadonlyMap<string, string>,
		now: number,
	): { queued: string[]; full: string[]; text: string[] } {
		const queued: string[] = [];
		const full: string[] = [];
		const line = me.queued ?? [];
		for (const name of names) {
			if (!line.some((q) => sameResource(q.pattern, name))) {
				if (line.length >= QUEUED_CAP) {
					full.push(name);
					continue;
				}
				line.push({ pattern: name, since: now });
			}
			queued.push(name);
		}
		if (line.length > 0) me.queued = line;
		const everyone = [me, ...lockRivals(me)];
		const text = queued.map((name) => {
			const order = lineFor(name, everyone).map((w) => w.peer);
			const ahead = order.slice(0, Math.max(0, order.findIndex((p) => p.id === me.id))).map((p) => p.callsign);
			return `queued for ${name}${conflicts.has(name) ? `, ${conflicts.get(name)}` : ""}${ahead.length > 0 ? `; ahead of you: ${ahead.join(", ")}` : ""}. You get it, and are woken, when it frees, so there is nothing to poll. Leave the line with telecom({ action: "release", paths: ["${name}"] }).`;
		});
		if (full.length > 0) {
			text.push(`Not queued for ${full.join(", ")}: you are already in line for ${QUEUED_CAP} locks. Leave one first: telecom({ action: "release", paths: ["…"] }).`);
		}
		return { queued, full, text };
	}

	function claimAction({ me, params, message }: ActionCall): ToolResult {
		const asked = pathsOf(params);
		if (asked.length === 0) return fail('"claim" needs `paths` — project-relative paths or globs, or a lock name such as "@cargo"');
		const patterns: string[] = [];
		const outside: string[] = [];
		const badNames: string[] = [];
		for (const raw of asked) {
			if (isResource(raw)) {
				const name = raw.trim();
				if (!isResourceName(name)) badNames.push(raw);
				else if (!patterns.includes(resourceKey(name))) patterns.push(resourceKey(name));
				continue;
			}
			const pattern = claimPattern(me, raw);
			if (pattern === null) outside.push(raw);
			else if (!patterns.includes(pattern)) patterns.push(pattern);
		}
		// Like a held path below, a path outside the repository does not cost the ones inside it.
		const away = [outside.length > 0 ? outsideRefusal(me, outside) : "", badNames.length > 0 ? badNameRefusal(badNames) : ""]
			.filter(Boolean)
			.join("\n");
		if (patterns.length === 0) return fail(away, { refused: [...outside, ...badNames] });
		const now = Date.now();
		const paths = patterns.filter((p) => !isResource(p));
		const locks = patterns.filter(isResource);
		const { conflicts, lanes } = claimConflicts(me, paths, now);
		const lockHeld = lockConflicts(me, locks, now);
		// A held path does not cost the free ones: models that got an all-or-nothing refusal
		// tended to drop the whole claim and edit unclaimed.
		const held = new Set(conflicts.map((c) => c.mine));
		const grantedPaths = paths.filter((p) => !held.has(p));
		const grantedLocks = locks.filter((l) => !lockHeld.has(l));
		const busyLocks = locks.filter((l) => lockHeld.has(l));
		const line = params.queue === true ? joinLines(me, busyLocks, lockHeld, now) : null;
		const refused = [...held, ...(line ? line.full : busyLocks), ...outside, ...badNames];
		let refusal = "";
		if (conflicts.length > 0) {
			const owners = [...new Set(conflicts.map((c) => c.owner))];
			const key = `${[...held].sort().join("\u0000")}\u0001${owners.sort().join("\u0000")}`;
			const repeated = lastClaimRefusal?.key === key && now - lastClaimRefusal.at < CLAIM_RETRY_WINDOW_MS;
			lastClaimRefusal = { key, at: now };
			refusal = `${conflicts.map((c) => c.what).join("; ")}. ${
				repeated ? `Nothing has changed since this was last refused: retrying will not help. ` : ""
			}Ask ${owners.join(" or ")} to release or split it — telecom({ action: "ask", to: "${owners[0]}", message: "…" }) — or pick other work.`;
		}
		if (!line && busyLocks.length > 0) {
			const one = busyLocks.length === 1;
			const why = busyLocks.map((l) => `${l} is ${lockHeld.get(l)}`).join("; ");
			const queue = `Queue for ${one ? "it" : "them"} — you get ${one ? "it" : "each"}, and are woken, when it frees: telecom({ action: "claim", paths: ${listCall(busyLocks)}, queue: true }).`;
			refusal = [refusal, `${why}. ${queue}`].filter(Boolean).join("\n");
		}
		const queuedText = line?.text ?? [];
		if (grantedPaths.length === 0 && grantedLocks.length === 0 && (line?.queued.length ?? 0) === 0) {
			return fail([refusal, away, ...queuedText].filter(Boolean).join("\n"), { refused });
		}
		// Stored without closing punctuation (a clip "…" stays): it is quoted mid-sentence elsewhere.
		const note = message ? clip(message, CLAIM_NOTE_CAP).replace(/[\s.!?]+$/, "") : "";
		for (const pattern of grantedPaths) {
			me.claims = me.claims.filter((c) => c.pattern !== pattern);
			me.claims.push({ pattern, since: now, expiresAt: now + rt.cfg.claimTtlMs, ...(note ? { note } : {}) });
		}
		const renewed: string[] = [];
		for (const name of grantedLocks) {
			// Claiming a lock again renews it and keeps its `since`: that decides a race, and says how
			// long it has been held. Edits never renew a lock; only this does. An expired claim stays
			// in the record until the heartbeat, but holds nothing: claiming after it is a new claim,
			// or its old `since` would beat the waiter who took the lock meanwhile.
			const prior = me.claims.find((c) => c.pattern === name && c.expiresAt > now);
			if (prior) renewed.push(name);
			const why = note || prior?.note;
			me.claims = me.claims.filter((c) => c.pattern !== name);
			me.claims.push({ pattern: name, since: prior?.since ?? now, expiresAt: now + rt.cfg.claimTtlMs, ...(why ? { note: why } : {}) });
			me.queued = me.queued?.filter((q) => !sameResource(q.pattern, name));
		}
		if (me.queued?.length === 0) delete me.queued;
		rt.publish();
		// Another session may have taken a free lock at this same moment: the earlier claim keeps it,
		// and this one goes first in line.
		const lost = grantedLocks.length > 0 ? waiting.settleRaces(rt.readPeers()) : [];
		rt.updateStatus();
		const taken = grantedLocks.filter((l) => !lost.includes(l) && !renewed.includes(l));
		const kept = renewed.filter((l) => !lost.includes(l));
		// Logged once the races are settled: a lock lost at once was never held. A renewal is not
		// logged: the holder and its `since` stay the same, and the entry that ends the hold (a
		// release, an expiry, a handoff) says when it ended, so one per renewal would only bury
		// what teammates need under a line every few minutes for as long as a build runs.
		const claimed = [...grantedPaths, ...taken];
		if (claimed.length > 0) rt.logEntry("claim", `claimed ${claimed.join(", ")}${note ? ` — ${note}` : ""}`, claimed);
		const ttl = rt.claimTtlMinutes();
		const overlap =
			lanes.length > 0
				? ` Note: ${lanes.join("; ")}. Your checkouts are separate, so both claims stand, but the work meets when the branches merge; agree on one owner if it may conflict.`
				: "";
		const lines: string[] = [];
		if (grantedPaths.length > 0) {
			lines.push(
				`claimed ${grantedPaths.join(", ")}${note ? ` — ${note}` : ""}. Peers editing there are held back and you are told. Release with telecom({ action: "release" }) when done; idle claims expire after ${ttl} min.${overlap}`,
			);
		}
		if (taken.length > 0) {
			lines.push(
				`claimed ${taken.join(", ")}${note ? ` — ${note}` : ""}: yours until you release it — telecom({ action: "release", paths: ${listCall(taken)} }) — and others who claim it are refused and can queue. Edits do not renew a lock: claim it again within ${ttl} min to keep it.`,
			);
		}
		if (kept.length > 0) lines.push(`renewed ${kept.join(", ")}: yours for another ${ttl} min.`);
		if (lost.length > 0) {
			lines.push(`${lost.join(", ")}: another agent took ${lost.length === 1 ? "it" : "them"} at the same moment, first. You are first in line, and woken when it frees.`);
		}
		lines.push(...queuedText);
		if (refusal) lines.push(`Not claimed: ${refusal}`);
		if (away) lines.push(`Not claimed: ${away}`);
		return ok(lines.join("\n"), {
			claims: me.claims.map((c) => c.pattern),
			...(refused.length > 0 ? { refused } : {}),
			...(lanes.length > 0 ? { laneOverlaps: lanes.length } : {}),
			...(line && line.queued.length > 0 ? { queued: line.queued } : {}),
			...(lost.length > 0 ? { lost } : {}),
		});
	}

	function releaseAction({ me, params }: ActionCall): ToolResult {
		const wanted = pathsOf(params).map((p) => (isResource(p) ? resourceKey(p) : p));
		const releasing = wanted.length === 0 ? me.claims : me.claims.filter((c) => wanted.includes(c.pattern));
		// Releasing a lock this agent only waits for leaves the line.
		const leaving = (me.queued ?? []).filter((q) => wanted.length === 0 || wanted.some((w) => sameResource(w, q.pattern)));
		if (releasing.length === 0 && leaving.length === 0) {
			// Nothing held is nothing to undo: a release "just in case" is harmless, not an error.
			if (me.claims.length === 0) return ok("you hold no claims — nothing to release", { released: [] });
			return fail(`none of those match your claims: ${me.claims.map((c) => c.pattern).join(", ")}`);
		}
		if (leaving.length > 0) {
			me.queued = (me.queued ?? []).filter((q) => !leaving.includes(q));
			if (me.queued.length === 0) delete me.queued;
		}
		const names = releasing.map((c) => c.pattern);
		let told: string[] = [];
		if (names.length > 0) told = rt.releaseClaims(me, names);
		else rt.publish();
		const left = leaving.map((q) => q.pattern);
		const parts = [
			names.length > 0 ? `released ${names.join(", ")}${told.length ? ` — told ${told.join(", ")}, who had been waiting` : ""}` : "",
			left.length > 0 ? `left the queue for ${left.join(", ")}` : "",
		].filter(Boolean);
		return ok(parts.join("; "), { released: names, ...(left.length > 0 ? { leftQueue: left } : {}) });
	}

	/** The team log: what was broadcast, set, claimed and released, and who came and went. */
	function logAction({ me, params }: ActionCall): ToolResult {
		const wanted = pathsOf(params);
		const all = rt.teamLog();
		const matching = wanted.length > 0 ? all.filter((e) => entryTouches(e, wanted, me.projectRoot)) : all;
		const shown = matching.slice(-LOG_SHOWN);
		const text = renderLog(shown, { self: me.id, total: matching.length, paths: wanted });
		return ok(text, { entries: shown.length, total: matching.length });
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
		log: logAction,
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
