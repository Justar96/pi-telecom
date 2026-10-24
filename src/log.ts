/**
 * log — the team's shared history: what each session did that its teammates need later (its
 * broadcasts, task changes, claims and releases, joins and leaves). A late joiner, or an agent
 * whose context was compacted, reads what happened before instead of digging through other
 * agents' transcripts. Direct messages, asks and answers are private and never logged.
 *
 *   log/<session-id>.jsonl   one entry per line, written only by the session it is named after
 *
 * A session keeps its own entries in memory and rewrites its whole file (temp file + rename, never
 * an append in place, so a reader sees the old file or the new one) on the loop's tick when
 * something changed, keeping only the newest `LOG_CAP` entries: a burst of events costs one write.
 * Readers merge the files of every session in their repository, departed ones included for
 * `LOG_RETENTION_MS`; the heartbeat sweep removes older files of sessions that are gone. Older
 * telecoms never look in `log/`, so the wire stays compatible (AGENTS.md, rule 6).
 *
 * Every entry is peer data that ends up in a model's context, so each one is validated, flattened
 * to one line and capped on read (rule 7). Nothing here runs at import or construction: the first
 * I/O is `open`, at connect (rule 4).
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { claimsOverlap, laneRelativePattern } from "./glob.ts";
import { type Lane, sameRepo } from "./project.ts";
import { isErrno, isId, isPath, line, type Result, writeAtomic } from "./transport.ts";
import { ago, clip, messageOf, shortId } from "./util.ts";

/** Bumped when an entry's fields change meaning; entries of another version are ignored. */
export const LOG_VERSION = 1;
/** Entries kept in a session's own file: rewriting keeps the newest this many. */
export const LOG_CAP = 200;
/** A departed session's file is read, and kept by the sweep, this long after its last write. */
export const LOG_RETENTION_MS = 24 * 60 * 60_000;
/** Entries `telecom({ action: "log" })` and `/telecom log` show: the newest this many. */
export const LOG_SHOWN = 40;
/** An entry's text, in characters. */
const LOG_TEXT_CAP = 240;
/** Paths an entry carries (claim patterns, a broadcast's paths), and characters in each. */
const LOG_PATHS_CAP = 8;
const LOG_PATH_CAP = 300;
/** One shown line, everything included. */
const LOG_LINE_CAP = 300;
/** A log file larger than this is not a log this version writes: it is skipped, not parsed. */
const LOG_FILE_CAP = 4 * 1024 * 1024;
/** Sessions share this machine's clock: an entry further ahead of it than this is forged. */
const CLOCK_SKEW_MS = 60_000;
/** The sweep of departed sessions' files runs at most this often. */
const LOG_SWEEP_MS = 10 * 60_000;
/** Consecutive failed writes of this session's file before the human is warned. */
const LOG_FAILURES_REPORTED = 3;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;

/** What a session logs about itself. Readers accept any kind: the text says what happened. */
export type LogKind = "join" | "leave" | "task" | "broadcast" | "claim" | "release";

export interface LogEntry {
	v: number;
	ts: number;
	/** A `LogKind`, or a newer version's kind (shown by its text all the same). */
	kind: string;
	/** What happened, without the callsign: "claimed src/auth/** — rewriting login". One line. */
	text: string;
	/** The paths it is about, as the session wrote them (relative to its checkout, or absolute). */
	paths?: string[];
	/** Who did it, and where: readers keep the entries of their repository (`sameRepo`). */
	session: string;
	callsign: string;
	projectRoot: string;
	repo?: string;
}

/** The session an entry is written for: its id, callsign and lane. */
export interface LogAuthor extends Lane {
	id: string;
	callsign: string;
}

/** What `telecom({ action: "log" })` points at; appended to a full brief when peers have logged. */
export const LOG_HINT =
	'What the team did before this point (broadcasts, tasks, claims, joins and leaves) is in its log: telecom({ action: "log" }).';

/**
 * One entry as read from a file: validated and bounded, or `null`. `owner` is the session the file
 * is named after: each file is written only by its owner, so an entry claiming anyone else is forged.
 */
export function parseLogEntry(value: unknown, owner: string, now = Date.now()): LogEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (r.v !== LOG_VERSION || r.session !== owner || !isId(r.session) || !isPath(r.projectRoot)) return null;
	if (typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts > now + CLOCK_SKEW_MS) return null;
	if (typeof r.kind !== "string" || !KIND_PATTERN.test(r.kind)) return null;
	const text = line(r.text, LOG_TEXT_CAP);
	if (!text) return null;
	const paths = Array.isArray(r.paths)
		? r.paths
				.slice(0, LOG_PATHS_CAP)
				.map((p) => line(p, LOG_PATH_CAP))
				.filter((p): p is string => p !== undefined)
		: [];
	const callsign = typeof r.callsign === "string" && CALLSIGN_PATTERN.test(r.callsign) ? r.callsign : shortId(r.session);
	return {
		v: LOG_VERSION,
		ts: r.ts,
		kind: r.kind,
		text,
		...(paths.length > 0 ? { paths } : {}),
		session: r.session,
		callsign,
		projectRoot: r.projectRoot,
		...(isPath(r.repo) ? { repo: r.repo } : {}),
	};
}

