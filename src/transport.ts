/**
 * transport — the wire between pi sessions on one machine. No broker, no socket, no daemon.
 *
 * Layout under the root (0700 and owned by this user on Unix; per-user temp storage on Windows):
 *
 *   presence/<session-id>.json        one record per live session, rewritten only by its owner
 *   presence/<session-id>.left        empty: that session left on purpose (see `markLeft`)
 *   inbox/<session-id>/<seq>-<id>.json one file per envelope, renamed into place atomically
 *   log/<session-id>.jsonl            the team log, rewritten only by its owner (see log.ts)
 *
 * Derived from @tinoy/pi-ipc / @tinoy/pi-ext-lib `ipc.ts` (MIT), with these changes:
 *   - the root falls back to a private directory under the OS temp dir when `$XDG_RUNTIME_DIR`
 *     is missing (macOS, containers), and can be pinned with `PI_TELECOM_DIR`;
 *   - liveness uses the `/proc/<pid>/stat` start time on Linux (so a reused pid reads as dead)
 *     and `kill(pid, 0)` elsewhere, plus the heartbeat for subagents, which share a process;
 *   - the presence record carries what a teammate needs: callsign, project root, branch, busy
 *     state, current task, claims and recently edited files;
 *   - an envelope can carry a structured `data` payload for machine events (file changes,
 *     contested claims) next to its human `text`.
 *
 * Every write is temp-file + rename, so a reader sees nothing or the whole file. Every reader
 * validates, and a record that does not validate is skipped (presence) or removed (inbox) —
 * never trusted. Nothing runs at import time.
 */
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { ENV } from "./config.ts";
import { isResourceName } from "./glob.ts";
import { WAITS_CAP } from "./ledger.ts";
import { clip, messageOf, shortId } from "./util.ts";

export const WIRE_VERSION = 1;
/** Largest envelope text, in UTF-8 bytes. */
export const TEXT_CAP = 32 * 1024;
/** Largest envelope file, everything included (text, structured data, headers). */
const ENVELOPE_CAP = 64 * 1024;
/** Most envelopes handled per drain; the rest wait for the next tick, so a flood cannot stall. */
const DRAIN_BATCH = 64;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** An unparseable presence file younger than this may be mid-rename; the sweep leaves it alone. */
const UNPARSEABLE_GRACE_MS = 5_000;
/** An inbox without a presence record is kept this long, so a starting session can publish first. */
const ORPHAN_INBOX_GRACE_MS = 60_000;
/**
 * A leave marker is kept this long. Peers need it only until their next team refresh (a second or
 * two), so this is ample; the sweep removes it afterwards.
 */
const LEFT_MARK_KEEP_MS = 60_000;
/** Waits between attempts to rename over a file Windows reports as locked (77 ms at most). */
const RENAME_RETRY_MS = [2, 5, 10, 20, 40];
/**
 * A subagent shares its pid with the process hosting it (the parent's pi for a foreground child,
 * a pi-subagents runner for a background one), so a live pid does not prove the child is live. A
 * child record that fell this far behind another session of its own process (all heartbeat every
 * 15 s) belongs to a disposed session. A suspended process, or a machine asleep, stops every
 * session in it at once, so their records fall behind together and none is dropped.
 */
export const CHILD_SILENT_MS = 5 * 60_000;
/**
 * A peer's timestamp may lie this far in our future. Sessions share one machine and one clock, so
 * this only absorbs a write racing our read; a time further ahead is a forged or broken record,
 * and would show as a negative duration.
 */
const FUTURE_SKEW_MS = 60_000;
/** A tool name as a peer may publish it: an identifier, the way pi and MCP servers name tools. */
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Most teammates one agent may declare it waits for (`blockedOn`). */
export const BLOCKED_CAP = 8;
/** Most resource locks one agent may wait in line for (`queued`). */
export const QUEUED_CAP = 8;
/** A larger count of asks owed is not believed: no session owes that many. */
const ASKS_OWED_MAX = 999;

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
	/**
	 * The one checkout the claim binds in (`pattern` is then relative to it): the owner named a path
	 * inside it. Without it, the claim binds in every checkout its owner works in. Optional: older
	 * peers ignore it, and read the claim as binding wherever its owner works, as it always did.
	 */
	checkout?: string;
}

