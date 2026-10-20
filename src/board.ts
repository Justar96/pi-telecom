/**
 * board — the team as text: for the `telecom` tool, the `/telecom` command, and the brief the
 * model is handed when a new prompt starts.
 */
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { displayPath } from "./project.ts";
import type { Presence } from "./transport.ts";
import { ago, clip, plural, shortId } from "./util.ts";

const RECENT_SHOWN = 4;
/** The board lists at most this many agents; a result the model reads must stay bounded. */
const MAX_LISTED = 25;

function label(peer: Presence): string {
	const name = peer.name && peer.name !== peer.callsign ? ` "${clip(peer.name, 30)}"` : "";
	const role = peer.role === "child" ? " (subagent)" : "";
	return `${peer.callsign}${name}${role}`;
}

function liveClaims(peer: Presence, now: number): Presence["claims"] {
	return peer.claims.filter((c) => c.expiresAt > now);
}

/** One peer, as a block of lines. */
export function describePeer(peer: Presence, root: string, opts: { self?: boolean; now?: number } = {}): string[] {
	const now = opts.now ?? Date.now();
	const lines: string[] = [];
	const where = peer.projectRoot === root ? "" : `  in ${peer.projectRoot}`;
	const branch = peer.branch ? ` on ${peer.branch}` : "";
	const you = opts.self ? " — you" : "";
	const state =
		!opts.self && now - peer.heartbeatAt > UNRESPONSIVE_MS
			? `unresponsive, last seen ${ago(peer.heartbeatAt, now)}`
			: peer.state;
	lines.push(`• ${label(peer)} [${state}]${branch}${where}${you}  id ${shortId(peer.id)}`);
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
	const others = input.peers.filter(
		(p) => p.id !== self.id && (scope === "machine" || p.projectRoot === root),
	);
	const lines: string[] = [];
	const where = scope === "machine" ? "on this machine" : `in ${root}`;
	lines.push(
		others.length === 0
			? `📡 You are ${self.callsign}. No other agent is live ${where}.`
			: `📡 You are ${self.callsign}. ${plural(others.length, "other agent")} live ${where}:`,
	);
	for (const peer of others.slice(0, MAX_LISTED)) lines.push(...describePeer(peer, root));
	if (others.length > MAX_LISTED) lines.push(`… and ${others.length - MAX_LISTED} more`);
	lines.push("", ...describePeer(self, root, { self: true }));
	if (input.inboundAsks.length > 0) {
		lines.push("", `Unanswered asks (a peer is blocked waiting — answer with action "reply"):`);
		for (const ask of input.inboundAsks) {
			lines.push(`  ${ask.id} from ${ask.fromCallsign}: ${clip(ask.text, 120)}`);
		}
	}
	if (scope === "project") {
		const elsewhere = input.peers.filter((p) => p.id !== self.id && p.projectRoot !== root).length;
		if (elsewhere > 0) lines.push("", `(${plural(elsewhere, "more agent")} in other projects — scope "machine" lists them)`);
	}
	return lines.join("\n");
}

/** What a brief is about: membership, callsigns, tasks and claims — not every file touched
 *  (relevant file changes reach the agent as change notices instead). */
export interface BriefState {
	peers: Map<string, { callsign: string; task: string; claims: string[] }>;
	fullAt: number;
}

/** A full brief is repeated at most this often; in between, only what changed is sent. */
const FULL_BRIEF_EVERY_MS = 30 * 60_000;

function stateOf(team: readonly Presence[], now: number): BriefState["peers"] {
	return new Map(
		team.map((p) => [
			p.id,
			{ callsign: p.callsign, task: p.task ?? "", claims: liveClaims(p, now).map((c) => c.pattern).sort() },
		]),
	);
}

/**
 * The brief a new prompt starts with. The first one (and one every half hour) describes the whole
 * team; after that only the changes are sent — who joined or left, new tasks, new or released
 * claims — and nothing at all when nothing changed. Returns the text to send (or null) and the
 * state to compare the next brief against.
 */
export function renderBrief(
	self: Presence,
	peers: readonly Presence[],
	previous: BriefState | null,
): { text: string | null; summary: string; state: BriefState } {
	const root = self.projectRoot;
	const now = Date.now();
	const team = peers.filter((p) => p.id !== self.id && p.projectRoot === root);
	const current = stateOf(team, now);
	const summary = team
		.map((p) => `${p.callsign} (${p.state}${p.task ? `: ${clip(p.task, 40)}` : ""})`)
		.join(" · ");
	if (!previous && team.length === 0) return { text: null, summary, state: { peers: current, fullAt: 0 } };
	if (!previous || (team.length > 0 && now - previous.fullAt > FULL_BRIEF_EVERY_MS)) {
		const state = { peers: current, fullAt: now };
		const lines = [
			`📡 Telecom — you are "${self.callsign}". ${plural(team.length, "other agent")} ${team.length === 1 ? "is" : "are"} working in this project right now:`,
		];
		for (const peer of team) lines.push(...describePeer(peer, root, { now }));
		lines.push(
			"Stay out of their claimed paths, re-read files they changed before editing, and use the telecom tool to coordinate when your work overlaps theirs.",
		);
		return { text: lines.join("\n"), summary, state };
	}
	const changes: string[] = [];
	for (const peer of team) {
		const before = previous.peers.get(peer.id);
		const now_ = current.get(peer.id);
		if (!now_) continue;
		if (!before) {
			changes.push(...describePeer(peer, root, { now }).map((l, i) => (i === 0 ? l.replace(/^• /, "• joined: ") : l)));
			continue;
		}
		const name = before.callsign !== now_.callsign ? `${before.callsign} (now ${now_.callsign})` : now_.callsign;
		if (before.callsign !== now_.callsign) changes.push(`• ${before.callsign} is now called ${now_.callsign}`);
		if (before.task !== now_.task && now_.task) changes.push(`• ${name} is now on: ${clip(now_.task, 140)}`);
		const added = now_.claims.filter((c) => !before.claims.includes(c));
		const dropped = before.claims.filter((c) => !now_.claims.includes(c));
		if (added.length) changes.push(`• ${name} claimed ${added.join(", ")}`);
		if (dropped.length) changes.push(`• ${name} released ${dropped.join(", ")}`);
	}
	for (const [id, before] of previous.peers) {
		if (!current.has(id)) changes.push(`• ${before.callsign} left${before.claims.length ? ` (its claims ${before.claims.join(", ")} are free)` : ""}`);
	}
	const state = { peers: current, fullAt: previous.fullAt };
	if (changes.length === 0) return { text: null, summary, state };
	const head =
		team.length === 0
			? `📡 Telecom — team update: you ("${self.callsign}") are now the only agent in this project.`
			: `📡 Telecom — team update (you are "${self.callsign}"):`;
	return { text: [head, ...changes].join("\n"), summary, state };
}
