/**
 * view — the team at a glance, for the human: the footer status, the live widget above the
 * editor, and the `/telecom` panels (the board, and the list of commands). Nothing here reaches
 * the model; the board text the model reads is `board.ts`, and the panel only restyles it.
 *
 * In the TUI these draw with the theme, in each agent's colour (`render.ts`). RPC and print modes
 * get the same facts as plain text: their clients show strings, not terminal colours.
 */
import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { UNRESPONSIVE_MS } from "./awareness.ts";
import { type BoardScope, familyOrder, liveClaims } from "./board.ts";
import { sameRepo } from "./project.ts";
import {
	boardCallsigns,
	callsignText,
	HangingText,
	type Paint,
	paintCallsigns,
	plainText,
	type StateKind,
	stateMark,
	styleBoard,
} from "./render.ts";
import type { Presence } from "./transport.ts";
import { plural } from "./util.ts";

/** The widget lists at most this many agents; `/telecom` shows everyone. */
const WIDGET_AGENTS = 8;
/** …and at most this many unanswered asks. */
const WIDGET_ASKS = 3;
/** Callsign column width cap, so one long name cannot squeeze every task. */
const NAME_CAP = 16;
/** Below this width the widget drops its right-hand column (claims, lanes). */
const NARROW = 60;
/** Rows the board panel keeps for its frame (rules, title, hints) and for the chat above it. */
const PANEL_CHROME_ROWS = 12;

// ------------------------------------------------------------------ the commands

export interface CommandSpec {
	name: string;
	/** Its arguments as the help shows them; a command with any takes the rest of the line. */
	args?: string;
	about: string;
}

/** Every `/telecom` subcommand: the help text, the completions and the command list come from here. */
export const COMMANDS: readonly CommandSpec[] = [
	{ name: "board", about: "team board for this repository (also plain /telecom)" },
	{ name: "all", about: "every agent on this machine" },
	{ name: "run", args: "<prompt>", about: "start work in every session in this repository, this one too" },
	{ name: "msg", args: "<agent> <text>", about: "message an agent as its human (wakes it when idle)" },
	{ name: "broadcast", args: "<text>", about: "tell every agent in this repository" },
	{ name: "widget", about: "show or hide the live team above the editor" },
	{ name: "release", about: "drop every claim this agent holds" },
	{ name: "name", args: "<callsign>", about: "rename this agent" },
	{ name: "off", about: "disconnect this session and release its claims" },
	{ name: "on", about: "reconnect this session" },
	{ name: "help", about: "this list" },
];

/** A command with its arguments: `msg <agent> <text>`. */
export function usage(command: CommandSpec): string {
	return command.args ? `${command.name} ${command.args}` : command.name;
}

/** The help as plain text: aligned columns, one command per line. */
export function helpText(): string {
	const usages = COMMANDS.map((c) => `/telecom ${usage(c)}`);
	const width = Math.max(...usages.map((u) => u.length)) + 2;
	return ["📡 telecom commands", ...COMMANDS.map((c, i) => `${(usages[i] ?? "").padEnd(width)}${c.about}`)].join("\n");
}

// ------------------------------------------------------------------ the footer

export interface StatusInput {
	callsign: string;
	peers: number;
	busy: number;
	subagents: number;
	claims: number;
	asks: number;
}

/** `📡 alpha · 2 peers (1 busy) · 1 claim · 1 ask waiting`; the words are the same with or without colour. */
export function statusText(s: StatusInput, paint: Paint): string {
	const sep = paint.fg("dim", " · ");
	const parts = [`📡 ${callsignText(paint, s.callsign)}`];
	let who: string;
	if (s.peers === 0) who = paint.fg("dim", "solo");
	else who = paint.fg("muted", plural(s.peers, "peer")) + (s.busy > 0 ? paint.fg("success", ` (${s.busy} busy)`) : "");
	if (s.subagents > 0) who += paint.fg("muted", ` + ${plural(s.subagents, "subagent")}`);
	parts.push(who);
	if (s.claims > 0) parts.push(paint.fg("muted", plural(s.claims, "claim")));
	if (s.asks > 0) parts.push(paint.bold(paint.fg("warning", `${plural(s.asks, "ask")} waiting`)));
	return parts.join(sep);
}

/** The footer while telecom is off in this session. */
export function offStatus(paint: Paint, why?: string): string {
	return paint.fg("dim", `📡 off${why ? ` (${why})` : ""}`);
}

// ------------------------------------------------------------------ the live widget

export interface TeamSnapshot {
	self: Presence;
	peers: readonly Presence[];
	asks: ReadonlyArray<{ id: string; fromCallsign: string; text: string }>;
	now: number;
}

/** An agent's state, as the widget colours it. */
function stateOf(peer: Presence, self: Presence, now: number): StateKind {
	if (peer.id !== self.id && now - peer.heartbeatAt > UNRESPONSIVE_MS) return "away";
	if (peer.state === "busy" && peer.waitingOn?.length) return "waiting";
	return peer.state;
}