/** The tool call a busy agent is inside: it reads nothing it is sent until the call ends. */
export interface Step {
	/** The tool's name, as pi reports it (`bash`, `subagent`, …). */
	tool: string;
	since: number;
}

/** A place in the line for a resource lock. */
export interface QueueEntry {
	/** The resource, as `resourceKey` stores it (`@cargo`). */
	pattern: string;
	since: number;
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
	/** The checkout: the nearest folder holding `.git` (see project.ts). */
	projectRoot: string;
	/** The git common directory every checkout of the repository shares. Optional: a peer without
	 *  it is grouped by `projectRoot` alone. */
	repo?: string;
	branch?: string;
	model?: string;
	/** A pi-subagents child session, or a top-level one. */
	role: "main" | "child";
	/** For a child: the session that started it. */
	parent?: string;
	/** Sessions this one is blocked on in an `ask`, for finding wait cycles. Always published
	 *  (empty when not waiting); a record without it comes from an older telecom. */
	waitingOn?: string[];
	/** When the oldest of those asks started. */
	waitingSince?: number;
	/**
	 * Teammates this agent declared it waits for (`status` with `waitingFor`), by session id. Kept
	 * apart from `waitingOn`: a declared wait blocks no tool call, so it is no edge of the ask
	 * graph (`closesCycle`). Absent when it waits for no one, and on an older telecom.
	 */
	blockedOn?: string[];
	/** Resource locks (`@cargo`) this agent waits in line for, and since when; the earliest live
	 *  waiter takes a lock when it frees. */
	queued?: QueueEntry[];
	state: "idle" | "busy";
	/** When `state` last changed (idle ↔ busy). Optional: older peers do not send it. */
	stateSince?: number;
	/** While busy: the tool call that has run longest, once it has run `STEP_PUBLISH_AFTER_MS`
	 *  (runtime.ts). A short call is not published: it would rewrite the record on every step. */
	step?: Step;
	task?: string;
	taskAt?: number;
	/**
	 * Since when a message that should have started a run here has gone unanswered by the model
	 * (runtime.ts, `checkWakes`): set once a re-wake was needed, cleared by the next model turn. A
	 * stuck session cannot say so itself, so this is what tells teammates waiting on it. Optional,
	 * display and wake-ups only.
	 */
	unreadSince?: number;
	/**
	 * Asks to this agent it has not answered yet, when there are any: a teammate many depend on
	 * shows as one, and whoever asks next knows to expect a wait. Optional, display only.
	 */
	asksOwed?: number;
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
	/** An explicit human request to run a task; bypasses the automatic peer wake limit. */
	triggerTurn?: boolean;
	/**
	 * For `ask`: the asker is not waiting (`wait: false`), so the ask closes no wait cycle and the
	 * reply reaches it as a message. Older peers ignore it and treat the ask as a blocking one.
	 */
	async?: true;
	/**
	 * For `broadcast`: the paths or globs it is about, in the sender's checkout. Agents working
	 * there get it at once; the rest at their next prompt. Absent: it is about everyone.
	 */
	paths?: string[];
}

// ---------------------------------------------------------------------------------------------
// root

