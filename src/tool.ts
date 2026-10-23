/**
 * tool — the static half of the `telecom` tool: name, schema, model-facing text, renderers, and
 * the result shape. The `execute` half needs the session's state and lives in `index.ts`.
 *
 * Everything here is fixed at registration and must stay fixed: the description, snippet and
 * guidelines are part of every session's cached prompt prefix, so they carry no callsigns, counts
 * or anything else that varies (AGENTS.md, rule 1). Keep the description short; every session pays
 * for it in tokens.
 */
import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import {
	agentColor,
	boardCallsigns,
	callsignText,
	dimCalls,
	isHint,
	moreLines,
	paintCallsigns,
	plainText,
	styleBoard,
	telecomPanel,
} from "./render.ts";
import { clip } from "./util.ts";

export const TOOL_NAME = "telecom";

/** Tool results are folded to this many lines until expanded. */
const RESULT_FOLD_LINES = 8;
/** A call's message is previewed up to this many characters until expanded. */
const CALL_PREVIEW_CHARS = 240;
/** Where a delivery report lists the agents it did not reach; the result renderer looks for it. */
const FAILED_MARK = " (failed: ";

export const TOOL_ACTIONS = ["board", "send", "ask", "reply", "broadcast", "status", "claim", "release"] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

export const TOOL_PARAMETERS = Type.Object({
	// StringEnum, not a Union of Literals: Google models reject the anyOf form.
	action: StringEnum(TOOL_ACTIONS, { description: "What to do." }),
	to: Type.Optional(Type.String({ description: "send/ask: callsign, session name or id (as the board shows it)." })),
	message: Type.Optional(Type.String({ description: "The text; for status your task; for claim the reason." })),
	askId: Type.Optional(Type.String({ description: "reply: the ask's handle (optional if only one is waiting)." })),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Project-relative paths or globs. claim/release: what to reserve. send/ask without `to`: reach whoever claims or last changed them. broadcast: what it is about.",
		}),
	),
	timeoutSec: Type.Optional(Type.Number({ description: "ask: seconds to wait (default 300)." })),
	scope: Type.Optional(
		StringEnum(["project", "machine"] as const, { description: 'board/broadcast: "project" (default) or "machine".' }),
	),
});

export type ToolParams = Static<typeof TOOL_PARAMETERS>;

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	/** The same facts as `details`, for programmatic callers (codemode scripts); see `outputSchema`. */
	structuredContent: JsonValue;
	isError?: boolean;
};

export function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
	const data = { ok: true, ...details };
	return { content: [{ type: "text", text }], details: data, structuredContent: data as JsonValue };
}

/** `bravo, charlie (failed: delta)`: who a delivery reached, and who it did not. */
export function deliveryReport(reached: readonly string[], failed: readonly string[]): string {
	return `${reached.join(", ") || "nobody"}${failed.length ? `${FAILED_MARK}${failed.join(", ")})` : ""}`;
}

export function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
	const data = { ok: false, ...details };
	return {
		content: [{ type: "text", text: `telecom: ${text}` }],
		details: data,
		structuredContent: data as JsonValue,
		isError: true,
	};
}

