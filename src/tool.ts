/**
 * tool — the static half of the `telecom` tool: name, schema, model-facing text, renderers, and
 * the result shape. The `execute` half needs the session's state and lives in `actions.ts`.
 *
 * Everything here is fixed at registration and must stay fixed: the description, snippet and
 * guidelines are part of every session's cached prompt prefix, so they carry no callsigns, counts
 * or anything else that varies (AGENTS.md, rule 1). Keep the description short; every session pays
 * for it in tokens.
 */
import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { type RenderContext, renderContext } from "./host.ts";
import {
	agentColor,
	boardCallsigns,
	callsignText,
	dimCalls,
	HangingText,
	isHint,
	moreLines,
	paintCallsigns,
	plainText,
	proseStyler,
	styleBoard,
	telecomPanel,
} from "./render.ts";
import { clip } from "./util.ts";

const TOOL_NAME = "telecom";

/** Tool results are folded to this many lines until expanded. */
const RESULT_FOLD_LINES = 8;
/** The board and the log fold later: they are the answer the call asked for. */
const BOARD_FOLD_LINES = 24;
/** A call's message is previewed up to this many characters until expanded. */
const CALL_PREVIEW_CHARS = 400;
/** Where a delivery report lists the agents it did not reach; the result renderer looks for it. */
const FAILED_MARK = " (failed: ";

const TOOL_ACTIONS = ["board", "send", "ask", "reply", "broadcast", "status", "claim", "release", "log"] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

