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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { clip } from "./util.ts";

export const TOOL_NAME = "telecom";

/** Tool results are folded to this many lines until expanded. */
const RESULT_FOLD_LINES = 8;

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
	],
	parameters: TOOL_PARAMETERS,
	// Hints for permission extensions: telecom only talks to local pi sessions and edits nothing.
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	// Codemode scripts receive `structuredContent` (always `{ ok, ... }`) instead of the text.
	outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: true }),

	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("telecom ")) + theme.fg("accent", args.action ?? "");
		if (args.to) text += theme.fg("muted", " → ") + theme.fg("accent", args.to);
		if (args.askId) text += theme.fg("dim", ` ${args.askId}`);
		if (args.paths?.length) text += theme.fg("muted", ` ${args.paths.join(", ")}`);
		if (args.message) text += theme.fg("dim", ` — ${clip(args.message, 70)}`);
		return new Text(text, 0, 0);
	},

	// Compact by default (the board can be long); the full text when expanded.
	renderResult(result, { expanded, isPartial }, theme) {
		const text = result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		if (isPartial) return new Text(theme.fg("dim", text || "working…"), 0, 0);
		const failed = (result.details as { ok?: unknown } | undefined)?.ok === false;
		const color = failed ? "error" : "toolOutput";
		const lines = text.split("\n");
		if (expanded || lines.length <= RESULT_FOLD_LINES) return new Text(theme.fg(color, text), 0, 0);
		return new Text(
			`${theme.fg(color, lines.slice(0, RESULT_FOLD_LINES).join("\n"))}\n${theme.fg("dim", `… ${lines.length - RESULT_FOLD_LINES} more lines (expand to read)`)}`,
			0,
			0,
		);
	},
} satisfies Omit<ToolDefinition<typeof TOOL_PARAMETERS>, "execute">;
