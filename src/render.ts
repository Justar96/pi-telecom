/**
 * render — how telecom looks in the interactive transcript, and the drawing pieces the tool, the
 * widget and the `/telecom` panel share.
 *
 * The model reads each message's `content` verbatim; nothing here changes it. These renderers only
 * change what the human sees:
 *
 * - Every telecom panel (a peer's message, or this agent's own `telecom` call) is one block on the
 *   custom-message background with a coloured edge, so coordination reads as one thread, apart
 *   from file edits and shell output.
 * - Each agent keeps one colour on every screen (`agentColor`): the edge of its messages, its
 *   callsign on the board, in the widget and in the footer. A subagent takes its parent's colour.
 * - Instructions written for the model (`telecom({ … })` calls, "(Reply only if …)") are dimmed,
 *   so the human reads the message itself first.
 * - Long bodies fold until the message is expanded, the team brief folds to one line, wrapped
 *   lines hang under their bullet, and a change notice's excerpt is coloured like pi's own diffs.
 */
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { NATO } from "./callsign.ts";
import { escapeRegExp } from "./util.ts";

export const MESSAGE_TYPES = {
	message: "telecom-message",
	broadcast: "telecom-broadcast",
	ask: "telecom-ask",
	reply: "telecom-reply",
	change: "telecom-change",
	claim: "telecom-claim",
	brief: "telecom-brief",
	reminder: "telecom-reminder",
} as const;

export interface TelecomMessageDetails {
	/** The one-line form shown when the message is folded. */
	summary?: string;
	from?: string;
	fromCallsign?: string;
	tone?: "info" | "warning" | "accent";
	/** Callsigns the message names, painted in their colours (display only; the model never sees it). */
	callsigns?: string[];
}

/** The two theme calls everything here needs; the tests' fake theme and pi's real one both have them. */
export type Paint = Pick<Theme, "fg" | "bold">;

/** Plain text: for RPC and print modes, whose clients get no terminal colours. */
export const PLAIN: Paint = { fg: (_color, text) => text, bold: (text) => text };

const FOLD_LINES = 12;
/** A change notice's excerpt line: deep indent, then the diff sign. */
const DIFF_LINE = /^(\s{4,})([-+])/;
/** The left edge of every telecom panel. */
const EDGE = "▎";

/**
 * Colours a callsign can take: distinct from one another and from the state colours (success,
 * warning, error), in pi's own themes and in most others. Theme tokens, so a theme change recolours.
 */
const AGENT_COLORS: readonly ThemeColor[] = ["accent", "syntaxKeyword", "syntaxVariable", "syntaxString"];

/**
 * An agent's colour, the same in every session: NATO callsigns take turns through the palette (so
 * alpha, bravo, charlie and delta never share one), any other name is hashed, and a subagent
 * (`alpha-2`) takes its parent's.
 */
export function agentColor(callsign: string): ThemeColor {
	const stem = callsign.replace(/-\d+$/, "");
	const nato = (NATO as readonly string[]).indexOf(stem);
	let index = nato;
	if (index < 0) {
		index = 0;
		for (const ch of stem) index = (index * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	}
	return AGENT_COLORS[index % AGENT_COLORS.length] as ThemeColor;
}

/** A callsign as every telecom surface shows it: bold, in its colour. */
export function callsignText(paint: Paint, callsign: string): string {
	return paint.bold(paint.fg(agentColor(callsign), callsign));
}

/**
 * Body text in the theme's text colour. Explicit, like pi's own text: the terminal's default
 * colour may not suit the theme (a light theme in a dark terminal). Colour codes do not nest, so
 * every run of plain text is coloured on its own, never a whole line around coloured parts.
 */
export function plainText(paint: Paint, text: string): string {
	return text ? paint.fg("text", text) : "";
}

/**
 * `text` with every whole-word mention of a callsign painted in its colour and the rest passed
 * through `base` (the text colour by default). Very short callsigns are skipped: painting every
 * "a" or "ok" would be noise.
 */
export function paintCallsigns(
	paint: Paint,
	text: string,
	callsigns: Iterable<string>,
	base: (text: string) => string = (t) => plainText(paint, t),
): string {
	const names = [...new Set(callsigns)].filter((c) => c.length >= 3).sort((a, b) => b.length - a.length);
	if (names.length === 0) return text ? base(text) : "";
	const pattern = new RegExp(`(?<![\\w-])(${names.map(escapeRegExp).join("|")})(?![\\w-])`, "g");
	return restyle(text, pattern, (name) => callsignText(paint, name), base);
}

/** `telecom({ … })` calls inside a sentence: model instructions, dimmed so the sentence reads first. */
const TOOL_CALL = /telecom\(\{.*?\}\)/g;

/** `text` with its `telecom({ … })` calls in `dim` and the rest through `base`. */
export function dimCalls(paint: Paint, text: string, base: (text: string) => string = (t) => plainText(paint, t)): string {
	return restyle(text, TOOL_CALL, (call) => paint.fg("dim", call), base);
}

/** `text` with each match of the global `pattern` through `onMatch`, and the runs between through `base`. */
function restyle(text: string, pattern: RegExp, onMatch: (match: string) => string, base: (text: string) => string): string {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const at = match.index ?? 0;
		if (at > last) out += base(text.slice(last, at));
		out += onMatch(match[0]);
		last = at + match[0].length;
	}
	if (last < text.length) out += base(text.slice(last));
	return out;
}