/** Everything `registerTool` needs except `execute`. */
export const TOOL_SPEC = {
	name: TOOL_NAME,
	label: "Telecom",
	description: [
		"Coordinate with other pi agents working in parallel (this project by default). Agents have callsigns: alpha, bravo, ….",
		"board: who works here, on what, their claims and recent changes (scope machine: all projects).",
		"send: message an agent (to = callsign, or paths = whoever owns them); wakes it if idle. ask: same, then wait for the answer. reply: answer an inbound ask (askId).",
		"broadcast: tell the whole project (never wakes idle agents); with paths, agents working elsewhere get it at their next prompt. status: set the task peers see (message).",
		"claim: reserve paths/globs so peers stay out (message = why). release: give them back (all if paths omitted).",
	].join("\n"),
	promptSnippet: "Coordinate with parallel pi agents: team board, message/ask/reply, broadcast, claim paths",
	promptGuidelines: [
		"When 📡 telecom shows other agents in this project: claim an area before a large change and release it after; re-read a file a peer changed before editing it; reply to a peer's ask promptly (they are blocked).",
		"Message peers only for real coordination (requests, handoffs, shared-interface changes) — no acknowledgements; each message costs the recipient a turn.",
		"Broadcast only what every agent must act on, with `paths` when it is about files; report progress with `status`, or `send` it to whoever coordinates.",
	],
	parameters: TOOL_PARAMETERS,
	// Hints for permission extensions: telecom only talks to local pi sessions and edits nothing.
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	// Codemode scripts receive `structuredContent` (always `{ ok, ... }`) instead of the text.
	outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: true }),

	// telecom draws its own panel (the same one peers' messages arrive in), not pi's green tool box:
	// coordination reads as one thread in the transcript. The call draws the panel's top, the
	// result its bottom (`render.ts`, `Panel`).
	renderShell: "self",

	renderCall(args, theme, context) {
		const message = args.message?.trim() ?? "";
		const preview = context?.expanded ? message : clip(message, CALL_PREVIEW_CHARS);
		let body = "";
		if (preview) {
			// A claim's message is its reason; everywhere else it is what the peer reads.
			body = args.action === "claim" ? theme.fg("muted", preview) : paintCallsigns(theme, preview, mentioned(args));
		}
		const text = body ? `${callHeader(args, theme)}\n${body}` : callHeader(args, theme);
		return telecomPanel(theme, text, edgeColor(args, context?.isError === true), context?.outputPad ?? 1, { top: true, bottom: false });
	},

	// Compact by default (the board can be long); the full text when expanded.
	renderResult(result, { expanded, isPartial }, theme, context) {
		const text = result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		const details = (result.details ?? {}) as Record<string, unknown>;
		const failed = context?.isError === true || details.ok === false;
		const names = [...mentioned(context?.args), ...detailCallsigns(details)];
		let lines: string[];
		if (isPartial) {
			lines = [paintCallsigns(theme, `◌ ${text || "working…"}`, names, (t) => theme.fg("muted", t))];
		} else if (failed) {
			const reason = text.replace(/^telecom: /, "");
			lines = [`${theme.fg("error", "✗")} ${dimCalls(theme, reason, (t) => paintCallsigns(theme, t, names, (s) => theme.fg("error", s)))}`];
		} else {
			lines = resultLines(context?.args?.action, text, details, names, theme);
		}
		if (!expanded && lines.length > RESULT_FOLD_LINES) {
			lines = [...lines.slice(0, RESULT_FOLD_LINES), moreLines(theme, lines.length - RESULT_FOLD_LINES)];
		}
		return telecomPanel(theme, lines.join("\n"), edgeColor(context?.args, failed), context?.outputPad ?? 1, { top: false, bottom: true });
	},
} satisfies Omit<ToolDefinition<typeof TOOL_PARAMETERS>, "execute">;

// ------------------------------------------------------------------ how a call and its result look

/** The callsign `to` names, when it names one (it may also be a session name or an id). */
function targetCallsign(args: Partial<ToolParams> | undefined): string | undefined {
	const to = args?.to?.trim().replace(/^@/, "").toLowerCase();
	return to && CALLSIGN_PATTERN.test(to) ? to : undefined;
}

function mentioned(args: Partial<ToolParams> | undefined): string[] {
	const to = targetCallsign(args);
	return to ? [to] : [];
}

function detailCallsigns(details: Record<string, unknown>): string[] {
	const names: string[] = [];
	for (const key of ["to", "from", "callsign", "waiting"]) if (typeof details[key] === "string") names.push(details[key] as string);
	for (const key of ["peers", "reached", "failed"]) {
		const list = details[key];
		if (Array.isArray(list)) for (const c of list) if (typeof c === "string") names.push(c);
	}
	return names;
}

/** The panel's edge: the addressee's colour, so a conversation keeps one colour; red on failure. */
function edgeColor(args: Partial<ToolParams> | undefined, failed: boolean): ThemeColor {
	if (failed) return "error";
	const to = targetCallsign(args);
	return to ? agentColor(to) : "accent";
}