/** Pad `text` (which may carry colour) to `width` visible columns. */
function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * The widget: a rule, then one row per agent (this one first, each subagent under its parent)
 * with its state, task, and on the right its claims or the checkout it works in, then the asks
 * waiting on this agent. Every row fits `width`.
 */
export function widgetLines(snap: TeamSnapshot, paint: Paint, width: number): string[] {
	const { self, now } = snap;
	const team = snap.peers.filter((p) => p.id !== self.id && sameRepo(p, self));
	const rows = familyOrder([self, ...team]);
	const ids = new Set(rows.map((p) => p.id));
	const depthOf = (p: Presence): number => (p.parent && ids.has(p.parent) ? 1 : 0);
	const shown = rows.slice(0, WIDGET_AGENTS);
	const nameWidth = Math.min(NAME_CAP, Math.max(...shown.map((p) => p.callsign.length + depthOf(p) * 2)));
	const wide = width >= NARROW;
	const lines: string[] = [];

	const title = ` ${paint.fg("accent", "📡")} ${paint.bold(plainText(paint, "telecom"))} `;
	const counts = team.length === 0 ? "no one else here yet" : `${plural(team.length, "other agent")}`;
	const right = ` ${paint.fg("dim", counts)} `;
	const rule = Math.max(0, width - visibleWidth(title) - visibleWidth(right) - 2);
	lines.push(truncateToWidth(`${paint.fg("borderMuted", "──")}${title}${paint.fg("borderMuted", "─".repeat(rule))}${right}`, width));

	for (const p of shown) {
		const kind = stateOf(p, self, now);
		const mark = stateMark(paint, kind, kind === "waiting" ? "wait" : kind);
		const depth = depthOf(p);
		const name = pad(`${depth ? paint.fg("dim", "└ ") : ""}${callsignText(paint, truncateToWidth(p.callsign, nameWidth - depth * 2, "…"))}`, nameWidth);
		const extras: string[] = [];
		if (p.id === self.id) extras.push(paint.fg("accent", "you"));
		const claims = liveClaims(p, now);
		if (claims.length > 0) extras.push(paint.fg("muted", `claims ${claims[0]?.pattern}${claims.length > 1 ? ` +${claims.length - 1}` : ""}`));
		// Another checkout: named by its directory, which is how worktrees are usually told apart.
		if (p.projectRoot !== self.projectRoot) extras.push(paint.fg("muted", `in ${basename(p.projectRoot)}`));
		const tail = wide && extras.length > 0 ? extras.join(paint.fg("dim", " · ")) : "";
		const head = ` ${mark.dot} ${name}  ${pad(mark.word, 4)}  `;
		const room = width - visibleWidth(head) - (tail ? visibleWidth(tail) + 2 : 0);
		const task = p.task
			? plainText(paint, truncateToWidth(p.task, Math.max(0, room), "…"))
			: paint.fg("dim", truncateToWidth("no task yet", Math.max(0, room), "…"));
		const line = tail ? `${head}${pad(task, Math.max(0, room))}  ${tail}` : `${head}${task}`;
		lines.push(truncateToWidth(line, width, "…"));
	}
	if (rows.length > shown.length) {
		lines.push(paint.fg("dim", truncateToWidth(`   … ${rows.length - shown.length} more · /telecom shows everyone`, width, "…")));
	}
	for (const ask of snap.asks.slice(0, WIDGET_ASKS)) {
		const head = ` ${paint.fg("warning", "?")} ${callsignText(paint, ask.fromCallsign)} ${paint.fg("warning", "asks")}  `;
		const room = Math.max(0, width - visibleWidth(head));
		lines.push(`${head}${plainText(paint, truncateToWidth(ask.text.replace(/\s+/g, " "), room, "…"))}`);
	}
	if (snap.asks.length > WIDGET_ASKS) {
		lines.push(paint.fg("dim", truncateToWidth(`   … ${snap.asks.length - WIDGET_ASKS} more asks waiting`, width, "…")));
	}
	return lines;
}

/** The widget as a component: it redraws from `source` when told something changed. */
export class TeamWidget implements Component {
	private readonly theme: Theme;
	private readonly source: () => TeamSnapshot | null;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(theme: Theme, source: () => TeamSnapshot | null) {
		this.theme = theme;
		this.source = source;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const snap = this.source();
		const lines = snap ? widgetLines(snap, this.theme, width) : [];
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

// ------------------------------------------------------------------ the /telecom panels

function rule(paint: Paint, width: number): string {
	return paint.fg("borderAccent", "─".repeat(Math.max(1, width)));
}

/**
 * A hint row: keys on the left, `aside` on the right. Asides are in order of importance; the
 * last ones are dropped until the row fits.
 */
function hintRow(paint: Paint, keys: string, aside: readonly string[], width: number): string {
	const left = ` ${paint.fg("dim", keys)}`;
	for (let n = aside.length; n >= 0; n--) {
		const parts = aside.slice(0, n).filter(Boolean);
		const right = parts.length > 0 ? `${paint.fg("dim", parts.join(" · "))} ` : "";
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap >= 2) return `${left}${" ".repeat(gap)}${right}`;
	}
	return truncateToWidth(left, width, "…");
}

export interface BoardPanelOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	scope: BoardScope;
	/** The board text for a scope: what the model's `board` action returns. */
	board: (scope: BoardScope) => string;
	/** Diagnostics for the hint row (guard mode, last heartbeat). */
	aside: () => string;
	/** Turn the widget on or off; returns whether it is on now. */
	toggleWidget: () => boolean;
	done: () => void;
}

