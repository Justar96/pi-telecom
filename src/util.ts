/** util — small pure helpers shared by every module. No I/O except `fileFingerprint` and `fileExists`. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** "just now", "42s ago", "5m ago", "3h ago". */
export function ago(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** Files larger than this are fingerprinted by size+mtime instead of by content. */
const HASH_CAP = 8 * 1024 * 1024;

/**
 * What a file looks like right now: a content hash (or size+mtime above the cap), or `null`
 * when the file does not exist or cannot be read. Two equal fingerprints mean "nothing moved".
 */
export function fileFingerprint(path: string): string | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return null;
		if (stat.size > HASH_CAP) return `stat:${stat.size}:${Math.round(stat.mtimeMs)}`;
		return `sha1:${createHash("sha1").update(readFileSync(path)).digest("hex")}`;
	} catch {
		return null;
	}
}

/**
 * The short form of a session id shown to people and models: its last 8 characters. pi's session
 * ids are UUIDv7, whose leading characters are a timestamp shared by every session started within
 * the same minute; the tail is random (in v4 ids too), so it tells sessions apart.
 */
export function shortId(id: string): string {
	return id.replace(/-/g, "").slice(-8);
}

/** Does `query` (at least `min` characters) name this id, as its start or as its short form? */
export function idMatches(id: string, query: string, min: number): boolean {
	const q = query.replace(/-/g, "").toLowerCase();
	if (q.length < min) return false;
	const plain = id.replace(/-/g, "").toLowerCase();
	return plain.startsWith(q) || plain.endsWith(q);
}

let idCounter = 0;

/** A fresh id, unique across processes and safe as a file name. */
export function newId(prefix: string): string {
	idCounter += 1;
	const rand = Math.random().toString(36).slice(2, 6);
	return `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${idCounter.toString(36)}${rand}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Set `key` in an insertion-ordered map as its newest entry, evicting the oldest entries past
 * `cap`. Every long-lived map keyed by peer input is bounded this way, so a busy or hostile peer
 * cannot grow this process's memory without limit.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > cap) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/** True when `path` names an existing regular file. */
export function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