/** `📡 send → bravo`, `📡 claim src/auth/**`, `📡 broadcast → the team · about src/db`. */
function callHeader(args: Partial<ToolParams>, theme: Theme): string {
	const action = args.action ?? "…";
	const muted = (t: string) => theme.fg("muted", t);
	const arrow = muted(" → ");
	const paths = (args.paths ?? []).filter((p) => p.trim());
	const pathList = plainText(theme, paths.join(", "));
	let head = `📡 ${theme.bold(theme.fg("toolTitle", action))}`;
	const to = args.to?.trim();
	const callsign = targetCallsign(args);
	const who = callsign ? callsignText(theme, callsign) : to ? theme.bold(plainText(theme, to)) : "";
	switch (action) {
		case "send":
		case "ask":
			if (who) head += arrow + who;
			else if (paths.length) head += `${arrow}${muted("whoever owns ")}${pathList}`;
			if (action === "ask" && args.timeoutSec) head += muted(` · waits up to ${args.timeoutSec}s`);
			break;
		case "reply":
			if (who) head += arrow + who;
			if (args.askId) head += theme.fg("dim", ` · ${args.askId}`);
			break;
		case "broadcast":
			head += arrow + muted(args.scope === "machine" ? "every agent on this machine" : "the team");
			if (paths.length) head += muted(" · about ") + pathList;
			break;
		case "claim":
			if (paths.length) head += ` ${theme.bold(pathList)}`;
			break;
		case "release":
			head += paths.length ? ` ${theme.bold(pathList)}` : muted(" every claim");
			break;
		case "board":
			if (args.scope === "machine") head += muted(" · every agent on this machine");
			break;
	}
	return head;
}

/** `text` cut at the first `separator`: the part before it, and the part after (none when absent). */
function splitOnce(text: string, separator: string): [string, string | undefined] {
	const at = text.indexOf(separator);
	return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

/** A successful result, for the human: what happened first, the model's guidance quieter below. */
function resultLines(
	action: string | undefined,
	text: string,
	details: Record<string, unknown>,
	names: readonly string[],
	theme: Theme,
): string[] {
	const tick = theme.fg("success", "✓");
	const say = (t: string) => paintCallsigns(theme, t, names);
	const muted = (t: string) => dimCalls(theme, t, (s) => paintCallsigns(theme, s, names, (x) => theme.fg("muted", x)));
	const [first = "", ...rest] = text.split("\n");
	switch (action) {
		case "board":
			return styleBoard(theme, text, [...names, ...boardCallsigns(text)], { title: true }).split("\n");
		case "send": {
			// "sent to bravo (idle — this wakes them)": the delivery, then what it means.
			const hint = /^(.*) \(([^()]*)\)$/.exec(first);
			return hint ? [`${tick} ${say(hint[1] ?? "")}${theme.fg("muted", ` · ${hint[2]}`)}`] : [`${tick} ${say(first)}`];
		}
		case "ask": {
			if (details.interrupted === true) {
				const [why = "", ...more] = text.split("\n\n");
				return [`${theme.fg("warning", "⚠")} ${theme.fg("warning", why)}`, ...more.join("\n\n").split("\n").map((l) => (isHint(l) ? theme.fg("dim", l) : say(l)))];
			}
			// "alpha answered:\n\n<the answer>": the answer is what the human wants to read.
			return [`${tick} ${say(first.replace(/:$/, ""))}`, ...rest.join("\n").replace(/^\n+/, "").split("\n").map(say)];
		}
		case "claim": {
			const cut = first.indexOf(". Peers editing");
			if (cut < 0) return [`${tick} ${say(first)}`, ...rest.map(muted)];
			const [held, note] = splitOnce(first.slice(cut + ". ".length), " Note: ");
			// "claimed src/auth/** — reason": the call above already shows the reason.
			const lines = [`${tick} ${say(splitOnce(first.slice(0, cut), " — ")[0])}`, muted(held)];
			if (note !== undefined) lines.push(`${theme.fg("warning", "⚠")} ${theme.fg("warning", note)}`);
			return lines;
		}
		case "release":
		case "broadcast": {
			// "released src/x — told bravo, …" / "broadcast to bravo — about …": the act, then detail.
			const [head, detail] = splitOnce(first, " — ");
			const [reached, failed] = splitOnce(head, FAILED_MARK);
			const shown = failed === undefined ? say(head) : `${say(reached)}${theme.fg("error", head.slice(reached.length))}`;
			return [`${tick} ${shown}${detail === undefined ? "" : theme.fg("muted", ` · ${detail}`)}`, ...rest.map(muted)];
		}
		default:
			return [`${tick} ${say(first)}`, ...rest.map(muted)];
	}
}