/**
 * The transport root, created 0700 on Unix on first use.
 *
 * `PI_TELECOM_DIR` wins; then `$XDG_RUNTIME_DIR/pi-telecom` when that directory is ours; then
 * `<tmpdir>/pi-telecom-<uid>` (a user hash where there is no uid). Symlinks and non-directories
 * are refused; Unix additionally checks ownership and group/world permissions.
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
			: join(tmpdir(), `pi-telecom-${uid ?? userKey()}`);
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

/** Windows has no uid. Keep users apart even when TEMP points at a shared directory. */
function userKey(): string {
	let identity = homedir();
	try {
		const info = userInfo();
		identity = `${info.homedir}\u0000${info.username}`;
	} catch {
		/* a service account may have no user database entry; its home is still stable */
	}
	return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// liveness

/** Start time of a process in clock ticks since boot (Linux), or `null`. */
export function processStartTicks(pid: number): number | null {
	return readStartTicks(pid) ?? null;
}

/**
 * `processStartTicks`, but `undefined` when `/proc/<pid>/stat` could not be read for a reason
 * other than the process being gone (out of file descriptors, a restricted `/proc`). Liveness must
 * not read that as death: every session's sweep would then unlink a live peer's record, and the
 * team would see it leave and rejoin.
 */
export function readStartTicks(pid: number, read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null | undefined {
	if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const line = read(`/proc/${pid}/stat`);
		// comm (field 2) is parenthesised and may contain spaces or ')': split after the LAST ')'.
		const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
	} catch (error) {
		return isErrno(error, "ENOENT") || isErrno(error, "ESRCH") ? null : undefined;
	}
}

/**
 * Is the session behind a record still there? Its process must be. A child must also keep up
 * with `hostBeat`, the latest heartbeat of any session in its process (`hostBeats`).
 */
export function isLive(record: Presence, hostBeat = record.heartbeatAt): boolean {
	if (record.role === "child" && hostBeat - record.heartbeatAt > CHILD_SILENT_MS) return false;
	return isAlive(record.pid, record.ticks);
}

/** The latest heartbeat among the records of each process: proof that the process still runs. */
export function hostBeats(records: readonly Presence[], now = Date.now()): Map<number, number> {
	const beats = new Map<number, number>();
	for (const r of records) {
		// A clock ahead of ours (or a forged record) must not make its process's children look dead.
		const at = Math.min(r.heartbeatAt, now);
		if (at > (beats.get(r.pid) ?? Number.NEGATIVE_INFINITY)) beats.set(r.pid, at);
	}
	return beats;
}

/** The order `readPeers` returns records in: oldest session first. */
export function byStart(a: Presence, b: Presence): number {
	return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

/**
 * Which sessions seen at the last team refresh have left, as of this one. A live session's record
 * can be missing for a moment: a sweeper that misjudged its liveness (a `/proc` read that failed
 * for want of file descriptors, say) unlinks it, or the runtime directory is cleaned, and its owner
 * writes it again on its next refresh. So a record missing for the first time is only `departing`,
 * and still counts as present; it is `gone` once it is missing a second refresh in a row, or at
 * once when its process is provably dead. `known` is the last refresh's view, departing records
 * included; `departing` the ids that were already missing then.
 */
export function settleDepartures(
	known: ReadonlyMap<string, Presence>,
	read: readonly Presence[],
	departing: ReadonlySet<string>,
	alive: (record: Presence) => boolean = (record) => isLive(record),
): { departing: Map<string, Presence>; gone: Presence[] } {
	const present = new Set(read.map((r) => r.id));
	const next = new Map<string, Presence>();
	const gone: Presence[] = [];
	for (const [id, record] of known) {
		if (present.has(id)) continue;
		// A dead process proves the departure. A live one proves nothing: a session that leaves
		// cleanly (`/telecom off`, `/new`, a finished subagent) outlives its record in its process.
		if (departing.has(id) || !alive(record)) gone.push(record);
		else next.set(id, record);
	}
	return { departing: next, gone };
}

function isAlive(pid: number, ticks: number | null): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (ticks !== null && process.platform === "linux") {
		const now = readStartTicks(pid);
		// Unreadable is not gone: fall back to signalling the pid, which cannot see pid reuse but
		// cannot mistake a live peer for a dead one either.
		if (now !== undefined) return now === ticks;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ---------------------------------------------------------------------------------------------
// validation

/** Why `text` cannot be sent (`what`: "the message", "the prompt"); null when it fits `TEXT_CAP`. */
export function textTooLong(text: string, what: string): string | null {
	return Buffer.byteLength(text, "utf8") > TEXT_CAP ? `${what} exceeds ${TEXT_CAP} bytes — shorten it or point at a file` : null;
}

/** A session or envelope id that is safe as a file name. */
export function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value) && !value.endsWith(".") && !WINDOWS_DEVICE.test(value);
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
const LIMITS = {
	name: 60,
	task: 200,
	note: 160,
	model: 80,
	branch: 100,
	path: 4096,
	claims: 32,
	recent: 24,
	waits: WAITS_CAP,
	blocked: BLOCKED_CAP,
	queued: QUEUED_CAP,
	broadcastPaths: 16,
	summary: 120,
	tool: 40,
	excerptLines: 4,
	excerptLine: 100,
} as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;
const CONTROL_RUNS = new RegExp(`${CONTROL_CHARS.source}+`, "g");

/** A path as a peer may send it: bounded, and without control characters that could break out
 *  of the line it is shown on. Paths are compared as keys, so they are refused, never rewritten. */
export function isPath(value: unknown): value is string {
	return str(value) && value.length <= LIMITS.path && !CONTROL_CHARS.test(value);
}

/** One line, at most `max` characters, with no control characters; `undefined` when empty. */
export function line(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return clip(value.replace(CONTROL_RUNS, " "), max) || undefined;
}

function parseClaims(value: unknown): Claim[] {
	if (!Array.isArray(value)) return [];
	const out: Claim[] = [];
	for (const raw of value.slice(0, LIMITS.claims)) {
		const c = raw as Partial<Claim> | null;
		const pattern = line(c?.pattern, LIMITS.path);
		if (!c || !pattern || !num(c.since) || !num(c.expiresAt)) continue;
		const note = line(c.note, LIMITS.note);
		const checkout = isPath(c.checkout) && isAbsolute(c.checkout) ? c.checkout : undefined;
		out.push({ pattern, since: c.since, expiresAt: c.expiresAt, ...(note ? { note } : {}), ...(checkout ? { checkout } : {}) });
	}
	return out;
}

/** Queue entries name resources only (never paths), so a hostile entry cannot smuggle text. */
function parseQueued(value: unknown, now: number): QueueEntry[] {
	if (!Array.isArray(value)) return [];
	const out: QueueEntry[] = [];
	for (const raw of value.slice(0, LIMITS.queued)) {
		const q = raw as Partial<QueueEntry> | null;
		// `since` orders the line, so a forged 0 (or a time ahead of ours) would jump it: only a
		// plausible past time counts. A peer can still write a plausible earlier time than the truth
		// and get ahead of honest waiters: that is the trust boundary every peer field has (these
		// are this user's own sessions), and telecom is a teammate, not a security boundary.
		if (!q || !isResourceName(q.pattern) || !past(q.since, now)) continue;
		out.push({ pattern: q.pattern.toLowerCase(), since: q.since });
	}
	return out;
}

function parseRecent(value: unknown): RecentFile[] {
	if (!Array.isArray(value)) return [];
	const out: RecentFile[] = [];
	for (const raw of value.slice(0, LIMITS.recent)) {
		const r = raw as Partial<RecentFile> | null;
		if (!r || !isPath(r.path) || !num(r.at) || (r.op !== "edit" && r.op !== "write")) {
			continue;
		}
		out.push({ path: r.path, op: r.op, at: r.at });
	}
	return out;
}

/** A time a peer reports for something that already happened: finite, positive, not ahead of us. */
function past(value: unknown, now: number): value is number {
	return num(value) && value > 0 && value <= now + FUTURE_SKEW_MS;
}

function parseStep(value: unknown, now: number): { step?: Step } {
	const s = value as Partial<Step> | null;
	if (typeof s !== "object" || s === null || typeof s.tool !== "string" || !TOOL_PATTERN.test(s.tool) || !past(s.since, now)) {
		return {};
	}
	return { step: { tool: clip(s.tool, LIMITS.tool), since: s.since } };
}

export function parsePresence(value: unknown): Presence | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	// Checkouts are shown to other models (the board, lane names), so they are paths with no
	// control characters, like every other path a peer sends.
	if (r.v !== WIRE_VERSION || !isId(r.id) || !isPath(r.cwd) || !isPath(r.projectRoot)) return null;
	if (typeof r.callsign !== "string" || !CALLSIGN_PATTERN.test(r.callsign)) return null;
	if (!num(r.pid) || !(r.ticks === null || num(r.ticks)) || !num(r.startedAt) || !num(r.heartbeatAt)) {
		return null;
	}
	const name = line(r.name, LIMITS.name);
	const branch = line(r.branch, LIMITS.branch);
	const model = line(r.model, LIMITS.model);
	const task = line(r.task, LIMITS.task);
	const now = Date.now();
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
		// Both optional (older peers do not send them), and shown only: nothing decides on them.
		...(past(r.stateSince, now) ? { stateSince: r.stateSince } : {}),
		...parseStep(r.step, now),
		...(isPath(r.repo) ? { repo: r.repo } : {}),
		...(isId(r.parent) ? { parent: r.parent } : {}),
		...(Array.isArray(r.waitingOn) ? { waitingOn: r.waitingOn.filter(isId).slice(0, LIMITS.waits) } : {}),
		...(num(r.waitingSince) ? { waitingSince: r.waitingSince } : {}),
		...blockedAndQueued(r, now),
		claims: parseClaims(r.claims),
		recent: parseRecent(r.recent),
		startedAt: r.startedAt,
		heartbeatAt: r.heartbeatAt,
		...(name ? { name } : {}),
		...(branch ? { branch } : {}),
		...(model ? { model } : {}),
		...(task ? { task } : {}),
		...(num(r.taskAt) ? { taskAt: r.taskAt } : {}),
		...(past(r.unreadSince, now) ? { unreadSince: r.unreadSince } : {}),
		...(Number.isInteger(r.asksOwed) && (r.asksOwed as number) > 0 && (r.asksOwed as number) <= ASKS_OWED_MAX ? { asksOwed: r.asksOwed as number } : {}),
	};
}

