/**
 * What the human sees: the panels in the transcript, the footer, the live widget and the
 * `/telecom` panels. None of it reaches the model; these tests pin the look's rules (one colour
 * per agent, model instructions dimmed, rows that fit) and the commands' TUI and RPC paths.
 */
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { findProjectRoot, findRepo } from "../src/project.ts";
import { agentColor, MESSAGE_TYPES, paintCallsigns, PLAIN, proseStyler, registerRenderers, styleBoard } from "../src/render.ts";
import { TOOL_SPEC } from "../src/tool.ts";
import { escapeRegExp } from "../src/util.ts";
import { COMMANDS, helpText, statusText, widgetLines } from "../src/view.ts";
import { eventually, makeProject, makeWorktree, PLAIN_THEME, Session, session, stopSessions } from "./harness.ts";

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
	const render = (theme: unknown, expanded = false) =>
		renderers.get(MESSAGE_TYPES.ask)({ content, details: { fromCallsign: "bravo", tone: "warning" } }, { expanded, outputPad: 1 }, theme);
	// Tags count as visible text, so the tagged render gets room enough not to wrap.
	const text = render(tagged).render(400).join("\n");
	assert.doesNotMatch(text, /Reply with telecom/, "folded, the instruction for the model is left out");
	assert.match(render(tagged, true).render(400).join("\n"), /<dim>Reply with telecom/, "expanded, it is there, dimmed");
	assert.match(render(plain).render(200)[0] ?? "", /📡 bravo → you · ask · they wait/, "the header reads as a route");
	assert.equal(render(plain).render(200).length, 2, "no blank rows: the header and the question");
	assert.match(text, /<text>Is the new login\(\) final\?<\/text>/, "the question reads as text");
	assert.match(text, new RegExp(`<${agentColor("bravo")}>▎`), "the edge is the sender's colour");
	for (const line of render(plain).render(60)) assert.equal(visibleWidth(line), 60);
});

test("render: what an agent wrote to another is drawn as Markdown, and claim patterns are not emphasis", () => {
	const lines = (text: string) => {
		const prose = proseStyler(tagged as any, ["alpha", "bravo"]);
		return text.split("\n").map(prose);
	};
	const one = (text: string) => lines(text)[0] ?? "";
	// Bold and code lose their marks and take a style; bold may hold code, and names a callsign.
	assert.equal(one("**Why 8:** it matches `NEXTEST_TEST_THREADS=8`."), "*<text>Why 8:</text>*<text> it matches </text><mdCode>NEXTEST_TEST_THREADS=8</mdCode><text>.</text>");
	assert.equal(one("**pinned to `c2755aac5`, git only**"), "*<text>pinned to </text>**<mdCode>c2755aac5</mdCode>**<text>, git only</text>*");
	const [b, a] = [agentColor("bravo"), agentColor("alpha")];
	assert.equal(one("**bravo decides**, alpha waits"), `*<${b}>bravo</${b}>**<text> decides</text>*<text>, </text>*<${a}>alpha</${a}>*<text> waits</text>`);
	// Claim patterns are everywhere in telecom: two in a sentence are not a bold span.
	for (const literal of ["claimed src/** and test/** for the parser", "**/x.ts and src/**/y.ts", "a ** b ** c", "2**8 and 3**2"]) {
		assert.equal(one(literal), `<text>${literal}</text>`, literal);
	}
	assert.equal(one("see `src/**` and `**/*.ts`"), "<text>see </text><mdCode>src/**</mdCode><text> and </text><mdCode>**/*.ts</mdCode>");
	// Lists, headings, quotes and links.
	assert.equal(one("- **Ref:** `origin/main`"), "<mdListBullet>•</mdListBullet> *<text>Ref:</text>*<text> </text><mdCode>origin/main</mdCode>");
	assert.equal(one("  * nested"), "  <mdListBullet>•</mdListBullet> <text>nested</text>");
	assert.equal(one("2. then merge"), "<mdListBullet>2.</mdListBullet> <text>then merge</text>");
	assert.equal(one("## What it **runs**"), "*<mdHeading>What it runs</mdHeading>*");
	assert.equal(one("> as foxtrot ruled"), "<mdQuoteBorder>│</mdQuoteBorder> <mdQuote>as foxtrot ruled</mdQuote>");
	assert.equal(one("see [#1644](https://example.com/i/1644) first"), "<text>see </text><mdLink>#1644</mdLink><dim> (https://example.com/i/1644)</dim><text> first</text>");
	assert.equal(one("-export function login()"), "<text>-export function login()</text>", "a diff line is no bullet");
	// A code block is code, mark for mark, and one styled line comes back per line given.
	const block = lines("run this:\n```sh\ncargo test -- **bold**\n```\nthen **stop**");
	assert.deepEqual(block, [
		"<text>run this:</text>",
		"<dim>```sh</dim>",
		"<mdCodeBlock>cargo test -- **bold**</mdCodeBlock>",
		"<dim>```</dim>",
		"<text>then </text>*<text>stop</text>*",
	]);
	// A call written for the model stays dimmed, as before.
	assert.match(one('then telecom({ action: "release" }) it'), /<dim>telecom\(\{ action: "release" \}\)<\/dim>/);
	// A theme without Markdown colours (another host's, a custom one) must not lose the message.
	const bare = {
		...tagged,
		fg: (color: string, text: string) => {
			if (color.startsWith("md")) throw new Error(`Unknown theme color: ${color}`);
			return tagged.fg(color, text);
		},
	};
	assert.equal(proseStyler(bare as any, [])("- run `gate.sh`"), "<muted>•</muted> <text>run </text><accent>gate.sh</accent>");
});

