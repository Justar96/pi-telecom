/**
 * What the human sees: the panels in the transcript, the footer, the live widget and the
 * `/telecom` panels. None of it reaches the model; these tests pin the look's rules (one colour
 * per agent, model instructions dimmed, rows that fit) and the commands' TUI and RPC paths.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentColor, MESSAGE_TYPES, paintCallsigns, PLAIN, registerRenderers, styleBoard } from "../src/render.ts";
import { COMMANDS, helpText, statusText, widgetLines } from "../src/view.ts";
import { eventually, makeProject, PLAIN_THEME, Session, session, stopSessions } from "./harness.ts";

// Per test: every live session ticks and reads every presence record, so sessions left over
// from earlier tests slow later ones until they time out (Windows file I/O especially).
afterEach(stopSessions);

/** A theme that shows its styling as tags: `<color>text</color>` and `*bold*`. */
const tagged = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `*${text}*`,
};
/** A theme without styling, for measuring widths. */
const plain = PLAIN_THEME;

const now = Date.now();
function presence(id: string, callsign: string, extra: Record<string, unknown> = {}): any {
	return {
		v: 1, id, callsign, pid: 1, ticks: 1, cwd: "/work/p", projectRoot: "/work/p", repo: "/work/p/.git", role: "main",
		state: "idle", claims: [], recent: [], startedAt: now, heartbeatAt: now, waitingOn: [], ...extra,
	};
}

test("render: each agent keeps one colour everywhere, and a subagent takes its parent's", () => {
	const colors = ["alpha", "bravo", "charlie", "delta"].map((c) => agentColor(c));
	assert.equal(new Set(colors).size, 4, "the first four agents never share a colour");
	assert.equal(agentColor("bravo-2"), agentColor("bravo"));
	assert.equal(agentColor("ops"), agentColor("ops"), "a custom callsign is stable too");
});

test("render: callsigns are painted as whole words only", () => {
	const out = paintCallsigns(tagged as any, "alpha told the alphabet to bravo-1 and bravo", ["alpha", "bravo"]);
	assert.match(out, new RegExp(`\\*<${agentColor("alpha")}>alpha</`));
	assert.match(out, /<text> told the alphabet to bravo-1 and <\/text>/, "neither a longer word nor a subagent's name");
	assert.match(out, new RegExp(`\\*<${agentColor("bravo")}>bravo</`));
});

test("render: a peer's message keeps the model's instructions quiet and fits its width", () => {
	const renderers = new Map<string, any>();
	registerRenderers({ registerMessageRenderer: (type: string, fn: unknown) => renderers.set(type, fn) } as any);
	const content = `**📡 Ask from bravo** — they are blocked until you reply\n\nIs the new login() final?\n\nReply with telecom({ action: "reply", askId: "ask-1", message: "<your answer>" }).`;
	const render = (theme: unknown) =>
		renderers.get(MESSAGE_TYPES.ask)({ content, details: { fromCallsign: "bravo", tone: "warning" } }, { expanded: false, outputPad: 1 }, theme);
	// Tags count as visible text, so the tagged render gets room enough not to wrap.
	const text = render(tagged).render(400).join("\n");
	assert.match(text, /<dim>Reply with telecom/, "the instruction is dimmed");
	assert.match(text, /<text>Is the new login\(\) final\?<\/text>/, "the question reads as text");
	assert.match(text, new RegExp(`<${agentColor("bravo")}>▎`), "the edge is the sender's colour");
	for (const line of render(plain).render(60)) assert.equal(visibleWidth(line), 60);
});

test("render: the board shows a dot per state and marks this agent", () => {
	const board = [
		"📡 You are alpha. 2 other agents live in /work/p:",
		"• bravo [busy] on main  id 0000b",
		"    task: tests",
		"• charlie [unresponsive, last seen 9m ago]  id 0000c",
		"",
		"• alpha [idle] on main — you  id 0000a",
	].join("\n");
	const out = styleBoard(tagged as any, board, ["alpha", "bravo", "charlie"], { title: true });
	assert.match(out, /<success>●<\/success> \*<[a-zA-Z]+>bravo</);
	assert.match(out, /<warning>◌<\/warning> \*<[a-zA-Z]+>charlie</);
	assert.match(out, /<accent> · you<\/accent>/);
	assert.match(out, /<dim>task:<\/dim>/);
	assert.doesNotMatch(out, /📡/, "the title drops the mark the panel already shows");
});

test("view: the footer keeps its words, with or without colour", () => {
	assert.equal(
		statusText({ callsign: "alpha", peers: 2, busy: 1, subagents: 1, claims: 1, asks: 1 }, PLAIN),
		"📡 alpha · 2 peers (1 busy) + 1 subagent · 1 claim · 1 ask waiting",
	);
	assert.equal(statusText({ callsign: "alpha", peers: 0, busy: 0, subagents: 0, claims: 0, asks: 0 }, PLAIN), "📡 alpha · solo");
});