/**
 * `/telecom`: the board in a panel where the editor was, styled, scrollable when it is taller than
 * the terminal, and live (`refresh()` on every team refresh). Tab switches between this repository
 * and the whole machine, `w` toggles the widget, escape or enter closes.
 */
export class BoardPanel implements Component {
	private readonly opts: BoardPanelOptions;
	private scope: BoardScope;
	private text = "";
	private offset = 0;
	private note = "";
	private cache: { width: number; lines: string[] } | undefined;

	constructor(opts: BoardPanelOptions) {
		this.opts = opts;
		this.scope = opts.scope;
		this.refresh();
	}

	/** Re-read the board: the team changed, or a second passed. */
	refresh(): void {
		this.text = this.opts.board(this.scope);
		this.cache = undefined;
	}

	handleInput(data: string): void {
		const { keybindings, tui } = this.opts;
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm") || data === "q") {
			this.opts.done();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.scope = this.scope === "project" ? "machine" : "project";
			this.offset = 0;
			this.note = "";
			this.refresh();
		} else if (data === "w") {
			this.note = this.opts.toggleWidget() ? "widget on" : "widget off";
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.offset++;
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.offset = Math.max(0, this.offset - 10);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.offset += 10;
		} else {
			return;
		}
		this.cache = undefined;
		tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { theme } = this.opts;
		const [first = "", ...rest] = this.text.split("\n");
		const callsigns = boardCallsigns(this.text);
		const tab = (scope: BoardScope, label: string) =>
			scope === this.scope ? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `))) : theme.fg("muted", ` ${label} `);
		const title = ` ${theme.fg("accent", "📡")} ${theme.bold(plainText(theme, "Telecom"))}   ${tab("project", "this repository")} ${tab("machine", "this machine")}`;
		const indented = (text: string) => new HangingText(text).render(Math.max(1, width - 2)).map((line) => ` ${line}`);
		const subtitle = indented(paintCallsigns(theme, first.replace(/^📡 /, ""), callsigns, (t) => theme.fg("muted", t)));
		const body = indented(styleBoard(theme, rest.join("\n").replace(/^\n+/, ""), callsigns, { spacious: true }));
		const room = Math.max(4, this.opts.tui.terminal.rows - PANEL_CHROME_ROWS);
		const scrolls = body.length > room;
		this.offset = Math.min(this.offset, Math.max(0, body.length - room));
		const visible = scrolls ? body.slice(this.offset, this.offset + room) : body;
		const keys = ["tab switch view", "w widget", ...(scrolls ? ["↑↓ scroll"] : []), "esc close"].join(" · ");
		const position = scrolls ? `${this.offset + 1}–${this.offset + visible.length} of ${body.length}` : "";
		const aside = [this.note, position, this.opts.aside()];
		const lines = [
			rule(theme, width),
			truncateToWidth(title, width, "…"),
			...subtitle,
			"",
			...visible,
			"",
			hintRow(theme, keys, aside, width),
			rule(theme, width),
		].map((line) => truncateToWidth(line, width, "…"));
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export interface CommandListOptions {
	theme: Theme;
	tui: TUI;
	/** Who this is, for the title: `alpha · 2 peers`, or `off`. */
	status: string;
	done: (command: CommandSpec | undefined) => void;
}

/** `/telecom help`: every command with what it does; enter runs it, or starts typing its arguments. */
export class CommandList implements Component {
	private readonly opts: CommandListOptions;
	private readonly list: SelectList;

	constructor(opts: CommandListOptions) {
		this.opts = opts;
		const { theme } = opts;
		const items: SelectItem[] = COMMANDS.map((c) => ({ value: c.name, label: usage(c), description: c.about }));
		this.list = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.bold(theme.fg("accent", t)),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		}, { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 26 });
		this.list.onSelect = (item) => opts.done(COMMANDS.find((c) => c.name === item.value));
		this.list.onCancel = () => opts.done(undefined);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.opts.tui.requestRender();
	}

	render(width: number): string[] {
		const { theme } = this.opts;
		const title = ` ${theme.fg("accent", "📡")} ${theme.bold(plainText(theme, "Telecom commands"))}`;
		const status = `${this.opts.status} `;
		const gap = width - visibleWidth(title) - visibleWidth(status);
		return [
			rule(theme, width),
			gap >= 2 ? `${title}${" ".repeat(gap)}${status}` : truncateToWidth(title, width, "…"),
			"",
			...this.list.render(width),
			"",
			hintRow(theme, "↑↓ move · enter run · esc close", ["commands with arguments open in the editor"], width),
			rule(theme, width),
		].map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