const TOOL_PARAMETERS = Type.Object({
	// StringEnum, not a Union of Literals: Google models reject the anyOf form.
	action: StringEnum(TOOL_ACTIONS, { description: "What to do." }),
	to: Type.Optional(Type.String({ description: 'send/ask/reply: callsign, session name or id (as the board shows it). send: several, comma-separated ("alpha, bravo"), each told who else got it.' })),
	message: Type.Optional(Type.String({ description: "The text; for status your task in one line; for claim the reason." })),
	askId: Type.Optional(Type.String({ description: "reply: the ask's handle (optional if only one is waiting)." })),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Project-relative paths or globs. claim/release: what to reserve (an absolute path into a worktree claims it there only). send/ask without `to`: reach whoever claims or last changed them. broadcast: what it is about.",
		}),
	),
	interrupt: Type.Optional(Type.Boolean({ description: "send: false holds it until the recipient's current run ends (progress updates, FYIs); default true." })),
	timeoutSec: Type.Optional(Type.Number({ description: "ask: seconds to wait (default 300; with wait false, 1800)." })),
	wait: Type.Optional(Type.Boolean({ description: "ask: false returns at once; the answer arrives later as a message." })),
	queue: Type.Optional(Type.Boolean({ description: "claim: false refuses a held @lock instead of waiting in line for it (default: wait; you get it, and are woken, when it frees)." })),
	pid: Type.Optional(
		Type.Integer({ description: "claim: keep these claims while this process runs (a background build or test); released when it exits. For the next job, claim again with its pid." }),
	),
	waitingFor: Type.Optional(
		Type.Array(Type.String(), {
			description: "status: callsigns you are blocked on; you are woken when one finishes a run or leaves. Declare once: it ends by itself when you get to work after hearing from them; [] clears it.",
		}),
	),
	unblocks: Type.Optional(Type.Boolean({ description: "send/reply: true when this is what the recipient waits for; it ends their wait on you at once." })),
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
		"send: message an agent (to = callsign, or paths = whoever owns them); wakes it if idle. ask: same, then wait for the answer (wait false: don't). reply: answer an inbound ask (askId).",
		"broadcast: tell the whole project (never wakes idle agents); with paths, agents working elsewhere get it at their next prompt. status: set the task peers see (message), and whom you wait for (waitingFor).",
		'claim: reserve paths/globs so peers stay out (message = why); "@name" (e.g. "@cargo") is a lock on a shared non-file resource. release: give them back (all if paths omitted).',
		"log: what the team did earlier — broadcasts, tasks, claims, joins (paths: only entries about them).",
	].join("\n"),
	promptSnippet: "Coordinate with parallel pi agents: team board, message/ask/reply, broadcast, claim paths",
	promptGuidelines: [
		"When 📡 telecom shows other agents in this project: claim an area before a large change and release it after; re-read a file a peer changed before editing it; reply to a peer's ask promptly (they are blocked).",
		"Message peers only for real coordination (requests, handoffs, shared-interface changes) — no acknowledgements; each message costs the recipient a turn.",
		"Broadcast only what every agent must act on, with `paths` when it is about files. Keep `status` to one line naming your task; `send` results and requests to whoever needs them, and progress updates and FYIs with `interrupt: false`.",
		"To hear when a peer's long job ends, ask with `wait: false` (the answer arrives as a message and wakes you), not a long `timeoutSec` or a polling loop.",
		'Take turns on a shared resource (build, test runner, port) with a lock claim such as "@cargo" (a held one puts you in line, and you are woken when it is yours), and say whom you wait for with status waitingFor, instead of negotiating leases in messages.',
	],
	parameters: TOOL_PARAMETERS,
	// Hints for permission extensions: telecom only talks to local pi sessions and edits nothing.
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	// Codemode scripts receive `structuredContent` (always `{ ok, ... }`) instead of the text.
	outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: true }),

	// telecom draws its own panel (the same one peers' messages arrive in), not pi's green tool box:
	// coordination reads as one thread in the transcript. The call and the result are two panels
	// with one edge (`render.ts`, `Panel`). omp ignores this and draws its own card (`framed`).
	renderShell: "self",

	renderCall(args, theme, last) {
		// omp passes its options (with `expanded`) where pi passes the theme, and the theme last.
		const context = renderContext<ToolParams>(last, theme as unknown as { expanded?: unknown });
		const header = callHeader(args, theme);
		const message = args.message?.trim() ?? "";
		// A claim's message is its reason. What goes to a peer is Markdown, drawn as the peer's
		// transcript draws it; a status is a plain line.
		const prose = PROSE_ACTIONS.has(args.action ?? "") ? proseStyler(theme, mentioned(args)) : null;
		const paint = (t: string) =>
			args.action === "claim" ? theme.fg("muted", t) : prose ? t.split("\n").map(prose).join("\n") : paintCallsigns(theme, t, mentioned(args));
		// Folded: the header and the start of the message share one row. Expanded: all of it.
		const text = !message
			? header
			: context.expanded
				? `${header}\n${paint(message)}`
				: `${header}${theme.fg("muted", "  ")}${paint(clip(message.replace(/\s+/g, " "), CALL_PREVIEW_CHARS))}`;
		return framed(context, theme, text, edgeColor(args, context.isError), context.expanded ? new Set() : new Set([0]));
	},

	// Folded: what happened, in a row or two (a board or an answer, up to RESULT_FOLD_LINES); the
	// guidance written for the model shows once expanded.
	renderResult(result, options, theme, last) {
		const { expanded, isPartial } = options;
		const context = renderContext<ToolParams>(last, options);
		const text = result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		const details = (result.details ?? {}) as Record<string, unknown>;
		const failed = context.isError || details.ok === false;
		const names = [...mentioned(context.args), ...detailCallsigns(details)];
		let lines: string[];
		if (isPartial) {
			lines = [paintCallsigns(theme, `◌ ${text || "working…"}`, names, (t) => theme.fg("muted", t))];
		} else if (failed) {
			// A refusal says what to do next: that is for the human too, so it is never cut.
			// Styled line by line: a colour does not carry past a line break once the text is wrapped.
			const reason = text.replace(/^telecom: /, "").split("\n");
			const paintLine = (l: string) => dimCalls(theme, l, (t) => paintCallsigns(theme, t, names, (x) => theme.fg("error", x)));
			lines = reason.map((l, i) => (i === 0 ? `${theme.fg("error", "✗")} ${paintLine(l)}` : `  ${paintLine(l)}`));
		} else {
			lines = resultLines(context.args?.action, text, details, names, theme)
				.filter((l) => expanded || !l.quiet)
				.map((l) => l.text);
		}
		// A board or log is what was asked for: it folds later than other results.
		const fold = context.args?.action === "board" || context.args?.action === "log" ? BOARD_FOLD_LINES : RESULT_FOLD_LINES;
		if (!expanded && lines.length > fold) lines = [...lines.slice(0, fold), moreLines(theme, lines.length - fold)];
		return framed(context, theme, lines.join("\n"), edgeColor(context.args, failed));
	},
} satisfies Omit<ToolDefinition<typeof TOOL_PARAMETERS>, "execute">;

