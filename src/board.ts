/**
 * board — the team as text: for the `telecom` tool, the `/telecom` command, and the brief the
 * model is handed when a new prompt starts.
 *
 * The team is every agent in the repository: the same checkout, or another worktree of it (a
 * lane, shown with where it works). A subagent is listed right under its parent on the board;
 * in a brief it folds into its parent's entry, since subagents come and go too often to be news.
 *
 * Briefs scale with the team by RELEVANCE: in a small team every peer is described, but past a
 * few peers only those whose work touches this agent's are (their claims or recent changes meet
 * the files it works with or its claims, it has talked with them, or they are its siblings), and
 * the rest share a one-line roster. Otherwise every task change would reach every agent, and the
 * team would pay for its own size squared.
 */
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { lineOf } from "./family.ts";
import { claimMatcher, claimsOverlap, laneRelativePattern } from "./glob.ts";
import { displayPath, inCheckout, laneName, sameRepo } from "./project.ts";
import type { Presence } from "./transport.ts";
import { ago, clip, plural, shortId } from "./util.ts";

const RECENT_SHOWN = 4;
/** The board lists at most this many agents; a result the model reads must stay bounded. */
const MAX_LISTED = 25;
/** Family chains are short; this bounds a walk over hostile records. */
const MAX_DEPTH = 16;
/** With this many other agents or fewer, a brief describes each of them, relevant or not. */
const DESCRIBE_ALL_UP_TO = 3;
/** A brief describes at most this many agents in full; the rest go on the roster. */
const MAX_DESCRIBED = 6;

function label(peer: Presence, viewer: Presence, peers: readonly Presence[]): string {
	const name = peer.name && peer.name !== peer.callsign ? ` "${clip(peer.name, 30)}"` : "";
	let role = "";
	if (peer.role === "child") {
		const parent = peer.parent === viewer.id ? viewer : peers.find((p) => p.id === peer.parent);
		role = parent === viewer && peer.id !== viewer.id ? " (your subagent)" : parent ? ` (subagent of ${parent.callsign})` : " (subagent)";
	}
	return `${peer.callsign}${name}${role}`;
}

/** Peers in start order, each followed by its subagents, so a family reads as one block. */
function familyOrder(list: readonly Presence[]): Presence[] {
	const ids = new Set(list.map((p) => p.id));
	const children = new Map<string, Presence[]>();
	const tops: Presence[] = [];
	for (const p of list) {
		if (p.parent && ids.has(p.parent)) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
		else tops.push(p);
	}
	const out: Presence[] = [];
	const done = new Set<string>();
	const visit = (p: Presence, depth: number): void => {
		if (done.has(p.id) || depth > MAX_DEPTH) return;
		done.add(p.id);
		out.push(p);
		for (const child of children.get(p.id) ?? []) visit(child, depth + 1);
	};
	for (const p of tops) visit(p, 0);
	// A parent cycle (only a hostile record could make one) still lists everyone.
	for (const p of list) if (!done.has(p.id)) out.push(p);
	return out;
}

function liveClaims(peer: Presence, now: number): Presence["claims"] {
	return peer.claims.filter((c) => c.expiresAt > now);
}

