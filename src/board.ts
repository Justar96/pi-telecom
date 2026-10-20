/**
 * board — the team as text: for the `telecom` tool, the `/telecom` command, and the brief the
 * model is handed when a new prompt starts.
 */
import { displayPath } from "./project.ts";
import type { Presence } from "./transport.ts";
import { ago, clip, plural } from "./util.ts";

const RECENT_SHOWN = 4;

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
	lines.push(`• ${label(peer)} [${peer.state}]${branch}${where}${you}  id ${peer.id.slice(0, 8)}`);
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
	for (const peer of others) lines.push(...describePeer(peer, root));
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

/**
 * The brief a new prompt starts with: only same-project peers, compact, and only when something
 * changed since the last brief (the caller compares `signature`).
 */
export function renderBrief(self: Presence, peers: readonly Presence[]): { text: string; signature: string } | null {
	const root = self.projectRoot;
	const now = Date.now();
	const team = peers.filter((p) => p.id !== self.id && p.projectRoot === root);
	if (team.length === 0) return null;
	const signature = JSON.stringify(
		team.map((p) => [
			p.id,
			p.callsign,
			p.task ?? "",
			liveClaims(p, now).map((c) => c.pattern),
			p.recent.slice(0, RECENT_SHOWN).map((r) => r.path),
		]),
	);
	const lines = [
		`📡 Telecom — you are "${self.callsign}". ${plural(team.length, "other agent")} ${team.length === 1 ? "is" : "are"} working in this project right now:`,
	];
	for (const peer of team) lines.push(...describePeer(peer, root, { now }));
	lines.push(
		"Stay out of their claimed paths, re-read files they changed before editing, and use the telecom tool to coordinate when your work overlaps theirs.",
	);
	return { text: lines.join("\n"), signature };
}