test("render: a peer's message, this agent's own send and an answer all draw Markdown; telecom's own notices do not", () => {
	const renderers = new Map<string, any>();
	registerRenderers({ registerMessageRenderer: (type: string, fn: unknown) => renderers.set(type, fn) } as any);
	const body = "**Script:** `gate.sh`\n- run it **once**";
	const shown = (type: string, content: string) => renderers.get(type)({ content, details: { fromCallsign: "bravo" } }, { expanded: true, outputPad: 1 }, tagged).render(400).join("\n");
	const message = shown(MESSAGE_TYPES.message, `**📡 Message from bravo**\n\n${body}`);
	assert.match(message, /\*<text>Script:<\/text>\*<text> <\/text><mdCode>gate\.sh<\/mdCode>/);
	assert.match(message, /<mdListBullet>•<\/mdListBullet> <text>run it <\/text>\*<text>once<\/text>\*/);
	// A claim notice names patterns, and a change notice quotes code: shown as written.
	const claim = shown(MESSAGE_TYPES.claim, "**📡 1 claim released**\n\nsrc/** and test/** are free; `x` stays");
	assert.match(claim, /src\/\*\* and test\/\*\* are free; `x` stays/);
	// This agent's own send, expanded, and the answer to its ask.
	const call = (TOOL_SPEC as any).renderCall({ action: "send", to: "bravo", message: body }, tagged, { expanded: true, args: {} }).render(400).join("\n");
	assert.match(call, /<mdCode>gate\.sh<\/mdCode>/);
	const status = (TOOL_SPEC as any).renderCall({ action: "status", message: "gate on src/** and test/** running" }, tagged, { expanded: true, args: {} }).render(400).join("\n");
	assert.match(status, /gate on src\/\*\* and test\/\*\* running/, "a status is a plain line");
	const result = { content: [{ type: "text", text: `bravo answered:\n\n${body}` }], details: { ok: true } };
	const answer = (TOOL_SPEC as any).renderResult(result, { expanded: true, isPartial: false }, tagged, { args: { action: "ask", to: "bravo" } }).render(400).join("\n");
	assert.match(answer, /<mdListBullet>•<\/mdListBullet> <text>run it <\/text>\*<text>once<\/text>\*/);
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

test("view: the widget names the worktree a peer works in, not the checkout it started in", () => {
	const root = findProjectRoot(makeProject("p-widget-lane"));
	const wt = makeWorktree(root, "wb", "lane-b");
	const started = { cwd: root, projectRoot: root, repo: findRepo(root) };
	const self = presence("a", "alpha", started);
	const bravo = presence("b", "bravo", { ...started, recent: [{ path: join(wt, "src", "x.ts"), op: "edit", at: now }] });
	const lines = widgetLines({ self, peers: [self, bravo], asks: [], now }, PLAIN, 100);
	assert.match(lines.find((l) => /● bravo |○ bravo /.test(l)) ?? "", new RegExp(`in ${escapeRegExp(basename(wt))}`), lines.join("\n"));
	assert.doesNotMatch(lines.find((l) => /alpha/.test(l)) ?? "", / in /, "this agent works where it started");
});

test("view: the widget and the board panel say what a renamed session was called", () => {
	const root = findProjectRoot(makeProject("p-widget-was"));
	const started = { cwd: root, projectRoot: root, repo: findRepo(root) };
	const self = presence("a", "alpha", started);
	const bravo = presence("b", "bravo", { ...started, formerly: "delta" });
	const lines = widgetLines({ self, peers: [self, bravo], asks: [], now }, PLAIN, 100);
	assert.match(lines.find((l) => /bravo/.test(l)) ?? "", /was delta/, lines.join("\n"));
	assert.doesNotMatch(lines.find((l) => /alpha/.test(l)) ?? "", /was /);
});

test("render: a claim result shows the paths it left out under what it claimed", () => {
	const text = [
		'claimed src/x.ts — parser. Peers editing there are held back and you are told. Release with telecom({ action: "release" }) when done; idle claims expire after 120 min.',
		"Not claimed: /notes/TEAM.md is outside this repository (/work/p and its worktrees), and claims cover only its files.",
	].join("\n");
	const result = { content: [{ type: "text", text }], details: { ok: true } };
	const rendered = (TOOL_SPEC as any).renderResult(result, { expanded: true, isPartial: false }, PLAIN_THEME, { args: { action: "claim" } });
	const out = rendered.render(160).join("\n");
	assert.match(out, /✓ claimed src\/x\.ts/);
	assert.match(out, /⚠ Not claimed: \/notes\/TEAM\.md is outside this repository/);
});

test("render: the short claim, lock, queue and status results show what happened in a row each", () => {
	const show = (action: string, text: string) =>
		(TOOL_SPEC as any)
			.renderResult({ content: [{ type: "text", text }], details: { ok: true } }, { expanded: false, isPartial: false }, PLAIN_THEME, { args: { action } })
			.render(160)
			// Without the panel's edge.
			.map((l: string) => l.replace(/^▎ ?/, "").trimEnd())
			.join("\n")
			.trim();
	// What a claim covers ends at its reason or its full stop, never inside a file name.
	assert.equal(show("claim", "claimed src/x.ts, docs/a.md."), "✓ claimed src/x.ts, docs/a.md");
	assert.equal(show("claim", "claimed src/x.ts — the parser."), "✓ claimed src/x.ts");
	assert.equal(show("claim", "claimed src/x.ts. Kept while process 4242 runs."), "✓ claimed src/x.ts");
	assert.equal(show("claim", "claimed @cargo — build: yours until you release it."), "✓ claimed @cargo");
	assert.equal(show("claim", "renewed @cargo: yours while process 4242 runs."), "✓ renewed @cargo");
	assert.equal(show("claim", "queued for @cargo, held by bravo since 2m ago (busy) — build. Not yours yet. You are woken when it is."), "◷ queued for @cargo");
	assert.equal(show("claim", "queued for @cargo, free, but bravo is first in line for it and takes it now; ahead of you: bravo. Not yours yet. You are woken when it is."), "◷ queued for @cargo");
	assert.equal(show("status", "status set"), "✓ status set");
	assert.equal(show("status", "status set · waiting for bravo"), "✓ status set · waiting for bravo");
	assert.equal(show("status", "task unchanged · no longer waiting for anyone"), "✓ task unchanged · no longer waiting for anyone");
	assert.equal(show("status", `status set — peers see: ${"x ".repeat(40)}…`), "✓ status set");
	assert.match(show("status", "status set\nbravo waits for you."), /^✓ status set\n\s*⚠ bravo waits for you\.$/);
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