/** One peer, as a block of lines, as `viewer` sees it. `peers` name a subagent's parent. */
export function describePeer(
	peer: Presence,
	viewer: Presence,
	opts: { self?: boolean; now?: number; peers?: readonly Presence[]; waits?: boolean } = {},
): string[] {
	const now = opts.now ?? Date.now();
	const lines: string[] = [];
	const where =
		peer.projectRoot === viewer.projectRoot ? "" : sameRepo(peer, viewer) ? `  in ${laneName(peer)}` : `  in ${peer.projectRoot}`;
	const branch = peer.branch ? ` on ${peer.branch}` : "";
	const you = opts.self ? " — you" : "";
	let state =
		!opts.self && now - peer.heartbeatAt > UNRESPONSIVE_MS
			? `unresponsive, last seen ${ago(peer.heartbeatAt, now)}`
			: peer.state;
	if (opts.waits && peer.waitingOn?.length) {
		const on = peer.waitingOn.map((id) =>
			id === viewer.id ? "you" : ((opts.peers ?? []).find((p) => p.id === id)?.callsign ?? shortId(id)),
		);
		state += `, waiting on ${on.join(", ")}${peer.waitingSince ? ` (asked ${ago(peer.waitingSince, now)})` : ""}`;
	}
	lines.push(`• ${label(peer, viewer, opts.peers ?? [])} [${state}]${branch}${where}${you}  id ${shortId(peer.id)}`);
	if (peer.task) lines.push(`    task: ${clip(peer.task, 140)}${peer.taskAt ? ` (${ago(peer.taskAt, now)})` : ""}`);
	const claims = liveClaims(peer, now);
	if (claims.length > 0) {
		lines.push(
			`    claims: ${claims.map((c) => `${c.pattern}${c.note ? ` — ${clip(c.note, 60)}` : ""}`).join("; ")}`,
		);
	}
	const recent = [...peer.recent].sort((a, b) => b.at - a.at).slice(0, RECENT_SHOWN);
	if (recent.length > 0) {
		lines.push(
			`    recently changed: ${recent.map((r) => `${displayPath(r.path, peer.projectRoot)} (${ago(r.at, now)})`).join(", ")}`,
		);
	}
	return lines;
}

export interface BoardInput {
	self: Presence;
	peers: readonly Presence[];
	scope: "project" | "machine";
	inboundAsks: ReadonlyArray<{ id: string; fromCallsign: string; text: string }>;
}

/** The full board: the `telecom` tool's `board` action and the `/telecom` command. */
export function renderBoard(input: BoardInput): string {
	const { self, scope } = input;
	const root = self.projectRoot;
	const others = familyOrder(input.peers.filter((p) => p.id !== self.id && (scope === "machine" || sameRepo(p, self))));
	const lines: string[] = [];
	const where =
		scope === "machine"
			? "on this machine"
			: others.some((p) => p.projectRoot !== root)
				? `in ${root} and other checkouts of its repository`
				: `in ${root}`;
	lines.push(
		others.length === 0
			? `📡 You are ${self.callsign}. No other agent is live ${where}.`
			: `📡 You are ${self.callsign}. ${plural(others.length, "other agent")} live ${where}:`,
	);
	for (const peer of others.slice(0, MAX_LISTED)) lines.push(...describePeer(peer, self, { peers: input.peers, waits: true }));
	if (others.length > MAX_LISTED) lines.push(`… and ${others.length - MAX_LISTED} more`);
	lines.push("", ...describePeer(self, self, { self: true, peers: input.peers }));
	if (input.inboundAsks.length > 0) {
		lines.push("", `Unanswered asks (a peer is blocked waiting — answer with action "reply"):`);
		for (const ask of input.inboundAsks) {
			lines.push(`  ${ask.id} from ${ask.fromCallsign}: ${clip(ask.text, 120)}`);
		}
	}
	if (scope === "project") {
		const elsewhere = input.peers.filter((p) => p.id !== self.id && !sameRepo(p, self)).length;
		if (elsewhere > 0) lines.push("", `(${plural(elsewhere, "more agent")} in other projects — scope "machine" lists them)`);
	}
	return lines.join("\n");
}

/** What a brief is about: membership, callsigns, tasks and claims — not every file touched
 *  (relevant file changes reach the agent as change notices instead). */
export interface BriefState {
	/**
	 * Per unit: `task` and `claims` as this agent was last TOLD them (a far peer's changes are held
	 * back, and must still read as news once it comes near), `holders` the session holding each
	 * current claim, `members` its folded subagents, and `described`: whether it was described in
	 * full (not only named on the roster).
	 */
	peers: Map<
		string,
		{ callsign: string; task: string; claims: string[]; holders: Map<string, string>; members: string[]; described: boolean }
	>;
	fullAt: number;
}

/** What makes a peer relevant to this agent. */
export interface Focus {
	/** The files this agent works with (canonical paths in its own checkout). */
	paths: ReadonlySet<string>;
	/** Sessions this agent has messaged or heard from directly. */
	contacts: ReadonlySet<string>;
}

