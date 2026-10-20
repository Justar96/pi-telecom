/**
 * transport — the wire between pi sessions on one machine. No broker, no socket, no daemon.
 *
 * Layout under the root (0700, owned by this user):
 *
 *   presence/<session-id>.json        one record per live session, rewritten only by its owner
 *   inbox/<session-id>/<seq>-<id>.json one file per envelope, renamed into place atomically
 *
 * Derived from @tinoy/pi-ipc / @tinoy/pi-ext-lib `ipc.ts` (MIT), with these changes:
 *   - the root falls back to a private directory under the OS temp dir when `$XDG_RUNTIME_DIR`
 *     is missing (macOS, containers), and can be pinned with `PI_TELECOM_DIR`;
 *   - liveness uses the `/proc/<pid>/stat` start time on Linux (so a reused pid reads as dead)
 *     and `kill(pid, 0)` elsewhere;
 *   - the presence record carries what a teammate needs: callsign, project root, branch, busy
 *     state, current task, claims and recently edited files;
 *   - an envelope can carry a structured `data` payload for machine events (file changes,
 *     contested claims) next to its human `text`.
 *
 * Every write is temp-file + rename, so a reader sees nothing or the whole file. Every reader
 * validates, and a record that does not validate is skipped (presence) or removed (inbox) —
 * never trusted. Nothing runs at import time.
 */
import {
	lstatSync,
	statSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { ENV } from "./config.ts";
import { messageOf } from "./util.ts";

export const WIRE_VERSION = 1;
/** Largest envelope text, in UTF-8 bytes. */
export const TEXT_CAP = 32 * 1024;
/** Largest envelope file, everything included (text, structured data, headers). */
export const ENVELOPE_CAP = 64 * 1024;
/** Most envelopes handled per drain; the rest wait for the next tick, so a flood cannot stall. */
export const DRAIN_BATCH = 64;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

// ---------------------------------------------------------------------------------------------
// records

export interface Claim {
	/** The pattern as the owner wrote it (project-relative or absolute). */
	pattern: string;
	note?: string;
	since: number;
	/** Refreshed whenever the owner edits inside the claim. */
	expiresAt: number;
}

export interface RecentFile {
	/** Canonical absolute path. */
	path: string;
	op: "edit" | "write";
	at: number;
}

export interface Presence {
	v: number;
	id: string;
	callsign: string;
	name?: string;
	pid: number;
	/** `/proc/<pid>/stat` start time on Linux; `null` elsewhere. */
	ticks: number | null;
	cwd: string;
	projectRoot: string;
	branch?: string;
	model?: string;
	/** A pi-subagents child session, or a top-level one. */
	role: "main" | "child";
	state: "idle" | "busy";
	task?: string;
	taskAt?: number;
	claims: Claim[];
	recent: RecentFile[];
	startedAt: number;
	heartbeatAt: number;
}

export type EnvelopeKind = "message" | "broadcast" | "ask" | "answer" | "event";
const KINDS: readonly EnvelopeKind[] = ["message", "broadcast", "ask", "answer", "event"];

export interface Envelope {
	v: number;
	id: string;
	ts: number;
	from: string;
	/** The sender's callsign when it sent, so a message from a session that has since gone still
	 *  reads as coming from someone. */
	fromCallsign: string;
	to: string;
	kind: EnvelopeKind;
	text: string;
	/** For `answer`: the ask it answers. */
	answerTo?: string;
	/** For `event`: what happened (`file.changed`, `claim.contested`, …). */
	topic?: string;
	data?: unknown;
	/** True when a human typed it (`/telecom msg`), not the model. */
	human?: boolean;
}

// ---------------------------------------------------------------------------------------------
// root

/**
 * The transport root, created 0700 on first use.
 *
 * `PI_TELECOM_DIR` wins; then `$XDG_RUNTIME_DIR/pi-telecom` when that directory is ours; then
 * `<tmpdir>/pi-telecom-<uid>`. A root that exists but is a symlink, is not a directory, belongs
 * to another user, or is group/world accessible is refused by name rather than used.
 */
export function transportRoot(env: NodeJS.ProcessEnv = process.env): Result<{ path: string }> {
	const uid = process.getuid?.();
	let candidate: string;
	const pinned = env[ENV.dir]?.trim();
	if (pinned) {
		candidate = pinned;
	} else {
		const runtime = env.XDG_RUNTIME_DIR?.trim();
		let runtimeOk = false;
		if (runtime) {
			try {
				const stat = lstatSync(runtime);
				runtimeOk = stat.isDirectory() && (uid === undefined || stat.uid === uid);
			} catch {
				runtimeOk = false;
			}
		}
		candidate = runtimeOk && runtime
			? join(runtime, "pi-telecom")
			: join(tmpdir(), `pi-telecom-${uid ?? "user"}`);
	}
	try {
		mkdirSync(candidate, { recursive: true, mode: 0o700 });
		const stat = lstatSync(candidate);
		if (stat.isSymbolicLink()) return { ok: false, reason: `${candidate} is a symlink` };
		if (!stat.isDirectory()) return { ok: false, reason: `${candidate} is not a directory` };
		if (uid !== undefined && stat.uid !== uid) {
			return { ok: false, reason: `${candidate} belongs to uid ${stat.uid}, not ${uid}` };
		}
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
			return {
				ok: false,
				reason: `${candidate} is accessible to other users (mode ${(stat.mode & 0o777).toString(8)}) — chmod 700 it`,
			};
		}
		mkdirSync(join(candidate, "presence"), { recursive: true, mode: 0o700 });
		mkdirSync(join(candidate, "inbox"), { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, reason: `the transport root ${candidate} cannot be prepared: ${messageOf(error)}` };
	}
	return { ok: true, path: candidate };
}

// ---------------------------------------------------------------------------------------------
// liveness

/** Start time of a process in clock ticks since boot (Linux), or `null`. */
export function processStartTicks(pid: number): number | null {
	if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const line = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) is parenthesised and may contain spaces or ')': split after the LAST ')'.
		const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
	} catch {
		return null;
	}
}

