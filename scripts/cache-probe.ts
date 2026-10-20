/**
 * cache-probe — a test-only pi extension that records, for every provider request, whether the
 * request is a pure APPEND to the previous one: same system prompt, same tools, and the previous
 * request's messages as an unchanged prefix. That is the condition for a prompt-cache hit, so if
 * it holds for every request, nothing (telecom included) broke the cache.
 *
 * `cache_control` markers are stripped before comparing: pi moves the cache breakpoint to the
 * newest message on every request, which is how prefix caching is supposed to work.
 *
 * Writes one JSON line per request to $CACHE_PROBE_LOG.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function strip(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(strip);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "cache_control" || k === "cachePoint") continue;
			out[k] = strip(v);
		}
		return out;
	}
	return value;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 12);

export default function (pi: ExtensionAPI): void {
	const log = process.env.CACHE_PROBE_LOG;
	if (!log) return;
	let prev: { system: string; tools: string; messages: string[] } | null = null;
	let seq = 0;
	pi.on("before_provider_request", (event) => {
		const p = strip(event.payload) as Record<string, unknown>;
		const all = (Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : []) as Array<Record<string, unknown>>;
		const systemMsgs = all.filter((m) => m.role === "system" || m.role === "developer");
		const messages = all.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => JSON.stringify(m));
		const cur = { system: hash(p.system ?? systemMsgs), tools: hash(p.tools), messages };
		let firstDiff = -1;
		if (prev) {
			for (let i = 0; i < prev.messages.length; i++) {
				if (prev.messages[i] !== messages[i]) {
					firstDiff = i;
					break;
				}
			}
		}
		const row = {
			seq: ++seq,
			system: cur.system,
			tools: cur.tools,
			messages: messages.length,
			systemSame: prev ? prev.system === cur.system : null,
			toolsSame: prev ? prev.tools === cur.tools : null,
			prefixIntact: prev ? firstDiff === -1 && messages.length >= prev.messages.length : null,
			firstDiff,
			...(firstDiff >= 0 && prev
				? { was: (prev.messages[firstDiff] ?? "").slice(0, 300), now: (messages[firstDiff] ?? "").slice(0, 300) }
				: {}),
			newTail: messages.slice(prev ? prev.messages.length : 0).map((m) => m.slice(0, 160)),
		};
		appendFileSync(log, `${JSON.stringify(row)}\n`);
		prev = cur;
	});
}