const NO_FOCUS: Focus = { paths: new Set(), contacts: new Set() };

/** A full brief is repeated at most this often; in between, only what changed is sent. */
const FULL_BRIEF_EVERY_MS = 30 * 60_000;

/** One entry of a brief: a peer, and the subagents folded into it. */
interface Unit {
	peer: Presence;
	subagents: Presence[];
}

/**
 * Whom a brief is about. Other agents' subagents fold into their top-level parent's entry: they
 * come and go too often to be team news, though their claims are listed (they bind like anyone's).
 * This agent's own line — its parent chain and its subagents — is left out: it knows them, and a
 * lone user's subagents cost no tokens. Its siblings are listed on their own, since they work in
 * parallel with it.
 */
function briefUnits(self: Presence, team: readonly Presence[]): Unit[] {
	const line = lineOf(self, team);
	const byId = new Map(team.map((p) => [p.id, p]));
	const units = new Map<string, Unit>();
	for (const p of team) {
		if (line.has(p.id)) continue;
		let top = p;
		for (let depth = 0; depth < MAX_DEPTH; depth++) {
			const parent = top.parent ? byId.get(top.parent) : undefined;
			if (!parent || line.has(parent.id)) break;
			top = parent;
		}
		const unit = units.get(top.id) ?? { peer: top, subagents: [] };
		if (top !== p) unit.subagents.push(p);
		units.set(top.id, unit);
	}
	return [...units.values()].sort((a, b) => a.peer.startedAt - b.peer.startedAt);
}

/** A unit's claims, a subagent's marked with its callsign: the brief's record of who holds what. */
function unitClaims(unit: Unit, now: number): string[] {
	return [...claimHolders(unit, now).keys()].sort();
}

/** Each of a unit's claims, as the brief shows it, with the session that holds it. */
function claimHolders(unit: Unit, now: number): Map<string, string> {
	const holders = new Map<string, string>();
	for (const c of liveClaims(unit.peer, now)) holders.set(c.pattern, unit.peer.id);
	for (const s of unit.subagents) for (const c of liveClaims(s, now)) holders.set(`${c.pattern} (by ${s.callsign})`, s.id);
	return holders;
}

/** Does `member`'s work touch this agent's? */
function touches(member: Presence, self: Presence, focus: Focus, now: number): boolean {
	if (focus.contacts.has(member.id)) return true;
	if (member.parent !== undefined && member.parent === self.parent) return true;
	const otherLane = member.projectRoot !== self.projectRoot;
	for (const r of member.recent) {
		const mine = otherLane ? inCheckout(r.path, member.projectRoot, self.projectRoot) : r.path;
		if (mine && focus.paths.has(mine)) return true;
	}
	for (const claim of liveClaims(member, now)) {
		const pattern = otherLane ? laneRelativePattern(claim.pattern, member.projectRoot) : claim.pattern;
		if (pattern === null) continue;
		if (liveClaims(self, now).some((c) => claimsOverlap(c.pattern, pattern, self.projectRoot))) return true;
		const inside = claimMatcher(pattern, self.projectRoot);
		for (const path of focus.paths) if (inside(path)) return true;
	}
	return false;
}

function unitTouches(unit: Unit, self: Presence, focus: Focus, now: number): boolean {
	return touches(unit.peer, self, focus, now) || unit.subagents.some((s) => touches(s, self, focus, now));
}

/** A unit as one roster entry: who, what, and what they hold. */
function rosterEntry(unit: Unit, now: number): string {
	const claims = unitClaims(unit, now);
	const folded = unit.subagents.length > 0 ? ` +${plural(unit.subagents.length, "subagent")}` : "";
	return `${unit.peer.callsign} [${unit.peer.state}]${unit.peer.task ? ` ${clip(unit.peer.task, 40)}` : ""}${folded}${
		claims.length > 0 ? ` (claims ${claims.join(", ")})` : ""
	}`;
}

