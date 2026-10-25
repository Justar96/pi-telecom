/**
 * address — whom a message is for, and what its sender is told about them: an agent named by
 * callsign, session name or id, or the agent that owns some paths (`ownerOf`, AGENTS.md
 * "Addressing by path"); and whether the message reaches it now (`stateHint`). Pure: it reads
 * presence records and decides; the caller delivers.
 */
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { idleFor } from "./board.ts";
import { blockedOnMe, isForegroundChild } from "./family.ts";
import { claimMatcher, claimsOverlap, laneRelativePattern } from "./glob.ts";
import { displayPath, inCheckout, laneName, sameRepo } from "./project.ts";
import type { Presence } from "./transport.ts";
import { ago, elapsed, idMatches, shortId } from "./util.ts";

/** A partial id shorter than this is too likely to match by accident. */
const MIN_ID_PREFIX = 4;
/**
 * A peer's published step older than this is named to a sender: the peer is inside one long call,
 * so "before their next step" would mislead. Below it the call is likely to end soon.
 */
export const LONG_STEP_MS = 60_000;
/** Asks a teammate owes before a sender is told to expect a wait. */
const OWED_HINT_FROM = 2;

/** `via`: how a target found by path was picked ("claims …", "changed … ago"), for the result. */
export type Target = { ok: true; peer: Presence; via?: string } | { ok: false; reason: string };

/**
 * Who `raw` names, most specific match first: a callsign in this project, a callsign anywhere,
 * a session name, a full id, then part of an id (its start, or the short form the board shows).
 * An ambiguous match is refused with the choices.
 */
export function resolveTarget(raw: string, self: Presence, peers: readonly Presence[]): Target {
	const to = raw.trim().replace(/^@/, "");
	const lower = to.toLowerCase();
	const others = peers.filter((p) => p.id !== self.id);
	const sameProject = others.filter((p) => sameRepo(p, self));
	const pick = (list: Presence[], what: string): Target | null => {
		if (list.length === 1) return { ok: true, peer: list[0] as Presence };
		if (list.length > 1) {
			return {
				ok: false,
				reason: `"${to}" is the ${what} of ${list.length} sessions — use an id: ${list.map((p) => `${shortId(p.id)} (${p.callsign} in ${p.projectRoot})`).join(", ")}`,
			};
		}
		return null;
	};
	if (lower === self.callsign || to === self.id) {
		return { ok: false, reason: "that is you — a message to yourself would arrive as your own turn" };
	}
	return (
		pick(sameProject.filter((p) => p.callsign === lower), "callsign") ??
		pick(others.filter((p) => p.callsign === lower), "callsign") ??
		pick(others.filter((p) => p.name === to), "name") ??
		pick(others.filter((p) => p.id === to), "id") ??
		pick(others.filter((p) => idMatches(p.id, to, MIN_ID_PREFIX)), "id") ?? {
			ok: false,
			reason: `no live agent answers to "${to}". ${
				sameProject.length > 0
					? `In this project: ${sameProject.map((p) => p.callsign).join(", ")}.`
					: "No other agent is live in this project."
			} telecom({ action: "board" }) shows everyone.`,
		}
	);
}

/**
 * The agent to reach about `patterns`: whoever claims them (in this checkout first), else
 * whoever changed a file there most recently. Refused, with the choices, when several claim.
 * `action` is the tool action asking, for the exact call a refusal suggests.
 */