/**
 * Text that wraps each line on its own and indents the continuation: under the text after a
 * leading bullet ("• ", "- ", "● "), otherwise under the line's own indent. pi-tui's `Text` would
 * restart wrapped lines at column 0, which breaks indented lists in narrow terminals.
 */
export class HangingText implements Component {
	private readonly text: string;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines: string[] = [];
		for (const line of this.text.replace(/\t/g, "   ").split("\n")) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			const hang = Math.min(/^\s*(?:[•\-*●○◌✓✗⚠?] )?/.exec(plain)?.[0].length ?? 0, Math.floor(width / 2));
			const [first = "", ...rest] = wrapTextWithAnsi(line, Math.max(1, width));
			lines.push(first);
			if (rest.length === 0) continue;
			// Re-wrap the remainder at the narrower width so nothing overflows once indented.
			const remainder = rest.map((part) => part.trimStart()).join(" ");
			for (const part of wrapTextWithAnsi(remainder, Math.max(1, width - hang))) lines.push(" ".repeat(hang) + part);
		}
		const bounded = lines.map((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, width)[0] ?? "" : line));
		this.cache = { width, lines: bounded };
		return bounded;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

interface PanelOptions {
	/** The edge, already coloured; none for a plain block. */
	edge?: string;
	/** Applied to each full-width line: the panel's background. */
	bg?: (line: string) => string;
	/** Columns between the edge and the text, and after the text. */
	padX: number;
	/** A blank row above the content (the top of the panel). */
	top?: boolean;
	/** A blank row below the content (the bottom of the panel). */
	bottom?: boolean;
}

/**
 * A block with a coloured left edge and a background across the full width. The tool's call and
 * result are two panels (pi renders them separately), so the call draws the top row and the
 * result the bottom one, and together they read as one block.
 */
export class Panel implements Component {
	private readonly child: Component;
	private readonly opts: PanelOptions;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(child: Component, opts: PanelOptions) {
		this.child = child;
		this.opts = opts;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { edge = "", bg, padX, top = false, bottom = false } = this.opts;
		const edgeWidth = edge ? visibleWidth(edge) : 0;
		const left = edge + " ".repeat(padX);
		const inner = Math.max(1, width - edgeWidth - padX * 2);
		const rows = [...(top ? [""] : []), ...this.child.render(inner), ...(bottom ? [""] : [])];
		const lines = rows.map((row) => {
			const fill = Math.max(0, width - edgeWidth - padX - visibleWidth(row));
			const line = left + row + " ".repeat(fill);
			return bg ? bg(line) : line;
		});
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.child.invalidate?.();
	}
}

/** The panel every telecom message and call is drawn in. */
export function telecomPanel(theme: Theme, body: string, edgeColor: ThemeColor, padX: number, rows: { top: boolean; bottom: boolean }): Panel {
	return new Panel(new HangingText(body), {
		edge: theme.fg(edgeColor, EDGE),
		bg: (line) => theme.bg("customMessageBg", line),
		padX,
		...rows,
	});
}

/** "… 14 more lines · expand to read", the same wherever telecom folds something. */
export function moreLines(paint: Paint, count: number): string {
	return paint.fg("dim", `… ${count} more ${count === 1 ? "line" : "lines"} · expand to read`);
}

// ------------------------------------------------------------------ the board, as the human sees it