function blockedAndQueued(r: Record<string, unknown>, now: number): { blockedOn?: string[]; queued?: QueueEntry[] } {
	const blockedOn = Array.isArray(r.blockedOn) ? [...new Set(r.blockedOn.filter(isId))].slice(0, LIMITS.blocked) : [];
	const queued = parseQueued(r.queued, now);
	return { ...(blockedOn.length > 0 ? { blockedOn } : {}), ...(queued.length > 0 ? { queued } : {}) };
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
		typeof r.fromCallsign === "string" && CALLSIGN_PATTERN.test(r.fromCallsign) ? r.fromCallsign : shortId(r.from);
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
		// Validated above for an event; on any other kind it means nothing, so it is not passed on.
		...(r.kind === "event" ? { topic: r.topic as string } : {}),
		...(r.data !== undefined ? { data: r.data } : {}),
		...(r.human === true ? { human: true } : {}),
		...(r.kind === "message" && r.human === true && r.triggerTurn === true ? { triggerTurn: true } : {}),
		...(r.kind === "ask" && r.async === true ? { async: true as const } : {}),
		...broadcastPaths(r),
	};
}

function broadcastPaths(r: Record<string, unknown>): { paths?: string[] } {
	if (r.kind !== "broadcast" || !Array.isArray(r.paths)) return {};
	const paths = r.paths
		.slice(0, LIMITS.broadcastPaths)
		.map((p) => line(p, LIMITS.path))
		.filter((p): p is string => Boolean(p));
	return paths.length > 0 ? { paths } : {};
}

