/**
 * family — subagents: which session started this one, and who counts as its lineal family.
 *
 * pi-subagents runs a child session in one of two places:
 *   - FOREGROUND: inside the parent's own pi process, while the parent waits in its `subagent`
 *     tool call. Nothing in the environment marks it. Its session header names the parent's
 *     session file, and that parent is live in this very process.
 *   - BACKGROUND: in a detached runner process, which pi-subagents marks with
 *     `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_PARENT_SESSION=<the root parent's id>` and
 *     `PI_SUBAGENT_RUNNER_PID=<its own pid>`. Every process the runner starts inherits all three
 *     (a `pi` run from a child's bash, a test suite), so only the runner's own pid counts.
 * A `/fork` or `--fork` also writes `parentSession` into the header, but the session it forked
 * from has either left (it was replaced in this process) or lives in another process, so a fork
 * is never mistaken for a subagent.
 *
 * Lineal family — a session's ancestors and descendants — never hold each other back with
 * claims: a parent delegates inside its own claim, and a child may claim part of it. Siblings
 * are NOT family in that sense: two children working in parallel are peers like any other.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { isId, type Presence } from "./transport.ts";

/** Set by pi-subagents on the runner process that hosts background children. */
const SUBAGENT_ENV = {
	child: "PI_SUBAGENT_CHILD",
	parent: "PI_SUBAGENT_PARENT_SESSION",
	runnerPid: "PI_SUBAGENT_RUNNER_PID",
} as const;

/** A session header is one short JSON line; this much of the file always holds it. */
const HEADER_BYTES = 8 * 1024;
/** Family chains are short (pi-subagents caps nesting); this bounds a walk over hostile records. */
const MAX_DEPTH = 16;
/** pi names session files `<timestamp>_<session id>.jsonl`. */
const SESSION_FILE = /_([A-Za-z0-9-]{8,128})\.jsonl$/;

export interface Lineage {
	role: "main" | "child";
	parent?: string;
}

/**
 * The session id a pi session file belongs to: the `id` of its header (the first line), or the id
 * in its file name when the header cannot be read. `null` when neither gives one.
 */
export function sessionIdOfFile(file: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(HEADER_BYTES);
		const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
		const first = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
		const header = JSON.parse(first) as { type?: unknown; id?: unknown };
		if (header.type === "session" && isId(header.id)) return header.id;
	} catch {
		/* not written yet, or not a session file: fall back to the name */
	} finally {
		if (fd !== null) closeSync(fd);
	}
	const named = SESSION_FILE.exec(basename(file))?.[1];
	return isId(named) ? named : null;
}

/**
 * Is this session a subagent, and whose? `peers` are the live records on the switchboard, read
 * before this session publishes its own.
 */
export function detectLineage(input: {
	env: NodeJS.ProcessEnv;
	/** `parentSession` from this session's header: the parent's session file. */
	parentSessionFile: string | undefined;
	peers: readonly Presence[];
	pid: number;
	selfId: string;
}): Lineage {
	const fromHeader = input.parentSessionFile ? sessionIdOfFile(input.parentSessionFile) : null;
	const parent = fromHeader && fromHeader !== input.selfId ? fromHeader : null;
	const runner = input.env[SUBAGENT_ENV.runnerPid]?.trim();
	// A runner from before the pid variable existed sets only the flag: trust it then.
	if (input.env[SUBAGENT_ENV.child] === "1" && (!runner || runner === String(input.pid))) {
		// The header names the direct parent; the environment names the root of the run, which
		// is the best we have when the header is missing.
		const root = input.env[SUBAGENT_ENV.parent]?.trim();
		const id = parent ?? (isId(root) && root !== input.selfId ? root : null);
		return id ? { role: "child", parent: id } : { role: "child" };
	}
	if (parent && input.peers.some((p) => p.id === parent && p.pid === input.pid)) {
		return { role: "child", parent };
	}
	return { role: "main" };
}

/** Ids of `self`'s live ancestors and descendants — the sessions whose claims never bind it. */
export function lineOf(self: Presence, peers: readonly Presence[]): Set<string> {
	const byId = new Map(peers.map((p) => [p.id, p]));
	const line = new Set<string>();
	let up = self.parent;
	for (let depth = 0; up && depth < MAX_DEPTH && !line.has(up) && up !== self.id; depth++) {
		line.add(up);
		up = byId.get(up)?.parent;
	}
	let frontier = new Set([self.id]);
	for (let depth = 0; frontier.size > 0 && depth < MAX_DEPTH; depth++) {
		const next = new Set<string>();
		for (const p of peers) {
			if (p.parent && frontier.has(p.parent) && p.id !== self.id && !line.has(p.id)) next.add(p.id);
		}
		for (const id of next) line.add(id);
		frontier = next;
	}
	return line;
}

/** The live parent of `peer`, if it is on the switchboard. */
export function parentOf(peer: Presence, peers: readonly Presence[]): Presence | undefined {
	return peer.parent ? peers.find((p) => p.id === peer.parent) : undefined;
}

/**
 * Is `peer` a foreground subagent of `parent`: a child session running inside the parent's own
 * process, while the parent waits for it in a tool call (so the parent cannot read anything
 * until the child's run ends)?
 */
export function isForegroundChild(peer: Presence, parent: Presence): boolean {
	return peer.parent === parent.id && peer.pid === parent.pid;
}

/**
 * Is `ancestor` blocked until `self`'s run ends? True when a chain of foreground subagents, each
 * in its parent's process, leads from `ancestor` down to `self`: every session on it waits in a
 * `subagent` tool call for the next one.
 */
export function blockedOnMe(self: Presence, ancestor: Presence, peers: readonly Presence[]): boolean {
	const byId = new Map(peers.map((p) => [p.id, p]));
	let child = self;
	for (let depth = 0; depth < MAX_DEPTH && child.parent; depth++) {
		const parent = child.parent === ancestor.id ? ancestor : byId.get(child.parent);
		if (!parent || !isForegroundChild(child, parent)) return false;
		if (parent.id === ancestor.id) return true;
		child = parent;
	}
	return false;
}
