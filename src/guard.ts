/**
 * guard — the hooks around pi's `edit`, `write` and `read` tools. Before an edit or a write it
 * asks `awareness` for verdicts (a peer's claim, a stale view, a lane overlap) and blocks or
 * warns; after one that succeeded it records this agent's view, announces the change to the team,
 * and spends the one-time parts of the warnings it showed (AGENTS.md, "The guard's one-time
 * parts"). A read only records the view.
 */
import { join } from "node:path";
import type { ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Contest, PeerChange, Verdict } from "./awareness.ts";
import { lineOf } from "./family.ts";
import { matchesClaim } from "./glob.ts";
import { summarizeOwnChange } from "./notices.ts";
import { canonicalPath, displayPath } from "./project.ts";
import type { Runtime } from "./runtime.ts";
import type { FileChangedData } from "./transport.ts";
import { fileExists, setBounded } from "./util.ts";

/** Own recent changes published in the presence record. */
const RECENT_CAP = 12;
/** Per-call bookkeeping kept between tool_call and tool_result; bounded in case a result never comes. */
const CALL_MAP_CAP = 256;

/** What the guard learns at `tool_call` and needs again at the matching `tool_result`. */
interface CallState {
	/** Warnings to append to the tool's result. */
	note?: string;
	/** For `write`: whether the file existed before, so peers hear "created" vs "rewrote". */
	existedBefore?: boolean;
	/** The peer change a warned (stale) edit was applied over. */
	staleOver?: PeerChange;
	/** Lane notes shown with this call: spent only if it succeeds. */
	laneNotes?: string[];
	/** A claim in another checkout this call edits inside: its owner is told only if it succeeds. */
	laneContest?: Contest;
}

export interface Guard {
	/** Forget calls in flight: the session left the switchboard. */
	clear(): void;
}

export function registerGuard(rt: Runtime): Guard {
	const calls = new Map<string, CallState>();

	function noteCall(toolCallId: string, update: (state: CallState) => void): void {
		const state = calls.get(toolCallId) ?? {};
		update(state);
		setBounded(calls, toolCallId, state, CALL_MAP_CAP);
	}

	function verdictToResult(verdict: Verdict, toolCallId: string): ToolCallEventResult | undefined {
		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "warn") {
			noteCall(toolCallId, (state) => {
				state.note = state.note ? `${state.note}\n${verdict.note}` : verdict.note;
				if (verdict.staleChange) state.staleOver = verdict.staleChange;
				if (verdict.laneNotes) state.laneNotes = [...(state.laneNotes ?? []), ...verdict.laneNotes];
				if (verdict.contested?.lane) state.laneContest = verdict.contested;
			});
		}
		return undefined;
	}

	rt.on("tool_call", (event, ctx) => {
		const me = rt.self;
		if (!me || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw.trim()) return;
		const path = canonicalPath(raw, ctx.cwd);
		const peers = rt.readPeers();
		const { awareness, cfg } = rt;
		if (event.toolName === "write") {
			const existed = awareness.hasView(path) || fileExists(path);
			noteCall(event.toolCallId, (state) => {
				state.existedBefore = existed;
			});
		}
		// Solo work pays nothing: with no teammate, no peer history for this path and no stale view
		// of it, there is nothing to check.
		if (
			rt.team(peers).length === 0 &&
			!awareness.hasPeerContext(path) &&
			!peers.some((p) => p.id !== me.id && p.recent.some((r) => r.path === path))
		) {
			return;
		}
		const claim = awareness.checkClaims(path, cfg.guard, peers, me, lineOf(me, peers));
		if (claim.action === "block") {
			// Held back in this checkout: the owner hears that someone needs the path. (A claim in
			// another checkout never holds anyone back; its owner hears once the edit has landed.)
			if (claim.contested) {
				rt.sendEvent(
					claim.contested.owner.id,
					{ topic: "claim.contested", data: { path, pattern: claim.contested.claim.pattern } },
					`${me.callsign} tried to change ${displayPath(path, me.projectRoot)}`,
				);
			}
			return { block: true, reason: claim.reason };
		}
		verdictToResult(claim, event.toolCallId);
		const stale = awareness.checkStale(path, event.toolName, cfg.guard, peers, me.id, me.projectRoot);
		const blocked = verdictToResult(stale, event.toolCallId);
		if (blocked) return blocked;
		if (cfg.guard !== "off") verdictToResult(awareness.checkLanes(path, peers, me), event.toolCallId);
		return undefined;
	});

	rt.on("tool_result", (event, ctx) => {
		const me = rt.self;
		if (!me) return;
		const toolName = event.toolName;
		if (toolName !== "read" && toolName !== "edit" && toolName !== "write") return;
		const state = calls.get(event.toolCallId) ?? {};
		calls.delete(event.toolCallId);
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || event.isError) return;
		const path = canonicalPath(raw, ctx.cwd);
		if (toolName === "read") {
			rt.awareness.noteRead(path);
			return;
		}
		rt.awareness.noteOwnWrite(path, toolName, state.staleOver);
		announceChange(path, toolName, event, toolName === "write" && state.existedBefore === false);
		// The edit landed: spend the one-time lane notes it showed, and tell a lane claim's owner.
		if (state.laneNotes) rt.awareness.commitLaneNotes(state.laneNotes);
		if (state.laneContest) {
			const { owner, claim } = state.laneContest;
			rt.awareness.noteContested(owner.id, path);
			rt.sendEvent(
				owner.id,
				{ topic: "claim.contested", data: { path, pattern: claim.pattern, lane: true } },
				`${me.callsign} changed ${displayPath(path, me.projectRoot)}`,
			);
		}
		if (!state.note) return;
		// Append to the current result only; earlier messages are never rewritten (cache rule).
		return {
			content: [...event.content, { type: "text", text: `\n${state.note}` }],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});

	/** Publish this agent's own change, keep the claims it falls in alive, and tell the team. */
	function announceChange(path: string, op: "edit" | "write", event: ToolResultEvent, created: boolean): void {
		const me = rt.self;
		if (!me || !rt.transport) return;
		const now = Date.now();
		me.recent = [{ path, op, at: now }, ...me.recent.filter((r) => r.path !== path)].slice(0, RECENT_CAP);
		// Working inside a claim keeps it alive. Claims are written against the checkout this agent
		// started in, but it may edit a worktree of its own: the same repository path there counts.
		const place = rt.awareness.placeOf(path, me);
		const asStarted = place ? join(me.projectRoot, place.rel) : path;
		for (const claim of me.claims) {
			if (matchesClaim(path, claim.pattern, me.projectRoot) || matchesClaim(asStarted, claim.pattern, me.projectRoot)) {
				claim.expiresAt = now + rt.cfg.claimTtlMs;
			}
		}
		rt.publish();
		const data: FileChangedData = { path, op, ...summarizeOwnChange(op, event, created) };
		const text = `${me.callsign} ${op === "write" ? "wrote" : "edited"} ${displayPath(path, me.projectRoot)}`;
		for (const peer of rt.team()) rt.sendEvent(peer.id, { topic: "file.changed", data }, text);
	}

	return {
		clear() {
			calls.clear();
		},
	};
}