function stateOf(units: readonly Unit[], now: number, described: ReadonlySet<string>): BriefState["peers"] {
	return new Map(
		units.map((u) => [
			u.peer.id,
			{
				callsign: u.peer.callsign,
				task: u.peer.task ?? "",
				claims: unitClaims(u, now),
				holders: claimHolders(u, now),
				members: u.subagents.map((s) => s.id),
				described: described.has(u.peer.id),
			},
		]),
	);
}

function describeUnit(unit: Unit, self: Presence, peers: readonly Presence[], now: number): string[] {
	const lines = describePeer(unit.peer, self, { now, peers });
	if (unit.subagents.length === 0) return lines;
	const subagents = unit.subagents.map((s) => `${s.callsign} [${s.state}]${s.task ? ` ${clip(s.task, 50)}` : ""}`);
	lines.push(`    subagents: ${subagents.join("; ")}`);
	const claims = unit.subagents.flatMap((s) =>
		liveClaims(s, now).map((c) => `${c.pattern}${c.note ? ` — ${clip(c.note, 60)}` : ""} (${s.callsign})`),
	);
	if (claims.length > 0) lines.push(`    subagent claims: ${claims.join("; ")}`);
	return lines;
}

/**
 * The brief a new prompt starts with. The first one (and one every half hour) describes the team:
 * every peer in a small team, else the peers whose work touches this agent's (`focus`), with the
 * rest on a roster line. After that only the changes are sent — joins, leaves, claims taken or
 * released, a callsign change, and task changes of the peers that touch this agent's work — and
 * nothing at all when nothing changed. A rostered peer whose work comes near this agent's is
 * described once, when it does. Returns the text to send (or null) and the state to compare the
 * next brief against.
 */