/** The entries of one log file's text, oldest first; malformed lines are skipped. */
export function parseLogFile(text: string, owner: string, now = Date.now()): LogEntry[] {
	const out: LogEntry[] = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			continue;
		}
		const entry = parseLogEntry(value, owner, now);
		if (entry) out.push(entry);
	}
	return out;
}

/** "broadcast: the API moved — about src/api/**": a broadcast as the log tells it. */
export function broadcastText(message: string, paths: readonly string[], human = false): string {
	return `${human ? "broadcast from its human" : "broadcast"}: ${clip(message, LOG_TEXT_CAP)}${paths.length > 0 ? ` — about ${paths.join(", ")}` : ""}`;
}

/** Does `entry` touch any of `wanted` (paths or globs relative to `root`, the reader's checkout)? */
export function entryTouches(entry: LogEntry, wanted: readonly string[], root: string): boolean {
	for (const path of entry.paths ?? []) {
		// Written relative to the author's checkout: the same repository path in every lane.
		const pattern = laneRelativePattern(path, entry.projectRoot);
		if (pattern !== null && wanted.some((w) => claimsOverlap(w, pattern, root))) return true;
	}
	// A task or a broadcast without paths may still name the file.
	return wanted.some((w) => entry.text.includes(w));
}

/**
 * The log as a model or a human reads it: a header, then one line per entry, oldest first,
 * "<time ago> <callsign> <what>". `entries` is already the part to show; `total` is how many
 * there were before cutting. Own entries are marked, so an agent recognises its own decisions.
 */
export function renderLog(
	entries: readonly LogEntry[],
	opts: { self: string; total: number; paths?: readonly string[]; now?: number },
): string {
	const now = opts.now ?? Date.now();
	const about = opts.paths && opts.paths.length > 0 ? ` about ${clip(opts.paths.join(", "), LOG_PATH_CAP)}` : "";
	if (entries.length === 0) {
		return about
			? `No team log entry is${about}. telecom({ action: "log" }) shows every entry.`
			: "The team log is empty: nobody in this repository has joined, broadcast, set a task, claimed or released anything recently.";
	}
	const head =
		entries.length < opts.total
			? `📡 Team log${about}: the last ${entries.length} of ${opts.total} entries, oldest first.`
			: `📡 Team log${about}: ${entries.length === 1 ? "1 entry" : `${entries.length} entries`}, oldest first.`;
	const lines = entries.map((e) => clip(`${ago(e.ts, now)} ${e.callsign}${e.session === opts.self ? " (you)" : ""} ${e.text}`, LOG_LINE_CAP));
	return [head, ...lines].join("\n");
}

/** A file's entries as last read, kept while the file is unchanged or briefly unreadable. */
interface CachedFile {
	mtimeMs: number;
	size: number;
	entries: LogEntry[];
}

/**
 * This session's log, and the reader of everyone's. Lives on the session's `Runtime`; `open`
 * at connect, `record` as things happen, `flush` on the tick, `close` when the session leaves.
 */
export class TeamLog {
	private dir: string | null = null;
	private owner: string | null = null;
	/** This session's entries, oldest first, at most `LOG_CAP`. */
	private own: LogEntry[] = [];
	/** Its file was read (or found missing). Until then a write would drop what the file holds. */
	private loaded = false;
	private dirty = false;
	private failures = 0;
	private lastSweep = 0;
	private cache = new Map<string, CachedFile>();

	/** Start logging as session `id` under the transport root, keeping what its file already holds
	 *  (a resume or a reload continues the same history). */
	open(root: string, id: string): void {
		this.dir = join(root, "log");
		this.owner = id;
		this.own = [];
		this.loaded = false;
		this.dirty = false;
		this.failures = 0;
		this.cache = new Map();
		this.load();
	}

	/** Write what is pending, then stop. */
	close(): Result<object> | null {
		const written = this.flush();
		this.abandon();
		return written;
	}

	/** Stop without writing: the file belongs to another process of this session now. */
	abandon(): void {
		this.dir = null;
		this.owner = null;
		this.own = [];
		this.dirty = false;
		this.cache = new Map();
	}

	/** Remember something this session did; it reaches the file at the next `flush`. */
	record(author: LogAuthor, kind: LogKind, text: string, paths: readonly string[] = [], now = Date.now()): void {
		if (!this.owner || author.id !== this.owner) return;
		const kept = paths.slice(0, LOG_PATHS_CAP).map((p) => clip(p, LOG_PATH_CAP)).filter(Boolean);
		this.own.push({
			v: LOG_VERSION,
			ts: now,
			kind,
			text: clip(text, LOG_TEXT_CAP),
			...(kept.length > 0 ? { paths: kept } : {}),
			session: author.id,
			callsign: author.callsign,
			projectRoot: author.projectRoot,
			...(author.repo ? { repo: author.repo } : {}),
		});
		if (this.own.length > LOG_CAP) this.own.splice(0, this.own.length - LOG_CAP);
		this.dirty = true;
	}

