/**
 * notices — what a change notice says, in both directions: the summary this agent sends peers
 * about its own edit, and the text this agent's model reads about a peer's edits. Pure; the
 * caller decides when to send and when to flush.
 */
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { PeerChange } from "./awareness.ts";
import { displayPath } from "./project.ts";
import type { FileChangedData } from "./transport.ts";
import { clip, plural } from "./util.ts";

/** Changed lines quoted from a patch, and how long each may be. */
const EXCERPT_LINES = 4;
const EXCERPT_LINE_CAP = 100;

/** A peer's change waiting to be told, coalesced per peer and path. */
export interface PendingNotice {
	change: PeerChange;
	/** How many changes to this path by this peer were coalesced into the notice. */
	count: number;
	/** Why this agent cares: it read the file, edited it, or holds a claim on it. */
	relation: "read" | "edited" | "claimed";
	claim?: string;
	excerpt?: string[];
}

/** Summarize this agent's own change for its peers: what kind, where, and a few changed lines. */
export function summarizeOwnChange(
	op: "edit" | "write",
	event: Pick<ToolResultEvent, "input" | "details">,
	created: boolean,
): Pick<FileChangedData, "summary" | "excerpt" | "created"> {
	const input = event.input as { edits?: unknown; oldText?: unknown; content?: unknown };
	if (op === "write") {
		const lines = typeof input.content === "string" ? input.content.split("\n").length : 0;
		return { summary: `${created ? "created" : "rewrote"} it${lines ? ` (${plural(lines, "line")})` : ""}`, created };
	}
	const count = Array.isArray(input.edits) ? input.edits.length : typeof input.oldText === "string" ? 1 : 0;
	const details = event.details as { patch?: unknown; firstChangedLine?: unknown } | undefined;
	const line = typeof details?.firstChangedLine === "number" ? ` from line ${details.firstChangedLine}` : "";
	const excerpt = typeof details?.patch === "string" ? patchExcerpt(details.patch) : [];
	return { summary: `${plural(Math.max(count, 1), "edit")}${line}`, ...(excerpt.length ? { excerpt } : {}) };
}

/** The first few added or removed lines of a unified diff, skipping the file headers. */
function patchExcerpt(patch: string): string[] {
	const excerpt: string[] = [];
	for (const l of patch.split("\n")) {
		const changed = (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---");
		if (!changed || l.trim().length <= 1) continue;
		excerpt.push(clip(l, EXCERPT_LINE_CAP));
		if (excerpt.length >= EXCERPT_LINES) break;
	}
	return excerpt;
}

function describeNotice(notice: PendingNotice, root: string): string {
	const { change, count } = notice;
	const times = count > 1 ? ` (${count}×)` : "";
	const verb = `${change.op === "write" ? "rewrote" : "edited"}${times}`;
	const why =
		notice.relation === "claimed"
			? `inside your claim "${notice.claim}"`
			: notice.relation === "edited"
				? "you edited this file earlier"
				: "you read this file earlier";
	const summary = change.summary ? `, ${change.summary}` : "";
	const excerpt = notice.excerpt?.length ? `\n${notice.excerpt.map((l) => `      ${l}`).join("\n")}` : "";
	return `  • ${displayPath(change.path, root)} — ${verb}${summary} · ${why}${excerpt}`;
}

/** One message per peer: the files it changed that this agent works with, and what to do. */
export function renderNotice(
	callsign: string,
	list: readonly PendingNotice[],
	root: string,
): { content: string; summary: string } {
	const files = list.length === 1 ? "a file" : plural(list.length, "file");
	const lines = list.map((n) => describeNotice(n, root));
	return {
		content: `**📡 ${callsign} changed ${files} you are working with**\n${lines.join("\n")}\nRe-read before you edit ${list.length === 1 ? "it" : "them"}; your earlier view is stale.`,
		summary: `${callsign} changed ${list.map((n) => displayPath(n.change.path, root)).join(", ")}`,
	};
}