export function renderBrief(
	self: Presence,
	peers: readonly Presence[],
	previous: BriefState | null,
	focus: Focus = NO_FOCUS,
): { text: string | null; summary: string; state: BriefState } {
	const now = Date.now();
	const team = peers.filter((p) => p.id !== self.id && sameRepo(p, self));
	const all = [self, ...team];
	const units = briefUnits(self, team);
	const everyone = units.length <= DESCRIBE_ALL_UP_TO;
	const relevant = new Set(units.filter((u) => everyone || unitTouches(u, self, focus, now)).map((u) => u.peer.id));
	const summary = units
		.map((u) => `${u.peer.callsign} (${u.peer.state}${u.peer.task ? `: ${clip(u.peer.task, 40)}` : ""})`)
		.join(" · ");
	if (!previous && units.length === 0) return { text: null, summary, state: { peers: new Map(), fullAt: 0 } };
	const parent = self.parent ? peers.find((p) => p.id === self.parent) : undefined;
	const you = `you are "${self.callsign}"${parent ? `, a subagent of ${parent.callsign}` : ""}`;

	if (!previous || (units.length > 0 && now - previous.fullAt > FULL_BRIEF_EVERY_MS)) {
		const described = units.filter((u) => relevant.has(u.peer.id)).slice(0, MAX_DESCRIBED);
		const ids = new Set(described.map((u) => u.peer.id));
		const roster = units.filter((u) => !ids.has(u.peer.id));
		const folded = units.reduce((n, u) => n + u.subagents.length, 0);
		const others = `${plural(units.length, "other agent")}${folded > 0 ? ` (and ${plural(folded, "subagent")})` : ""}`;
		const lines = [
			`📡 Telecom — ${you}. ${others} ${units.length === 1 && folded === 0 ? "is" : "are"} working in this ${
				units.some((u) => u.peer.projectRoot !== self.projectRoot) ? "repository" : "project"
			} right now:`,
		];
		for (const unit of described) lines.push(...describeUnit(unit, self, all, now));
		if (roster.length > 0) {
			const listed = roster.slice(0, MAX_LISTED).map((u) => rosterEntry(u, now));
			if (roster.length > MAX_LISTED) listed.push(`… and ${roster.length - MAX_LISTED} more`);
			lines.push(`${described.length > 0 ? "Also here, not near your work so far" : "None of them is near your work so far"}: ${listed.join("; ")}`);
		}
		lines.push(
			"Stay out of their claimed paths, re-read files they changed before editing, and use the telecom tool to coordinate when your work overlaps theirs.",
		);
		return { text: lines.join("\n"), summary, state: { peers: stateOf(units, now, ids), fullAt: now } };
	}

	const current = stateOf(units, now, new Set());
	const described = new Set<string>();
	let describedNow = 0;
	const describe = (unit: Unit, label: string): string[] => {
		described.add(unit.peer.id);
		describedNow++;
		return describeUnit(unit, self, all, now).map((l, i) => (i === 0 ? l.replace(/^• /, `• ${label}: `) : l));
	};
	const changes: string[] = [];
	/** Far units whose news was held back: what this agent still knows of their task and claims. */
	const held = new Map<string, { task: string; claims: string[] }>();
	// A subagent folded into a unit last time, now a unit of its own: its parent left, it stayed.
	const foldedInto = new Map<string, string>();
	for (const before of previous.peers.values()) for (const id of before.members) foldedInto.set(id, before.callsign);
	for (const unit of units) {
		const peer = unit.peer;
		const before = previous.peers.get(peer.id);
		const after = current.get(peer.id);
		if (!after) continue;
		const near = relevant.has(peer.id) && describedNow < MAX_DESCRIBED;
		if (!before) {
			const parentLeft = foldedInto.get(peer.id);
			const label = parentLeft ? `carries on after ${parentLeft} left` : "joined";
			changes.push(...(near ? describe(unit, label) : [`• ${label}: ${rosterEntry(unit, now)}`]));
			continue;
		}
		if (before.described) described.add(peer.id);
		if (before.callsign !== after.callsign) changes.push(`• ${before.callsign} is now called ${after.callsign}`);
		if (near && !before.described) {
			// The description carries its task and claims, so nothing below is repeated.
			changes.push(...describe(unit, "now working near you"));
			continue;
		}
		const name = before.callsign !== after.callsign ? `${before.callsign} (now ${after.callsign})` : after.callsign;
		if (!relevant.has(peer.id)) {
			// Far from this agent's work: its task and new claims are not news yet. The guard still
			// stops an edit inside its claims, and a claim over this agent's files makes it near.
			// A release of a claim this agent was told about is news: it may be keeping out of it.
			const dropped = before.claims.filter((c) => !after.claims.includes(c));
			if (dropped.length) changes.push(`• ${name} released ${dropped.join(", ")}`);
			held.set(peer.id, { task: before.task, claims: before.claims.filter((c) => after.claims.includes(c)) });
			continue;
		}
		if (before.task !== after.task && after.task) changes.push(`• ${name} is now on: ${clip(after.task, 140)}`);
		const added = after.claims.filter((c) => !before.claims.includes(c));
		const dropped = before.claims.filter((c) => !after.claims.includes(c));
		if (added.length) changes.push(`• ${name} claimed ${added.join(", ")}`);
		if (dropped.length) changes.push(`• ${name} released ${dropped.join(", ")}`);
	}
	// Every session still here, folded or not: a leaving unit's claims held by one of them are not free.
	const present = new Set(units.flatMap((u) => [u.peer.id, ...u.subagents.map((s) => s.id)]));
	for (const [id, before] of previous.peers) {
		if (current.has(id)) continue;
		const free = [...before.holders.keys()].filter((c) => !present.has(before.holders.get(c) ?? id)).sort();
		changes.push(`• ${before.callsign} left${free.length ? ` (its claims ${free.join(", ")} are free)` : ""}`);
	}
	const state = { peers: stateOf(units, now, described), fullAt: previous.fullAt };
	for (const [id, told] of held) {
		const entry = state.peers.get(id);
		if (entry) Object.assign(entry, told);
	}
	if (changes.length === 0) return { text: null, summary, state };
	const head =
		units.length === 0
			? `📡 Telecom — team update: you ("${self.callsign}") are now the only agent in this project.`
			: `📡 Telecom — team update (${you}):`;
	return { text: [head, ...changes].join("\n"), summary, state };
}