	/**
	 * Rewrite this session's file when something changed: null when there was nothing to write, the
	 * write's result otherwise. A failed write stays pending for the next tick; `report` says when
	 * failures have repeated enough to tell the human (one is a passing file lock).
	 */
	flush(): (Result<object> & { report?: boolean }) | null {
		if (!this.dirty || !this.dir || !this.owner) return null;
		let written: Result<object>;
		if (!this.loaded && !this.load()) {
			// The file could not be read at open: writing now would replace the history it holds.
			written = { ok: false, reason: `${this.owner}.jsonl cannot be read, so it is not rewritten yet` };
		} else {
			try {
				mkdirSync(this.dir, { recursive: true, mode: 0o700 });
				const body = this.own.map((e) => JSON.stringify(e)).join("\n");
				written = writeAtomic(this.dir, `${this.owner}.jsonl`, body ? `${body}\n` : "");
			} catch (error) {
				written = { ok: false, reason: messageOf(error) };
			}
		}
		if (written.ok) {
			this.dirty = false;
			this.failures = 0;
			return written;
		}
		this.failures++;
		return { ...written, report: this.failures >= LOG_FAILURES_REPORTED };
	}

	/**
	 * Every entry of the sessions in `lane`'s repository, oldest first: this session's from memory,
	 * a live session's file whatever its age, and a departed session's for `LOG_RETENTION_MS`. A file
	 * that cannot be read right now keeps the entries it had when it last could.
	 */
	read(lane: Lane, live: ReadonlySet<string>, now = Date.now()): LogEntry[] {
		const out: LogEntry[] = this.own.filter((e) => sameRepo(e, lane));
		if (!this.dir) return out;
		const cache = new Map<string, CachedFile>();
		for (const name of this.files()) {
			const id = name.slice(0, -".jsonl".length);
			if (!isId(id) || id === this.owner) continue;
			let file: CachedFile | undefined;
			try {
				const stat = lstatSync(join(this.dir, name));
				// A link could point anywhere; nothing this version writes is one. Anything else that will
				// not read as a file right now is treated like a locked file below: kept, retried.
				if (stat.isSymbolicLink() || stat.size > LOG_FILE_CAP) continue;
				if (!live.has(id) && now - stat.mtimeMs > LOG_RETENTION_MS) continue;
				const known = this.cache.get(name);
				file =
					known && known.mtimeMs === stat.mtimeMs && known.size === stat.size
						? known
						: { mtimeMs: stat.mtimeMs, size: stat.size, entries: parseLogFile(readFileSync(join(this.dir, name), "utf8"), id, now) };
			} catch (error) {
				// Gone is gone; anything else (Windows holds the file mid-rename) is retried next read.
				if (isErrno(error, "ENOENT")) continue;
				file = this.cache.get(name);
			}
			if (!file) continue;
			cache.set(name, file);
			for (const entry of file.entries) if (sameRepo(entry, lane)) out.push(entry);
		}
		this.cache = cache;
		return out.sort((a, b) => a.ts - b.ts);
	}

	/**
	 * Remove the files of sessions that are gone and wrote nothing for `LOG_RETENTION_MS`, and temp
	 * files a crash left behind. At most every `LOG_SWEEP_MS`; `live` is asked only when it runs.
	 */
	sweep(live: () => ReadonlySet<string>, now = Date.now(), force = false): string[] {
		if (!this.dir || (!force && now - this.lastSweep < LOG_SWEEP_MS)) return [];
		this.lastSweep = now;
		const alive = live();
		const removed: string[] = [];
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return removed; // no log written yet
		}
		for (const name of names) {
			const temp = name.startsWith(".tmp-");
			const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : null;
			if (!temp && (id === null || !isId(id) || alive.has(id) || id === this.owner)) continue;
			try {
				if (now - lstatSync(join(this.dir, name)).mtimeMs <= LOG_RETENTION_MS) continue;
				unlinkSync(join(this.dir, name));
				if (id) removed.push(id);
			} catch {
				/* raced with another sweeper, or locked: the next sweep tries again */
			}
		}
		return removed;
	}

	/** Load this session's own file, entries first: true once it was read or found missing. */
	private load(): boolean {
		if (!this.dir || !this.owner) return false;
		let text: string;
		try {
			const path = join(this.dir, `${this.owner}.jsonl`);
			text = lstatSync(path).size > LOG_FILE_CAP ? "" : readFileSync(path, "utf8");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return false;
			text = "";
		}
		const earlier = parseLogFile(text, this.owner);
		this.own = [...earlier, ...this.own].slice(-LOG_CAP);
		this.loaded = true;
		return true;
	}

	private files(): string[] {
		if (!this.dir) return [];
		try {
			return readdirSync(this.dir).filter((n) => n.endsWith(".jsonl") && !n.startsWith("."));
		} catch {
			return [];
		}
	}
}