test("view: the widget lists this agent first, subagents under their parent, and fits its width", () => {
	const self = presence("a", "alpha", { state: "busy", task: "make login() async", claims: [{ pattern: "src/auth/**", since: now, expiresAt: now + 60_000 }] });
	const bravo = presence("b", "bravo", { state: "busy", task: "fix the upload test", startedAt: now - 1 });
	const child = presence("b1", "bravo-1", { role: "child", parent: "b", state: "busy", task: "run the tests" });
	const lane = presence("c", "charlie", { projectRoot: "/work/p-docs", cwd: "/work/p-docs", task: "update the docs" });
	const crowd = Array.from({ length: 10 }, (_, i) => presence(`x${i}`, `agent${i}`));
	const asks = [{ id: "ask-1", fromCallsign: "bravo", text: "is login() final?" }];
	const lines = widgetLines({ self, peers: [self, bravo, child, lane, ...crowd], asks, now }, PLAIN, 64);
	for (const line of lines) assert.ok(visibleWidth(line) <= 64, `fits: ${line}`);
	assert.match(lines[0] ?? "", /📡 telecom/);
	assert.match(lines[1] ?? "", /alpha .*you · claims src\/auth\/\*\*/);
	const bravoRow = lines.findIndex((l) => /● bravo /.test(l));
	assert.match(lines[bravoRow + 1] ?? "", /└ bravo-1/);
	assert.ok(lines.some((l) => /charlie .*in p-docs/.test(l)), "another checkout is named by its directory");
	assert.ok(lines.some((l) => /… \d+ more · \/telecom shows everyone/.test(l)));
	assert.ok(lines.some((l) => /\? bravo asks {2}is login\(\) final\?/.test(l)));
});

test("view: the help names every command", () => {
	const help = helpText();
	for (const c of COMMANDS) assert.ok(help.includes(`/telecom ${c.name}`), c.name);
});

test("/telecom completions describe each command and each agent", async () => {
	const proj = makeProject("p-view-complete");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("fix the upload test");
	const complete = a.commands.get("telecom")?.getArgumentCompletions as (p: string) => any[];
	const run = complete("ru").find((c) => c.value === "run");
	assert.match(run?.description ?? "", /every session/);
	await eventually(() => {
		const agent = complete("msg br").find((c) => c.label === "bravo");
		assert.match(agent?.description ?? "", /busy · fix the upload test/);
	});
});

test("/telecom widget gives an RPC client plain rows, and /telecom off shows in the footer", async () => {
	const proj = makeProject("p-view-rpc");
	const a = await session(proj);
	await session(proj);
	let widget: unknown;
	a.ctx.ui.setWidget = (_key: string, content: unknown) => {
		widget = content;
	};
	assert.match((await a.command("widget")).join("\n"), /📡 live team widget on/);
	await eventually(() => {
		assert.ok(Array.isArray(widget), "string rows, not a component, outside the TUI");
		assert.match((widget as string[]).join("\n"), /📡 telecom[\s\S]*alpha[\s\S]*bravo/);
	});
	assert.match((await a.command("widget")).join("\n"), /off/);
	assert.equal(widget, undefined);
	await a.command("off");
	assert.equal(a.status, "📡 off");
	await a.command("on");
	assert.match(a.status ?? "", /^📡 alpha · 1 peer/);
	assert.match((await a.command("nope")).join("\n"), /unknown command "nope"[\s\S]*\/telecom run <prompt>/);
});

/** Make a harness session look like the TUI: `custom()` hands its component to the test. */
function asTui(s: Session) {
	const shown: { component?: any; done?: Promise<unknown> } = {};
	const tui = { terminal: { rows: 60, columns: 100 }, requestRender: () => {} };
	const keybindings = {
		matches: (data: string, id: string) =>
			(id === "tui.select.cancel" && data === "\x1b") ||
			(id === "tui.select.confirm" && data === "\r") ||
			(id === "tui.select.up" && data === "\x1b[A") ||
			(id === "tui.select.down" && data === "\x1b[B"),
	};
	let widget: any;
	let editor = "";
	s.ctx.mode = "tui";
	s.ctx.ui.theme = plain;
	s.ctx.ui.setWidget = (_key: string, content: any) => {
		widget = typeof content === "function" ? content(tui, plain) : content;
	};
	s.ctx.ui.setEditorText = (text: string) => {
		editor = text;
	};
	s.ctx.ui.custom = (factory: any) => {
		shown.done = new Promise((resolve) => {
			shown.component = factory(tui, plain, keybindings, resolve);
		});
		return shown.done;
	};
	return { shown, widget: () => widget, editor: () => editor };
}

test("/telecom in the TUI: a live board panel; tab switches to the machine, w the widget, escape closes", async () => {
	const proj = makeProject("p-view-panel");
	const a = await session(proj);
	await session(proj);
	const ui = asTui(a);
	const notified = a.notified.length;
	const command = a.command("");
	await eventually(() => assert.ok(ui.shown.component, "the panel opened"));
	const panel = ui.shown.component;
	const text = () => panel.render(90).join("\n");
	assert.match(text(), /📡 Telecom/);
	assert.match(text(), /You are alpha\. 1 other agent live/);
	assert.match(text(), /● bravo|○ bravo/);
	assert.match(text(), /tab switch view · w widget · esc close/);
	for (const line of panel.render(90)) assert.ok(visibleWidth(line) <= 90);
	// Live: an agent that joins while the panel is open appears on the next refresh.
	await session(proj);
	await eventually(() => assert.match(text(), /charlie/));
	panel.handleInput("\t");
	assert.match(text(), /live on this machine/);
	panel.handleInput("w");
	assert.match(text(), /widget on/);
	assert.match(ui.widget()?.render(80).join("\n") ?? "", /📡 telecom[\s\S]*charlie/);
	panel.handleInput("\x1b");
	await command;
	assert.equal(a.notified.length, notified, "the board went to the panel, not to a notification");
});

test("/telecom help in the TUI: enter runs a command, or opens one with arguments in the editor", async () => {
	const proj = makeProject("p-view-help");
	const a = await session(proj);
	const ui = asTui(a);
	const command = a.command("help");
	await eventually(() => assert.ok(ui.shown.component));
	assert.match(ui.shown.component.render(100).join("\n"), /📡 Telecom commands[\s\S]*run <prompt>[\s\S]*start work/);
	ui.shown.component.handleInput("\x1b[B");
	ui.shown.component.handleInput("\x1b[B");
	ui.shown.component.handleInput("\r");
	await command;
	assert.equal(ui.editor(), "/telecom run ");
});