// ------------------------------------------------------------------ how a call and its result look

/** The tool's rendering in telecom's panel on pi; bare on omp, which draws its own tinted card. */
function framed(context: RenderContext<ToolParams>, theme: Theme, text: string, edge: ThemeColor, clipped: ReadonlySet<number> = new Set()): Component {
	if (context.host === "omp") return new HangingText(text, clipped);
	return telecomPanel(theme, text, edge, context.outputPad, clipped);
}

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

/** Actions whose `message` another agent reads. */
const PROSE_ACTIONS: ReadonlySet<string> = new Set(["send", "ask", "reply", "broadcast"]);

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
			if (action === "ask" && args.wait === false) head += muted(" · does not wait");
			else if (action === "ask" && args.timeoutSec) head += muted(` · waits up to ${args.timeoutSec}s`);
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
		case "log":
			if (paths.length) head += muted(" · about ") + pathList;
			break;
	}
	return head;
}

/** `text` cut at the first `separator`: the part before it, and the part after (none when absent). */
function splitOnce(text: string, separator: string): [string, string | undefined] {
	const at = text.indexOf(separator);
	return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

/** A result row: `quiet` rows are guidance written for the model, shown once expanded. */
interface Row {
	text: string;
	quiet?: boolean;
}

/** A claim result's line, for the human: a claim made (✓), one not made (⚠), or guidance. */
function claimRow(line: string, theme: Theme, say: (t: string) => string, muted: (t: string) => string): Row[] {
	const tick = theme.fg("success", "✓");
	const warn = theme.fg("warning", "⚠");
	// "claimed src/x — why." (the first in a context goes on: " Peers editing there …") /
	// "claimed @cargo — why: yours until …" / "renewed @cargo: yours for …" /
	// "queued for @cargo, held by bravo …. Not yours yet. …": what was claimed ends at the first of these.
	const made = /^(claimed|renewed|queued for) (.*?)(?= — |: yours|, held by|, free, but|; ahead of you|\.(?: |$))/.exec(line);
	if (made) {
		const [, verb = "", what = ""] = made;
		const rows: Row[] = [{ text: `${verb === "queued for" ? theme.fg("accent", "◷") : tick} ${say(`${verb} ${what}`)}` }];
		// A lane overlap is news for the human too.
		const [, note] = splitOnce(line, " Note: ");
		if (note !== undefined) rows.push({ text: `${warn} ${theme.fg("warning", note.replace(/ Your checkouts are separate.*$/, ""))}` });
		rows.push({ text: muted(line), quiet: true });
		return rows;
	}
	if (/^Not claimed: /.test(line) || /another agent took/.test(line)) return [{ text: `${warn} ${muted(line)}` }];
	return [{ text: muted(line), quiet: true }];
}

/** A successful result, for the human: what happened first, the model's guidance quieter below. */
function resultLines(
	action: string | undefined,
	text: string,
	details: Record<string, unknown>,
	names: readonly string[],
	theme: Theme,
): Row[] {
	const tick = theme.fg("success", "✓");
	const say = (t: string) => paintCallsigns(theme, t, names);
	const muted = (t: string) => dimCalls(theme, t, (s) => paintCallsigns(theme, s, names, (x) => theme.fg("muted", x)));
	const quiet = (lines: readonly string[]): Row[] => lines.filter((l) => l.trim()).map((l) => ({ text: muted(l), quiet: true }));
	const [first = "", ...rest] = text.split("\n");
	switch (action) {
		case "board":
		case "log":
			return styleBoard(theme, text, [...names, ...boardCallsigns(text)], { title: true })
				.split("\n")
				.map((l) => ({ text: l }));
		case "send": {
			// "sent to bravo (idle — this wakes them)": the delivery, then what it means.
			// The hint itself may hold a call (`telecom({ … })`), so it runs to the last parenthesis.
			const hint = /^(.*?) \((.*)\)$/.exec(first);
			const head = hint ? `${tick} ${say(hint[1] ?? "")}${theme.fg("muted", ` · ${hint[2]}`)}` : `${tick} ${say(first)}`;
			return [{ text: head }, ...quiet(rest)];
		}
		case "ask": {
			if (details.interrupted === true) {
				const [why = "", ...more] = text.split("\n\n");
				return [
					{ text: `${theme.fg("warning", "⚠")} ${theme.fg("warning", why)}` },
					...more
						.join("\n\n")
						.split("\n")
						.map((l) => (isHint(l) ? { text: theme.fg("dim", l), quiet: true } : { text: say(l) })),
				];
			}
			// "asked bravo (…) — ask-…": what happened, then the model's guidance, quieter.
			if (details.async === true) {
				const [what, handle] = splitOnce(first, " — handle ");
				return [{ text: `${tick} ${say(what)}${handle ? theme.fg("dim", ` · ${handle}`) : ""}` }, ...quiet(rest)];
			}
			// "alpha answered:\n\n<the answer>": the answer is what the human wants to read, and
			// the peer wrote it as Markdown.
			const answer = rest.join("\n").replace(/^\n+/, "").split("\n");
			const prose = proseStyler(theme, names);
			return [{ text: `${tick} ${say(first.replace(/:$/, ""))}` }, ...answer.map((l) => (isHint(l) ? { text: theme.fg("dim", l), quiet: true } : { text: prose(l) }))];
		}
		case "claim":
			return text.split("\n").flatMap((l) => claimRow(l, theme, say, muted));
		case "release":
		case "broadcast": {
			// "released src/x — told bravo, …" / "broadcast to bravo — about …": the act, then detail.
			const [head, detail] = splitOnce(first, " — ");
			const [reached, failed] = splitOnce(head, FAILED_MARK);
			const shown = failed === undefined ? say(head) : `${say(reached)}${theme.fg("error", head.slice(reached.length))}`;
			return [{ text: `${tick} ${shown}${detail === undefined ? "" : theme.fg("muted", ` · ${detail}`)}` }, ...quiet(rest)];
		}
		case "status": {
			// "status set · waiting for bravo. You are woken …": the task itself is in the call above
			// (a task past the cap is shown as peers see it, "status set — peers see: …").
			const [head, waits] = splitOnce(first, " · ");
			const [task] = splitOnce(head, " — ");
			const waitShort = waits?.replace(/\. You are woken.*$/, "");
			return [
				{ text: `${tick} ${say(task)}${waitShort ? theme.fg("warning", ` · ${waitShort}`) : ""}` },
				...(waits && waitShort !== waits ? [{ text: muted(waits), quiet: true }] : []),
				// "bravo waits for you", "This closes a wait cycle": news for the human as well.
				...rest.map((l) => (/waits? for you|wait cycle/.test(l) ? { text: `${theme.fg("warning", "⚠")} ${muted(l)}` } : { text: muted(l), quiet: true })),
			];
		}
		default:
			return [{ text: `${tick} ${say(first)}` }, ...quiet(rest)];
	}
}