export function isAlive(pid: number, ticks: number | null): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (ticks !== null && process.platform === "linux") return processStartTicks(pid) === ticks;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ---------------------------------------------------------------------------------------------
// validation

function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value) && value !== "." && value !== "..";
}

function str(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function num(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Peer records are read by other agents and end up in their model context, so everything a peer
 * controls is bounded here: a callsign must look like one, free text is flattened to one line and
 * clipped, and lists are capped. A malformed or oversized record cannot inject text or bloat a
 * prompt; it is trimmed or skipped.
 */
const LIMITS = { name: 60, task: 200, note: 160, model: 80, branch: 100, path: 4096, claims: 32, recent: 24 } as const;

/** One line, at most `max` characters. */
function line(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parseClaims(value: unknown): Claim[] {
	if (!Array.isArray(value)) return [];
	const out: Claim[] = [];
	for (const raw of value.slice(0, LIMITS.claims)) {
		const c = raw as Partial<Claim> | null;
		const pattern = line(c?.pattern, LIMITS.path);
		if (!c || !pattern || !num(c.since) || !num(c.expiresAt)) continue;
		const note = line(c.note, LIMITS.note);
		out.push({ pattern, since: c.since, expiresAt: c.expiresAt, ...(note ? { note } : {}) });
	}
	return out;
}

function parseRecent(value: unknown): RecentFile[] {
	if (!Array.isArray(value)) return [];
	const out: RecentFile[] = [];
	for (const raw of value.slice(0, LIMITS.recent)) {
		const r = raw as Partial<RecentFile> | null;
		if (!r || !str(r.path) || r.path.length > LIMITS.path || !num(r.at) || (r.op !== "edit" && r.op !== "write")) {
			continue;
		}
		out.push({ path: r.path, op: r.op, at: r.at });
	}
	return out;
}

export function parsePresence(value: unknown): Presence | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (r.v !== WIRE_VERSION || !isId(r.id) || !str(r.cwd) || !str(r.projectRoot)) return null;
	if (typeof r.callsign !== "string" || !CALLSIGN_PATTERN.test(r.callsign)) return null;
	if (!num(r.pid) || !(r.ticks === null || num(r.ticks)) || !num(r.startedAt) || !num(r.heartbeatAt)) {
		return null;
	}
	const name = line(r.name, LIMITS.name);
	const branch = line(r.branch, LIMITS.branch);
	const model = line(r.model, LIMITS.model);
	const task = line(r.task, LIMITS.task);
	return {
		v: WIRE_VERSION,
		id: r.id,
		callsign: r.callsign,
		pid: r.pid,
		ticks: r.ticks as number | null,
		cwd: r.cwd,
		projectRoot: r.projectRoot,
		role: r.role === "child" ? "child" : "main",
		state: r.state === "busy" ? "busy" : "idle",
		claims: parseClaims(r.claims),
		recent: parseRecent(r.recent),
		startedAt: r.startedAt,
		heartbeatAt: r.heartbeatAt,
		...(name ? { name } : {}),
		...(branch ? { branch } : {}),
		...(model ? { model } : {}),
		...(task ? { task } : {}),
		...(num(r.taskAt) ? { taskAt: r.taskAt } : {}),
	};
}

export function parseEnvelope(value: unknown): Envelope | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (r.v !== WIRE_VERSION || !isId(r.id) || !num(r.ts) || !isId(r.from) || !isId(r.to)) return null;
	if (typeof r.kind !== "string" || !(KINDS as readonly string[]).includes(r.kind)) return null;
	if (typeof r.text !== "string" || Buffer.byteLength(r.text, "utf8") > TEXT_CAP) return null;
	if (r.kind === "answer" && !isId(r.answerTo)) return null;
	if (r.kind === "event" && !(typeof r.topic === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(r.topic))) return null;
	const fromCallsign =
		typeof r.fromCallsign === "string" && CALLSIGN_PATTERN.test(r.fromCallsign) ? r.fromCallsign : r.from.slice(0, 8);
	return {
		v: WIRE_VERSION,
		id: r.id,
		ts: r.ts,
		from: r.from,
		fromCallsign,
		to: r.to,
		kind: r.kind as EnvelopeKind,
		text: r.text,
		...(isId(r.answerTo) ? { answerTo: r.answerTo } : {}),
		...(typeof r.topic === "string" ? { topic: r.topic } : {}),
		...(r.data !== undefined ? { data: r.data } : {}),
		...(r.human === true ? { human: true } : {}),
	};
}

// ---------------------------------------------------------------------------------------------
// files

let tmpCounter = 0;

function writeAtomic(dir: string, name: string, body: string): Result<object> {
	tmpCounter += 1;
	const tmp = join(dir, `.tmp-${process.pid}-${tmpCounter}`);
	try {
		writeFileSync(tmp, body, { mode: 0o600 });
		renameSync(tmp, join(dir, name));
		return { ok: true };
	} catch (error) {
		rmSync(tmp, { force: true });
		return { ok: false, reason: `writing ${name} failed: ${messageOf(error)}` };
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === code;
}

// ---------------------------------------------------------------------------------------------
// the transport

export interface Transport {
	readonly root: string;
	writePresence(record: Presence): Result<object>;
	removePresence(id: string): void;
	/** Every live session on the machine, this one included. */
	readPeers(): Presence[];
	/** Remove the records (and inboxes) of sessions that are gone. Returns the ids removed. */
	sweep(): string[];
	deliver(envelope: Envelope): Result<object>;
	/**
	 * Hand every envelope waiting for `id` to `handle`, oldest first, at most `DRAIN_BATCH` per
	 * call. A message file is removed only AFTER `handle` returns (or throws), so a process that
	 * dies mid-delivery finds it again on restart — at-least-once; the caller dedupes by id.
	 */
	drain(id: string, handle: (envelope: Envelope) => void): { handled: number; refused: string[]; failed: string[] };
	removeInbox(id: string): void;
	/** Park state for the runtime that replaces this one (a `/reload`). */
	writeHandoff(id: string, state: unknown): void;
	/** Take (read and delete) the state a previous runtime of this session parked. */
	takeHandoff(id: string): unknown;
}

export function openTransport(root: string): Transport {
	const presenceDir = join(root, "presence");
	const inboxRoot = join(root, "inbox");

	function presenceFiles(): string[] {
		try {
			return readdirSync(presenceDir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
	}

	return {
		root,

		writePresence(record) {
			if (!isId(record.id)) return { ok: false, reason: "the session id is not file-name safe" };
			try {
				mkdirSync(presenceDir, { recursive: true, mode: 0o700 });
			} catch (error) {
				return { ok: false, reason: messageOf(error) };
			}
			return writeAtomic(presenceDir, `${record.id}.json`, `${JSON.stringify(record)}\n`);
		},

		removePresence(id) {
			if (!isId(id)) return;
			rmSync(join(presenceDir, `${id}.json`), { force: true });
		},

		readPeers() {
			const peers: Presence[] = [];
			for (const name of presenceFiles()) {
				const record = parsePresence(readJson(join(presenceDir, name)));
				if (record && isAlive(record.pid, record.ticks)) peers.push(record);
			}
			return peers.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
		},

		sweep() {
			const removed: string[] = [];
			for (const name of presenceFiles()) {
				const path = join(presenceDir, name);
				const record = parsePresence(readJson(path));
				if (record && isAlive(record.pid, record.ticks)) continue;
				// A record mid-rename can read as null for an instant; only sweep files that are
				// unparseable for more than a moment, or whose process is provably gone.
				if (!record) {
					try {
						if (Date.now() - lstatSync(path).mtimeMs < 5_000) continue;
					} catch {
						continue;
					}
				}
				try {
					unlinkSync(path);
				} catch {
					continue;
				}
				const id = name.slice(0, -".json".length);
				removed.push(id);
				if (isId(id)) rmSync(join(inboxRoot, id), { recursive: true, force: true });
			}
			// An inbox with no presence record belongs to a session that has gone (a message can
			// land just after its owner left). Give a starting session a minute to publish first.
			const present = new Set(presenceFiles().map((n) => n.slice(0, -".json".length)));
			let inboxes: string[] = [];
			try {
				inboxes = readdirSync(inboxRoot);
			} catch {
				/* no inboxes yet */
			}
			for (const id of inboxes) {
				if (present.has(id) || !isId(id)) continue;
				try {
					if (Date.now() - lstatSync(join(inboxRoot, id)).mtimeMs < 60_000) continue;
					rmSync(join(inboxRoot, id), { recursive: true, force: true });
				} catch {
					/* raced with another sweeper */
				}
			}
			return removed;
		},

		deliver(envelope) {
			if (!isId(envelope.to)) return { ok: false, reason: "the target id is not file-name safe" };
			if (Buffer.byteLength(envelope.text, "utf8") > TEXT_CAP) {
				return { ok: false, reason: `the message exceeds ${TEXT_CAP} bytes — shorten it or point at a file` };
			}
			if (!parseEnvelope(envelope)) return { ok: false, reason: "the envelope is malformed" };
			const body = `${JSON.stringify(envelope)}\n`;
			if (Buffer.byteLength(body, "utf8") > ENVELOPE_CAP) {
				return { ok: false, reason: `the envelope exceeds ${ENVELOPE_CAP} bytes` };
			}
			const dir = join(inboxRoot, envelope.to);
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			} catch (error) {
				return { ok: false, reason: `the inbox for ${envelope.to} cannot be created: ${messageOf(error)}` };
			}
			const seq = `${String(Date.now()).padStart(15, "0")}-${String(tmpCounter++).padStart(6, "0")}`;
			return writeAtomic(dir, `${seq}-${envelope.id}.json`, body);
		},

		drain(id, handle) {
			const result = { handled: 0, refused: [] as string[], failed: [] as string[] };
			if (!isId(id)) return result;
			const dir = join(inboxRoot, id);
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return result;
			}
			for (const name of names.filter((n) => !n.startsWith(".")).sort().slice(0, DRAIN_BATCH)) {
				const path = join(dir, name);
				let envelope: Envelope | null = null;
				try {
					if (statSync(path).size <= ENVELOPE_CAP) envelope = parseEnvelope(readJson(path));
				} catch {
					continue; // vanished: another drainer of the same id took it
				}
				if (!envelope) {
					result.refused.push(name);
					rmSync(path, { force: true });
					continue;
				}
				try {
					handle(envelope);
					result.handled++;
				} catch (error) {
					result.failed.push(`${name}: ${messageOf(error)}`);
				} finally {
					// Removed even when the handler threw: a message that always throws must not
					// wedge the inbox (poison message), and the failure is reported instead.
					rmSync(path, { force: true });
				}
			}
			return result;
		},

		removeInbox(id) {
			if (!isId(id)) return;
			rmSync(join(inboxRoot, id), { recursive: true, force: true });
		},

		writeHandoff(id, state) {
			if (!isId(id)) return;
			const dir = join(root, "handoff");
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeAtomic(dir, `${id}.json`, `${JSON.stringify(state)}\n`);
			} catch {
				/* best effort: the next runtime starts fresh */
			}
		},

		takeHandoff(id) {
			if (!isId(id)) return null;
			const path = join(root, "handoff", `${id}.json`);
			const state = readJson(path);
			rmSync(path, { force: true });
			return state;
		},
	};
}