// ---------------------------------------------------------------------------------------------
// events

/** `file.changed`: a peer edited or rewrote a file. */
export interface FileChangedData {
	/** Canonical absolute path. */
	path: string;
	op: "edit" | "write";
	summary?: string;
	/** A few changed lines from the patch. */
	excerpt?: string[];
	created?: boolean;
}

/** `claim.contested`: a peer was held back by one of this agent's claims. */
export interface ClaimContestedData {
	path: string;
	pattern: string;
	/** The peer changed the path in its own checkout (another lane): nothing was held back. */
	lane?: boolean;
}

/** `claim.released`: a peer released claims this agent had been held back by. */
export interface ClaimReleasedData {
	patterns: string[];
}

/** `ask.withdrawn`: a peer stopped waiting for an answer to one of its asks. */
export interface AskWithdrawnData {
	askId: string;
}

export type TelecomEvent =
	| { topic: "file.changed"; data: FileChangedData }
	| { topic: "claim.contested"; data: ClaimContestedData }
	| { topic: "claim.released"; data: ClaimReleasedData }
	| { topic: "ask.withdrawn"; data: AskWithdrawnData };

/**
 * The typed payload of an `event` envelope, validated and bounded like a presence record, since
 * its fields end up in this agent's model context. `null` for a malformed payload or a topic this
 * version does not know (a newer peer's event is ignored, not an error).
 */
