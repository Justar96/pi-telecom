/** util — small pure helpers shared by every module. No I/O except `fileFingerprint`. */
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