/** A board line's agent: `• bravo "name" (role) [state, …] rest`. */
const PEER_LINE = /^(\s*)• (?:(joined|now working near you|carries on after \S+ left): )?([a-z0-9][a-z0-9_-]*)((?: "[^"]*")?(?: \([^)]*\))?) \[([^\]]+)\](.*)$/;
/** A detail line under an agent: `    task: …`. */
const DETAIL_LINE = /^(\s+)(task|claims|recently changed|subagents|subagent claims): (.*)$/;
/** An unanswered ask on the board: `  ask-… from bravo: text`. */
const ASK_LINE = /^(\s+)(ask-\S+) from (\S+): (.*)$/;

/** An agent's state as the board and the widget colour it. */
export type StateKind = "away" | "waiting" | "busy" | "idle";

const STATE_LOOK: Record<StateKind, { color: ThemeColor; dot: string }> = {
	away: { color: "warning", dot: "◌" },
	waiting: { color: "warning", dot: "●" },
	busy: { color: "success", dot: "●" },
	idle: { color: "muted", dot: "○" },
};

/** The kind of a board line's state text: `unresponsive since …`, `busy, waiting on bravo`, `idle`. */
function stateKind(state: string): StateKind {
	if (/^unresponsive/.test(state)) return "away";
	if (/waiting on/.test(state)) return "waiting";
	return state.startsWith("busy") ? "busy" : "idle";
}

/** The dot a state shows as, and `word` in its colour. */
export function stateMark(paint: Paint, kind: StateKind, word: string): { dot: string; word: string } {
	const look = STATE_LOOK[kind];
	return { dot: paint.fg(look.color, look.dot), word: paint.fg(look.color, word) };
}

/** An unanswered ask (an `ASK_LINE` match): `? bravo ask-…  the question`. */
function styleAsk(paint: Paint, ask: RegExpExecArray): string {
	const [, indent = "", id = "", from = "", question = ""] = ask;
	return `${indent}${paint.fg("warning", "?")} ${callsignText(paint, from)} ${paint.fg("dim", id)}  ${plainText(paint, question)}`;
}

function styleBoardLine(paint: Paint, line: string, callsigns: readonly string[], title: boolean): string {
	const text = (t: string) => paintCallsigns(paint, t, callsigns);
	const muted = (t: string) => paintCallsigns(paint, t, callsigns, (s) => paint.fg("muted", s));
	const peer = PEER_LINE.exec(line);
	if (peer) {
		const [, indent = "", event, callsign = "", label = "", state = "", rest = ""] = peer;
		const mark = stateMark(paint, stateKind(state), state);
		const id = /^(.*?)(\s+id \S+)$/.exec(rest);
		let where = id ? (id[1] ?? "") : rest;
		const you = where.endsWith(" — you");
		if (you) where = where.slice(0, -" — you".length);
		const tail = `${muted(where)}${you ? paint.fg("accent", " · you") : ""}${id ? paint.fg("dim", id[2] ?? "") : ""}`;
		return `${indent}${mark.dot} ${event ? paint.fg("muted", `${event}: `) : ""}${callsignText(paint, callsign)}${paint.fg("muted", label)} ${mark.word}${tail}`;
	}
	const detail = DETAIL_LINE.exec(line);
	if (detail) {
		const [, indent = "", label = "", value = ""] = detail;
		const shown = label === "recently changed" ? muted(value) : text(value);
		return `${indent}${paint.fg("dim", `${label}:`)} ${shown}`;
	}
	const ask = ASK_LINE.exec(line);
	if (ask) return styleAsk(paint, ask);
	if (/^Unanswered asks/.test(line)) {
		const cut = line.indexOf(" (");
		return cut < 0 ? paint.bold(paint.fg("warning", line)) : `${paint.bold(paint.fg("warning", line.slice(0, cut)))}${paint.fg("muted", line.slice(cut))}`;
	}
	if (/^(?:\(|… and )/.test(line)) return paint.fg("dim", line);
	if (/^• /.test(line)) return `${paint.fg("muted", "•")} ${text(line.slice(2))}`;
	if (title) return paint.bold(text(line.replace(/^📡 /, "")));
	return dimCalls(paint, line, text);
}

/**
 * The board (or a brief's body) with colour: a state dot per agent, callsigns in their colours,
 * detail labels quiet, unanswered asks in the warning colour. A board's first line is its title;
 * `spacious` puts a blank row between agents.
 */
export function styleBoard(
	paint: Paint,
	text: string,
	callsigns: readonly string[],
	opts: { spacious?: boolean; title?: boolean } = {},
): string {
	const out: string[] = [];
	text.split("\n").forEach((line, index) => {
		// A blank row between agents, but a subagent stays with the parent listed just above it.
		const entry = /^• /.test(line) && !/^• \S+(?: "[^"]*")? \((?:your )?subagent\b/.test(line);
		if (opts.spacious && index > 1 && entry && out.at(-1) !== "") out.push("");
		out.push(styleBoardLine(paint, line, callsigns, opts.title === true && index === 0));
	});
	return out.join("\n");
}

/** Every callsign a board or brief text names, from its agent lines. */
export function boardCallsigns(text: string): string[] {
	const found = new Set<string>();
	for (const line of text.split("\n")) {
		const peer = PEER_LINE.exec(line);
		if (peer?.[3]) found.add(peer[3]);
		const you = /You are ([a-z0-9][a-z0-9_-]*)/.exec(line) ?? /you are "([a-z0-9][a-z0-9_-]*)"/.exec(line);
		if (you?.[1]) found.add(you[1]);
		const ask = ASK_LINE.exec(line);
		if (ask?.[3]) found.add(ask[3]);
	}
	return [...found];
}

// ------------------------------------------------------------------ messages from peers

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** A line written for the model, not the human: an instruction or a telecom note in parentheses. */
export function isHint(line: string): boolean {
	return /^\(.*\)\.?$/.test(line.trim()) || /^(?:Reply with|Answer each with|Re-read before|Stay out of their claimed paths)\b/.test(line.trim());
}

function toneColor(tone: TelecomMessageDetails["tone"]): ThemeColor {
	return tone === "warning" ? "warning" : tone === "accent" ? "accent" : "customMessageLabel";
}

/** The header: `**📡 Ask from bravo** — they are blocked`, bold up to the closing `**`. */
function styleHeader(paint: Paint, first: string, color: ThemeColor, callsigns: readonly string[]): string {
	const match = /^\*\*(.*?)\*\*(.*)$/.exec(first);
	const strong = (match ? match[1] : first.replace(/\*\*/g, "")) ?? "";
	const after = match?.[2] ?? "";
	const head = paintCallsigns(paint, strong, callsigns, (t) => paint.bold(paint.fg(color, t)));
	return after ? `${head}${paintCallsigns(paint, after, callsigns, (t) => paint.fg(color, t))}` : head;
}

function styleBody(paint: Paint, customType: string, lines: readonly string[], callsigns: readonly string[]): string[] {
	if (customType === MESSAGE_TYPES.brief) return styleBoard(paint, lines.join("\n"), callsigns).split("\n");
	return lines.map((line) => {
		const diff = DIFF_LINE.exec(line);
		if (customType === MESSAGE_TYPES.change && diff) {
			return diff[1] + paint.fg(diff[2] === "+" ? "toolDiffAdded" : "toolDiffRemoved", line.slice((diff[1] ?? "").length));
		}
		if (isHint(line)) return paint.fg("dim", line);
		// A change notice's file line: `  • path — edited, … · why`.
		const file = customType === MESSAGE_TYPES.change ? /^(\s*• )(.+?)( — .*)$/.exec(line) : null;
		if (file) return `${paint.fg("muted", file[1] ?? "")}${paint.bold(plainText(paint, file[2] ?? ""))}${paint.fg("muted", file[3] ?? "")}`;
		const ask = ASK_LINE.exec(line);
		if (ask) return styleAsk(paint, ask);
		return dimCalls(paint, line, (t) => paintCallsigns(paint, t, callsigns));
	});
}

export function registerRenderers(pi: ExtensionAPI): void {
	for (const customType of Object.values(MESSAGE_TYPES)) {
		pi.registerMessageRenderer<TelecomMessageDetails>(customType, (message, { expanded, outputPad }, theme) => {
			const details = message.details ?? {};
			const raw = textOf(message.content).trim();
			const [first = "", ...rest] = raw.split("\n");
			const callsigns = [
				...(details.fromCallsign ? [details.fromCallsign] : []),
				...(details.callsigns ?? []),
				// Briefs from older runtimes carry no callsigns: find them in the text.
				...(customType === MESSAGE_TYPES.brief && !details.callsigns ? boardCallsigns(raw) : []),
			];
			const tone = toneColor(details.tone);
			const header = styleHeader(theme, first, tone, callsigns);
			let body: string[];
			if (customType === MESSAGE_TYPES.brief && !expanded) {
				body = details.summary ? [paintCallsigns(theme, details.summary, callsigns, (t) => theme.fg("muted", t))] : [];
			} else {
				const lines = rest.join("\n").replace(/^\n+/, "").split("\n");
				const shown = !expanded && lines.length > FOLD_LINES ? lines.slice(0, FOLD_LINES) : lines;
				body = styleBody(theme, customType, shown, callsigns);
				if (shown.length < lines.length) body.push(moreLines(theme, lines.length - shown.length));
			}
			// The edge takes the sender's colour, so one agent's messages read as one thread; news
			// with no single sender (a brief, an expiry) takes the tone's.
			const edge = details.fromCallsign ? agentColor(details.fromCallsign) : details.tone ? tone : "borderMuted";
			const text = body.some((l) => l.trim()) ? `${header}\n${body.join("\n")}` : header;
			return telecomPanel(theme, text, edge, outputPad, { top: true, bottom: true });
		});
	}
}