export function parseEvent(envelope: Envelope): TelecomEvent | null {
	if (envelope.kind !== "event" || typeof envelope.data !== "object" || envelope.data === null) return null;
	const d = envelope.data as Record<string, unknown>;
	switch (envelope.topic) {
		case "file.changed": {
			if (!isPath(d.path) || (d.op !== "edit" && d.op !== "write")) return null;
			const summary = line(d.summary, LIMITS.summary);
			const excerpt = Array.isArray(d.excerpt)
				? d.excerpt
						.slice(0, LIMITS.excerptLines)
						.map((l) => line(l, LIMITS.excerptLine))
						.filter((l): l is string => l !== undefined)
				: [];
			return {
				topic: "file.changed",
				data: {
					path: d.path,
					op: d.op,
					...(summary ? { summary } : {}),
					...(excerpt.length > 0 ? { excerpt } : {}),
					...(d.created === true ? { created: true } : {}),
				},
			};
		}
		case "claim.contested": {
			const pattern = line(d.pattern, LIMITS.path);
			if (!isPath(d.path) || !pattern) return null;
			return { topic: "claim.contested", data: { path: d.path, pattern, ...(d.lane === true ? { lane: true } : {}) } };
		}
		case "claim.released": {
			if (!Array.isArray(d.patterns)) return null;
			const patterns = d.patterns
				.slice(0, LIMITS.claims)
				.map((p) => line(p, LIMITS.path))
				.filter((p): p is string => p !== undefined);
			return { topic: "claim.released", data: { patterns } };
		}
		case "ask.withdrawn":
			return isId(d.askId) ? { topic: "ask.withdrawn", data: { askId: d.askId } } : null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------------------------
// files

let tmpCounter = 0;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Windows refuses to replace a file that another process holds open (a peer reading presence
 * every second, an indexer, a virus scanner) with EPERM, EACCES or EBUSY. The lock lasts
 * milliseconds, so retry a few times before giving up (graceful-fs and write-file-atomic do the
 * same). The waits block the loop, so their sum stays small.
 */
function renameRetrying(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const delay = RENAME_RETRY_MS[attempt];
			const locked = ["EPERM", "EACCES", "EBUSY"].some((code) => isErrno(error, code));
			if (process.platform !== "win32" || !locked || delay === undefined) throw error;
			Atomics.wait(sleeper, 0, 0, delay);
		}
	}
}

/** Write `name` in `dir` whole: to a temporary name, then renamed over it (presence, inbox, team log). */
export function writeAtomic(dir: string, name: string, body: string): Result<object> {
	tmpCounter += 1;
	const tmp = join(dir, `.tmp-${process.pid}-${tmpCounter}`);
	try {
		writeFileSync(tmp, body, { mode: 0o600 });
		renameRetrying(tmp, join(dir, name));
		return { ok: true };
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* A Windows sharing violation can lock the temp file too; preserve the write error. */
		}
		// Drop the quoted paths: the temp name changes on every write, and callers report each
		// distinct reason once, so a path in it would repeat the same warning on every heartbeat.
		const reason = messageOf(error).replace(/ '[^']*'(?: -> '[^']*')?/g, "");
		return { ok: false, reason: `writing ${name} failed: ${reason}` };
	}
}

function readJson(path: string): unknown {
	// An unreadable file is not malformed JSON. Let callers retain it and try on a later tick.
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === code;
}

// ---------------------------------------------------------------------------------------------
// the transport

export interface Transport {
	readonly root: string;
	writePresence(record: Presence): Result<object>;
	removePresence(id: string): void;
	/**
	 * Mark that session `id` left on purpose (`/telecom off`, `/new`, a finished subagent). Its
	 * process may live on, so without this a peer could not tell its missing record from one a
	 * sweeper removed by mistake, and would count it present for one more refresh
	 * (`settleDepartures`). Older sessions ignore the file.
	 */
	markLeft(id: string): void;
	/** Whether session `id` left on purpose (`markLeft`). Only asked about a record that is missing. */
	hasLeft(id: string): boolean;
	/** Take back a leave mark: session `id` is back (`/telecom on`, a resume). */
	clearLeft(id: string): void;
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
	drain(id: string, handle: (envelope: Envelope) => void): { handled: number; failed: string[] };
	removeInbox(id: string): void;
	/** Park state for the runtime that replaces this one (a `/reload`). */
	writeHandoff(id: string, state: unknown): void;
	/** Take (read and delete) the state a previous runtime of this session parked. */
	takeHandoff(id: string): unknown;
}