export function ownerOf(patterns: readonly string[], action: string, self: Presence, peers: readonly Presence[]): Target {
	const now = Date.now();
	const team = peers.filter((p) => p.id !== self.id && sameRepo(p, self));
	const claimants: Array<{ peer: Presence; pattern: string; lane: boolean }> = [];
	for (const peer of team) {
		const lane = peer.projectRoot !== self.projectRoot;
		const claim = peer.claims.find((c) => {
			if (c.expiresAt <= now) return false;
			const pattern = lane ? laneRelativePattern(c.pattern, peer.projectRoot) : c.pattern;
			return pattern !== null && patterns.some((p) => claimsOverlap(p, pattern, self.projectRoot));
		});
		if (claim) claimants.push({ peer, pattern: claim.pattern, lane });
	}
	const local = claimants.filter((c) => !c.lane);
	const pool = local.length > 0 ? local : claimants;
	const only = pool[0];
	if (pool.length === 1 && only) {
		return { ok: true, peer: only.peer, via: `claims "${only.pattern}"${only.lane ? ` in ${laneName(only.peer)}` : ""}` };
	}
	if (pool.length > 1) {
		return {
			ok: false,
			reason: `${patterns.join(", ")} spans the claims of ${pool.map((c) => `${c.peer.callsign} ("${c.pattern}")`).join(", ")}. Pick one: telecom({ action: "${action}", to: "${pool[0]?.peer.callsign}", message: "…" }).`,
		};
	}
	const inside = patterns.map((p) => claimMatcher(p, self.projectRoot));
	let latest: { peer: Presence; path: string; at: number } | null = null;
	for (const peer of team) {
		for (const r of peer.recent) {
			const mine = inCheckout(r.path, peer.projectRoot, self.projectRoot);
			if (mine && inside.some((match) => match(mine)) && (!latest || r.at > latest.at)) latest = { peer, path: mine, at: r.at };
		}
	}
	if (latest) {
		return { ok: true, peer: latest.peer, via: `changed ${displayPath(latest.path, self.projectRoot)} ${ago(latest.at)}` };
	}
	return {
		ok: false,
		reason: `no other agent claims or recently changed ${patterns.join(", ")}. telecom({ action: "board" }) shows who works on what; telecom({ action: "broadcast", paths: [${patterns.map((p) => JSON.stringify(p)).join(", ")}], message: "…" }) reaches whoever works there.`,
	};
}

/** "bravo", or `bravo, which claims "src/db/**"` for a target found by path. */
export function targetName(target: Target & { ok: true }): string {
	return target.via ? `${target.peer.callsign}, which ${target.via}` : target.peer.callsign;
}

/** When a message to `peer` reaches its model, as its sender is told (`deferred`: sent with `interrupt: false`). */
export function stateHint(peer: Presence, self: Presence, peers: readonly Presence[], deferred = false): string {
	if (Date.now() - peer.heartbeatAt > UNRESPONSIVE_MS) {
		return `unresponsive since ${ago(peer.heartbeatAt)} — it waits in their inbox until they are back`;
	}
	if (peer.state === "busy") {
		// `interrupt: false`: held by the recipient's runtime, whatever it is inside of.
		if (deferred) return `busy — it reaches them when their current run ends${owedHint(peer)}`;
		if (peer.waitingOn?.length) {
			const on = peer.waitingOn.map((id) => (id === self.id ? "you" : (peers.find((p) => p.id === id)?.callsign ?? shortId(id))));
			if (on.includes("you")) return `busy waiting on your answer — an ask from you reaches it now (a wait cycle), anything else after you answer`;
			return `busy waiting on ${on.join(", ")}${peer.waitingSince ? ` (asked ${ago(peer.waitingSince)})` : ""} — it reads this when that wait ends`;
		}
		// A session waiting on a foreground subagent is inside one long tool call: nothing
		// reaches its model until that subagent's run ends.
		if (blockedOnMe(self, peer, peers)) return "busy waiting for your run to end — it reads this after you finish";
		const child = peers.find((c) => c.state === "busy" && isForegroundChild(c, peer));
		if (child) return `busy waiting on its subagent ${child.callsign} — it reads this when that run ends`;
		// One long call (a test suite, a build, a subagent): nothing reaches its model until it ends,
		// and an ask that waits for it may time out first.
		const step = peer.step;
		if (step && Date.now() - step.since >= LONG_STEP_MS) {
			return `busy in ${step.tool} for ${elapsed(step.since)} — it reads this when that call ends. A blocking ask may time out before then; telecom({ action: "ask", to: "${peer.callsign}", message: "…", wait: false }) returns at once`;
		}
		return `busy — it reaches them before their next step${owedHint(peer)}`;
	}
	// A run started for a message ended without the model acting on it: telecom re-wakes it, but
	// whoever waits on it should know the session may be stuck.
	if (peer.unreadSince !== undefined) {
		return `idle, and has not acted on a message it got ${ago(peer.unreadSince)}: its session may be stuck. This is re-sent to it, but if it is urgent, tell your human`;
	}
	const idle = idleFor(peer);
	return `${idle ? `idle for ${idle} — this wakes them` : "idle — this wakes them"}${owedHint(peer)}`;
}

/** A teammate with asks to answer before this one: the sender should expect a wait. */
function owedHint(peer: Presence): string {
	return peer.asksOwed && peer.asksOwed >= OWED_HINT_FROM ? `; it already owes ${peer.asksOwed} other asks, so expect a wait` : "";
}
