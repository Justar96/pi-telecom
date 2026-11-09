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

/** A message body folds after this many lines until expanded. */
const FOLD_LINES = 8;
/** A change notice's excerpt line: deep indent, then the diff sign. */
const DIFF_LINE = /^(\s{4,})([-+])/;
/** Horizontal padding inside a panel when the host gives none (pi's own default). */
const DEFAULT_PAD = 1;
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
	/** Source lines kept to one row, cut with "…" instead of wrapped: previews. */
	private readonly clipped: ReadonlySet<number>;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string, clipped: ReadonlySet<number> = new Set()) {
		this.text = text;
		this.clipped = clipped;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines: string[] = [];
		for (const [index, line] of this.text.replace(/\t/g, "   ").split("\n").entries()) {
			if (this.clipped.has(index)) {
				lines.push(oneRow(line, width));
				continue;
			}
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
}

/**
 * A block with a coloured left edge and a background across the full width. The tool's call and
 * result are two panels (pi renders them separately) with the same edge, so they read as one
 * block. No blank rows inside: with several agents the transcript is mostly telecom, and every
 * padding row pushed the work itself off the screen.
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
		const { edge = "", bg } = this.opts;
		// A host that passes no padding (omp has no `outputPad`) gets pi's default, not NaN widths.
		const padX = Number.isFinite(this.opts.padX) && this.opts.padX >= 0 ? this.opts.padX : DEFAULT_PAD;
		const edgeWidth = edge ? visibleWidth(edge) : 0;
		const left = edge + " ".repeat(padX);
		const inner = Math.max(1, width - edgeWidth - padX * 2);
		const rows = this.child.render(inner);
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

/** `line` in one row of `width`: cut with "…" when it would wrap. Only the shared wrap helper is
 *  used: pi's and omp's `truncateToWidth` take different ellipsis arguments. */
export function oneRow(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	const head = wrapTextWithAnsi(line, Math.max(1, width - 1))[0] ?? "";
	return `${head.replace(/\s+$/, "")}\x1b[0m…`;
}

/**
 * The panel every telecom message and call is drawn in: a coloured edge on the message
 * background, no blank rows of its own (the transcript spaces blocks already). `clipped`: body
 * lines (by index) kept to one row.
 */
export function telecomPanel(
	theme: Theme,
	body: string,
	edgeColor: ThemeColor,
	padX: number | undefined,
	clipped: ReadonlySet<number> = new Set(),
): Panel {
	return new Panel(new HangingText(body, clipped), {
		edge: theme.fg(edgeColor, EDGE),
		bg: (line) => theme.bg("customMessageBg", line),
		padX: padX ?? DEFAULT_PAD,
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

/** A message header, as the human reads it: who it is from, to whom, and what kind. */
interface Route {
	from: string;
	/** "you", "team", or the recipients besides you. */
	to: string;
	/** `ask`, `reply`, …; none for a plain message. */
	kind?: string;
	/** Said after the kind, quieter: `about src/db`, `to "the question…"`. */
	note?: string;
	/** Said after the kind in the tone's colour: `blocked until you reply`. */
	flag?: string;
}

/**
 * The header of a peer's message, a reply or a broadcast, read as a route (`bravo → you · ask`),
 * or null for any other header (it is shown as written). Display only: the model reads the
 * content as sent, and an older or newer peer's wording that does not match falls back to it.
 */
export function routeOf(first: string): Route | null {
	const head = /^\*\*📡 (.*?)\*\*(.*)$/.exec(first.trim());
	if (!head) return null;
	const [, strong = "", after = ""] = head;
	const human = (t: string) => / \(from their human\)/.test(t);
	const who = (t: string) => `${t.replace(/ \(from their human\).*$/, "")}${human(t) ? "'s human" : ""}`;
	let m = /^Message from (\S+(?: \(from their human\))?)(?: — also to (.+))?$/.exec(strong);
	if (m) return { from: who(m[1] ?? ""), to: m[2] ? `you, ${m[2]}` : "you" };
	m = /^Ask from (\S+(?: \(from their human\))?)$/.exec(strong);
	if (m) return { from: who(m[1] ?? ""), to: "you", kind: "ask", ...(/blocked until you reply/.test(after) ? { flag: "they wait" } : {}) };
	m = /^(Late reply|Reply) from (\S+(?: \(from their human\))?)$/.exec(strong);
	if (m) {
		const about = /^ to your ask (".*")$/.exec(after);
		return { from: who(m[2] ?? ""), to: "you", kind: m[1] === "Late reply" ? "late reply" : "reply", ...(about?.[1] ? { note: `to ${about[1]}` } : {}) };
	}
	m = /^Broadcast from (\S+(?: \(from their human\))?)(?: — about (.+))?$/.exec(strong);
	if (m) return { from: who(m[1] ?? ""), to: "team", ...(m[2] ? { note: `about ${m[2]}` } : {}) };
	return null;
}

function styleRoute(paint: Paint, route: Route, color: ThemeColor, callsigns: readonly string[]): string {
	const muted = (t: string) => paintCallsigns(paint, t, callsigns, (x) => paint.fg("muted", x));
	const from = /^[a-z0-9][a-z0-9_-]*/.exec(route.from)?.[0] ?? route.from;
	const sender = `${callsignText(paint, from)}${muted(route.from.slice(from.length))}`;
	let out = `📡 ${sender} ${muted(`→ ${route.to}`)}`;
	if (route.kind) out += `${paint.fg("muted", " · ")}${paint.bold(paint.fg(color, route.kind))}`;
	if (route.flag) out += `${paint.fg("muted", " · ")}${paint.fg(color, route.flag)}`;
	if (route.note) out += muted(` · ${route.note}`);
	return out;
}

/** A brief's first line, shortened: `📡 team` (the first brief) or `📡 team update`. */
function briefTitle(paint: Paint, first: string): string | null {
	if (/^📡 Telecom — team update\b/.test(first)) return `📡 ${paint.bold(paint.fg("customMessageLabel", "team update"))}`;
	if (/^📡 Telecom — /.test(first)) return `📡 ${paint.bold(paint.fg("customMessageLabel", "team"))}`;
	return null;
}

export function registerRenderers(pi: ExtensionAPI): void {
	for (const customType of Object.values(MESSAGE_TYPES)) {
		pi.registerMessageRenderer<TelecomMessageDetails>(customType, (message, options, theme) => {
			// omp passes no `outputPad`: the panel then takes pi's default.
			const { expanded } = options;
			const outputPad = (options as { outputPad?: number }).outputPad;
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
			// The edge takes the sender's colour, so one agent's messages read as one thread; news
			// with no single sender (a brief, an expiry) takes the tone's.
			const edge = details.fromCallsign ? agentColor(details.fromCallsign) : details.tone ? tone : "borderMuted";
			// A folded brief is one row: what changed, after its title.
			if (customType === MESSAGE_TYPES.brief && !expanded) {
				const title = briefTitle(theme, first) ?? styleHeader(theme, first, tone, callsigns);
				const summary = details.summary ? `${theme.fg("muted", " · ")}${paintCallsigns(theme, details.summary, callsigns, (t) => theme.fg("muted", t))}` : "";
				return telecomPanel(theme, `${title}${summary}`, edge, outputPad, new Set([0]));
			}
			const route = routeOf(first);
			const header = route
				? styleRoute(theme, route, tone, callsigns)
				: customType === MESSAGE_TYPES.brief
					? (briefTitle(theme, first) ?? styleHeader(theme, first, tone, callsigns))
					: styleHeader(theme, first, tone, callsigns);
			let lines = rest.join("\n").replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
			// Folded, the lines written for the model (how to reply, notes in parentheses) are left
			// out, and blank rows close up: the human reads the message itself.
			if (!expanded) lines = lines.filter((l) => !isHint(l)).filter((l, i, all) => l.trim() !== "" || (i > 0 && all[i - 1]?.trim() !== ""));
			while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
			const shown = !expanded && lines.length > FOLD_LINES ? lines.slice(0, FOLD_LINES) : lines;
			const body = styleBody(theme, customType, shown, callsigns);
			if (shown.length < lines.length) body.push(moreLines(theme, lines.length - shown.length));
			const text = body.some((l) => l.trim()) ? `${header}\n${body.join("\n")}` : header;
			return telecomPanel(theme, text, edge, outputPad);
		});
	}
}