export function openTransport(root: string): Transport {
	const presenceDir = join(root, "presence");
	const inboxRoot = join(root, "inbox");
	/** Each presence file's last valid record, kept while the file is briefly locked. */
	let lastPresence = new Map<string, Presence>();

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

		markLeft(id) {
			if (!isId(id)) return;
			try {
				mkdirSync(presenceDir, { recursive: true, mode: 0o700 });
				writeFileSync(join(presenceDir, `${id}.left`), "");
			} catch {
				/* best effort: peers then count the departure one refresh later */
			}
		},

		hasLeft(id) {
			if (!isId(id)) return false;
			try {
				lstatSync(join(presenceDir, `${id}.left`));
				return true;
			} catch {
				return false;
			}
		},

		clearLeft(id) {
			if (!isId(id)) return;
			try {
				rmSync(join(presenceDir, `${id}.left`), { force: true });
			} catch {
				/* a stale mark only matters while the record is missing, and the sweep removes it */
			}
		},

		readPeers() {
			const read = new Map<string, Presence>();
			for (const name of presenceFiles()) {
				let record: Presence | null;
				try {
					record = parsePresence(readJson(join(presenceDir, name)));
				} catch (error) {
					// Indexers and virus scanners can briefly lock an otherwise healthy record.
					// ENOENT really is a departure; every retained record still has to be live.
					record = isErrno(error, "ENOENT") ? null : lastPresence.get(name) ?? null;
				}
				if (record) read.set(name, record);
			}
			lastPresence = read;
			const records = [...read.values()];
			const beats = hostBeats(records);
			return records
				.filter((r) => isLive(r, beats.get(r.pid)))
				.sort(byStart);
		},

		sweep() {
			const removed: string[] = [];
			const read = presenceFiles().flatMap((name) => {
				try {
					return [{ name, record: parsePresence(readJson(join(presenceDir, name))) }];
				} catch {
					return []; // locked or gone; neither is evidence of a corrupt presence
				}
			});
			const beats = hostBeats(read.flatMap((r) => (r.record ? [r.record] : [])));
			for (const { name, record } of read) {
				const path = join(presenceDir, name);
				if (record && isLive(record, beats.get(record.pid))) continue;
				// A record mid-rename can read as null for an instant; only sweep files that are
				// unparseable for more than a moment, or whose process is provably gone.
				if (!record) {
					try {
						if (Date.now() - lstatSync(path).mtimeMs < UNPARSEABLE_GRACE_MS) continue;
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
				if (isId(id)) {
					try {
						rmSync(join(inboxRoot, id), { recursive: true, force: true });
					} catch {
						/* a locked inbox can be reclaimed by the orphan sweep on a later tick */
					}
				}
			}
			// Leave marks matter only until every peer's next refresh.
			let marks: string[] = [];
			try {
				marks = readdirSync(presenceDir).filter((n) => n.endsWith(".left") && !n.startsWith("."));
			} catch {
				/* no presence directory yet */
			}
			for (const name of marks) {
				try {
					if (Date.now() - lstatSync(join(presenceDir, name)).mtimeMs >= LEFT_MARK_KEEP_MS) rmSync(join(presenceDir, name), { force: true });
				} catch {
					/* raced with another sweeper */
				}
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
					if (Date.now() - lstatSync(join(inboxRoot, id)).mtimeMs < ORPHAN_INBOX_GRACE_MS) continue;
					rmSync(join(inboxRoot, id), { recursive: true, force: true });
				} catch {
					/* raced with another sweeper */
				}
			}
			return removed;
		},

		deliver(envelope) {
			if (!isId(envelope.to)) return { ok: false, reason: "the target id is not file-name safe" };
			const tooLong = textTooLong(envelope.text, "the message");
			if (tooLong) return { ok: false, reason: tooLong };
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
			const result = { handled: 0, failed: [] as string[] };
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
				const failed = (error: unknown) => result.failed.push(`${name}: ${messageOf(error)}`);
				// Recursive: a directory planted in the inbox must not throw on every drain.
				const remove = () => {
					try {
						rmSync(path, { force: true, recursive: true });
					} catch (error) {
						failed(error);
					}
				};
				let envelope: Envelope | null = null;
				try {
					const stat = lstatSync(path);
					if (stat.isFile() && stat.size <= ENVELOPE_CAP) envelope = parseEnvelope(readJson(path));
				} catch (error) {
					if (!isErrno(error, "ENOENT")) failed(error);
					continue; // temporarily locked, or another drainer took it; do not discard it
				}
				if (!envelope || envelope.to !== id) {
					// Malformed, or not addressed to us: peer data, dropped without a word.
					remove();
					continue;
				}
				try {
					handle(envelope);
					result.handled++;
				} catch (error) {
					failed(error);
				} finally {
					// Removed even when the handler threw: a message that always throws must not
					// wedge the inbox (poison message), and the failure is reported instead.
					remove();
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
			try {
				const state = readJson(path);
				rmSync(path, { force: true });
				return state;
			} catch {
				return null; // missing or locked: reconnect without making reload fail
			}
		},
	};
}
