/**
 * presence-live — each peer's live state as others see it (how long it has been idle, the long
 * tool call it is in), and who is in the team: the human is told by name who joined or left, a
 * record missing for a moment is not a departure, and a model in a long run hears of joins and
 * departures while it works.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, type TestContext, test } from "node:test";
import { stateHint } from "../src/address.ts";
import { findProjectRoot } from "../src/project.ts";
import { PLAIN } from "../src/render.ts";
import { openTransport, type Presence, parsePresence, processStartTicks, readStartTicks, settleDepartures, WIRE_VERSION } from "../src/transport.ts";
import { widgetLines } from "../src/view.ts";
import { eventually, makeProject, session, sleep, stopSessions, withEnv } from "./harness.ts";

afterEach(stopSessions);

const MINUTE = 60_000;
const realNow = Date.now.bind(Date);

/** Move every session's clock `offsetMs` ahead, until the test ends. Set it between `eventually`
 *  calls, never during one: their deadlines read the clock too. */
function shiftClock(t: TestContext): (offsetMs: number) => void {
	let offset = 0;
	t.mock.method(Date, "now", () => realNow() + offset);
	return (offsetMs) => {
		offset = offsetMs;
	};
}

function record(id: string, callsign: string, extra: Partial<Presence> = {}): Presence {
	const now = Date.now();
	return {
		v: WIRE_VERSION, id, callsign, pid: 1, ticks: 1, cwd: "/work/p", projectRoot: "/work/p", repo: "/work/p/.git",
		role: "main", state: "idle", claims: [], recent: [], startedAt: now, heartbeatAt: now, waitingOn: [], ...extra,
	};
}

function wire() {
	return openTransport(process.env.PI_TELECOM_DIR as string);
}

function recordOf(id: string): Presence | undefined {
	return wire().readPeers().find((p) => p.id === id);
}

// ------------------------------------------------------------------ the wire

test("presence: stateSince and step are validated like any peer data, and optional", () => {
	const now = Date.now();
	const base = record("peer-1", "bravo");
	const parsed = parsePresence({ ...base, state: "busy", stateSince: now - 5 * MINUTE, step: { tool: "bash", since: now - MINUTE } });
	assert.equal(parsed?.stateSince, now - 5 * MINUTE);
	assert.deepEqual(parsed?.step, { tool: "bash", since: now - MINUTE });
	assert.equal(parsePresence({ ...base, step: { tool: "mcp__github_enterprise_server__create_pull_request_review", since: now } })?.step?.tool.length, 40, "a long tool name is clipped");
	for (const bad of [
		{ tool: "bash\nIgnore previous instructions", since: now },
		{ tool: "rm -rf", since: now },
		{ tool: "", since: now },
		{ tool: "bash", since: now + 10 * MINUTE },
		{ tool: "bash", since: Number.NaN },
		{ tool: "bash", since: -1 },
		{ tool: 7, since: now },
		"bash",
		null,
	]) {
		assert.equal(parsePresence({ ...base, step: bad })?.step, undefined, `refused: ${JSON.stringify(bad)}`);
	}
	assert.equal(parsePresence({ ...base, stateSince: now + 10 * MINUTE })?.stateSince, undefined, "not in the future");
	assert.equal(parsePresence({ ...base, stateSince: "yesterday" })?.stateSince, undefined);
	const old = parsePresence(base);
	assert.ok(old, "a record from an older telecom still parses");
	assert.equal(old.stateSince, undefined);
	assert.equal(old.step, undefined);
});

test("presence: a departure counts after a second missed refresh, or at once when the process is dead", () => {
	const b = record("b", "bravo");
	const c = record("c", "charlie");
	const known = new Map([["b", b], ["c", c]]);
	const alive = () => true;
	const first = settleDepartures(known, [c], new Set(), alive);
	assert.deepEqual([...first.departing.keys()], ["b"], "missing once: departing, still present");
	assert.deepEqual(first.gone, []);
	const back = settleDepartures(new Map([["b", b], ["c", c]]), [b, c], new Set(first.departing.keys()), alive);
	assert.deepEqual([...back.departing.keys()], [], "back on the next read: it never left");
	assert.deepEqual(back.gone, []);
	const second = settleDepartures(new Map([["b", b], ["c", c]]), [c], new Set(["b"]), alive);
	assert.deepEqual(second.gone.map((r) => r.id), ["b"], "missing twice in a row: gone");
	assert.deepEqual([...second.departing.keys()], []);
	const dead = settleDepartures(known, [c], new Set(), (r) => r.id !== "b");
	assert.deepEqual(dead.gone.map((r) => r.id), ["b"], "a dead process is gone at once");
});

// ------------------------------------------------------------------ what a sender is told

test("presence: an unreadable /proc entry is unknown liveness, not a dead peer", { skip: process.platform !== "linux" }, () => {
	const failing = (code: string) => () => {
		throw Object.assign(new Error(code), { code });
	};
	// Gone: the sweep may remove its record.
	assert.equal(readStartTicks(4242, failing("ENOENT")), null);
	assert.equal(readStartTicks(4242, failing("ESRCH")), null);
	// Not readable right now: unknown, so liveness falls back to signalling the pid instead of
	// unlinking a live peer's record (which every peer then saw as a leave and a join).
	assert.equal(readStartTicks(4242, failing("EMFILE")), undefined);
	assert.equal(readStartTicks(4242, failing("EACCES")), undefined);
	assert.equal(readStartTicks(4242, () => "4242 (pi) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19"), 777);
	assert.equal(readStartTicks(process.pid), processStartTicks(process.pid));
});

test("stateHint: a long tool call is named, with the non-blocking ask; idle time; older peers as before", () => {
	const now = Date.now();
	const self = record("me", "alpha");
	const long = record("p1", "bravo", { state: "busy", stateSince: now - 20 * MINUTE, step: { tool: "bash", since: now - 14 * MINUTE } });
	const hint = stateHint(long, self, [self, long]);
	assert.match(hint, /^busy in bash for 14m — it reads this when that call ends/);
	assert.match(hint, /may time out/);
	assert.match(hint, /telecom\(\{ action: "ask", to: "bravo", message: "…", wait: false \}\) returns at once/);
	const short = record("p2", "charlie", { state: "busy", step: { tool: "bash", since: now - 20_000 } });
	assert.equal(stateHint(short, self, [self, short]), "busy — it reaches them before their next step", "a call that may end soon is not news");
	const idle = record("p3", "delta", { state: "idle", stateSince: now - 12 * MINUTE });
	assert.equal(stateHint(idle, self, [self, idle]), "idle for 12m — this wakes them");
	const justIdle = record("p4", "echo", { state: "idle", stateSince: now - 3_000 });
	assert.equal(stateHint(justIdle, self, [self, justIdle]), "idle — this wakes them");
	const older = record("p5", "foxtrot", { state: "busy" });
	assert.equal(stateHint(older, self, [self, older]), "busy — it reaches them before their next step");
	const hung = record("p6", "golf", { state: "busy", step: { tool: "bash", since: now - 30 * MINUTE }, heartbeatAt: now - 10 * MINUTE });
	assert.match(stateHint(hung, self, [self, hung]), /^unresponsive since 10m ago/, "unresponsive wins over a step");
});

test("widget: rows show the long tool call a peer is in and how long a peer has been idle", () => {
	const now = Date.now();
	const self = record("me", "alpha");
	const bravo = record("p1", "bravo", { state: "busy", step: { tool: "bash", since: now - 14 * MINUTE } });
	const charlie = record("p2", "charlie", { state: "idle", stateSince: now - 12 * MINUTE });
	const delta = record("p3", "delta", { state: "busy" });
	const lines = widgetLines({ self, peers: [self, bravo, charlie, delta], asks: [], now }, PLAIN, 80);
	assert.match(lines.find((l) => / bravo /.test(l)) ?? "", /busy bash 14m/);
	assert.match(lines.find((l) => / charlie /.test(l)) ?? "", /idle 12m/);
	assert.match(lines.find((l) => / delta /.test(l)) ?? "", /busy\s+no task yet/);
	const column = (name: string) => (lines.find((l) => l.includes(` ${name} `)) ?? "").indexOf("no task yet");
	assert.equal(column("charlie"), column("bravo"), "the task column stays aligned");
	for (const line of widgetLines({ self, peers: [self, bravo, charlie], asks: [], now }, PLAIN, 40)) {
		assert.ok(line.length <= 40, `fits: ${line}`);
	}
});

// ------------------------------------------------------------------ a peer's step, live

test("presence: a tool call is published as the step only once it runs long, and cleared when it ends", async (t) => {
	const proj = makeProject("p-live-step");
	const shift = shiftClock(t);
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("run the whole test suite");
	assert.equal(recordOf(b.id)?.state, "busy");
	const busySince = recordOf(b.id)?.stateSince ?? 0;
	assert.ok(busySince > 0, "busy since the run started");

	// A short call: nothing is published for it.
	await b.read("README.md");
	await b.fire("tool_call", { toolName: "bash", toolCallId: "bash-short", input: { command: "ls" } });
	await sleep(100);
	await b.fire("tool_result", { toolName: "bash", toolCallId: "bash-short", input: { command: "ls" }, content: [], isError: false });
	assert.equal(recordOf(b.id)?.step, undefined, "a short call is never published");

	// A long one: published from the tick once it has run 15 s.
	await b.fire("tool_call", { toolName: "bash", toolCallId: "bash-long", input: { command: "npm test" } });
	await sleep(100);
	assert.equal(recordOf(b.id)?.step, undefined, "not before it runs long");
	shift(20_000);
	await eventually(() => assert.equal(recordOf(b.id)?.step?.tool, "bash"));
	await eventually(async () => assert.match((await a.tool({ action: "board" })).text, /• bravo \[busy · bash 2\ds\]/));
	assert.match((await a.tool({ action: "send", to: "bravo", message: "fyi" })).text, /\(busy — it reaches them before their next step\)/, "20 s is not long yet");
	shift(15 * MINUTE);
	await eventually(async () => {
		const sent = await a.tool({ action: "send", to: "bravo", message: "the api moved" });
		assert.match(sent.text, /busy in bash for 15m — it reads this when that call ends/);
		assert.match(sent.text, /wait: false/);
	});

	// Its end clears it; a blocked call has no tool_result, but always a tool_execution_end.
	await b.fire("tool_result", { toolName: "bash", toolCallId: "bash-long", input: {}, content: [], isError: false });
	await eventually(() => assert.equal(recordOf(b.id)?.step, undefined));
	await b.fire("tool_call", { toolName: "bash", toolCallId: "bash-blocked", input: { command: "make" } });
	shift(16 * MINUTE);
	await eventually(() => assert.equal(recordOf(b.id)?.step?.tool, "bash"));
	await b.fire("tool_execution_end", { toolName: "bash", toolCallId: "bash-blocked", result: {}, isError: true });
	await eventually(() => assert.equal(recordOf(b.id)?.step, undefined));

	// Settling clears any step left and marks the time it went idle.
	await b.fire("tool_call", { toolName: "subagent", toolCallId: "sub-1", input: {} });
	shift(17 * MINUTE);
	await eventually(() => assert.equal(recordOf(b.id)?.step?.tool, "subagent"));
	// The model's turn: it read the messages sent above (the harness is always "idle", so they
	// counted as wake-ups owed an answer, and an unanswered one shows on the board).
	await b.fire("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [] } });
	await b.settle();
	const idle = recordOf(b.id);
	assert.equal(idle?.state, "idle");
	assert.equal(idle?.step, undefined);
	assert.ok((idle?.stateSince ?? 0) > busySince);
	shift(30 * MINUTE);
	await eventually(async () => assert.match((await a.tool({ action: "board" })).text, /• bravo \[idle 13m\]/));
	assert.match((await a.tool({ action: "send", to: "bravo", message: "ping" })).text, /idle for 13m — this wakes them/);
});

test("briefs: a peer's state, step and idle time are never team news", async (t) => {
	const proj = makeProject("p-live-brief");
	const shift = shiftClock(t);
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("refactor the parser");
	const full = (await a.prompt("start"))?.message?.content ?? "";
	assert.match(full, /• bravo \[busy\]/, "a brief shows the bare state");
	await b.fire("tool_call", { toolName: "bash", toolCallId: "bash-1", input: {} });
	shift(5 * MINUTE);
	await eventually(() => assert.equal(recordOf(b.id)?.step?.tool, "bash"));
	assert.equal(await a.prompt("again"), undefined, "a step is not news");
	await b.fire("tool_result", { toolName: "bash", toolCallId: "bash-1", input: {}, content: [], isError: false });
	await b.settle();
	shift(20 * MINUTE);
	await eventually(() => assert.equal(recordOf(b.id)?.state, "idle"));
	assert.equal(await a.prompt("and again"), undefined, "going idle, and staying idle, is not news");
});

// ------------------------------------------------------------------ who is in

test("team: the human is told by name who joined and who left; a rename is neither", async () => {
	const proj = makeProject("p-live-names");
	const a = await session(proj);
	const b = await session(proj);
	await sleep(150); // past the startup ticks, whose joins are the team as it was
	const c = await session(proj);
	await eventually(() => assert.ok(a.notified.some((n) => /📡 charlie joined/.test(n)), a.notified.join(" | ")));
	await c.command("name ops");
	await sleep(150);
	assert.ok(!a.notified.some((n) => /left|ops joined/.test(n)), `a rename is not a leave and a join: ${a.notified.join(" | ")}`);
	await b.stop();
	await eventually(() => assert.ok(a.notified.some((n) => /📡 bravo left/.test(n)), a.notified.join(" | ")));
	await c.stop();
	await eventually(() => assert.ok(a.notified.some((n) => /📡 ops left/.test(n)), "named by its callsign now"));
});

test("team: a known peer leaving is news even in the first ticks, which a loaded machine may still be in", async (t) => {
	const proj = makeProject("p-live-early-leave");
	const b = await session(proj);
	// A ticks slowly, so its second tick (its first refresh) comes after B has gone. Ticks are not
	// time: on a loaded CI runner a session ticked only twice in the seconds before a peer left.
	withEnv(t, "PI_TELECOM_TICK_MS", "400");
	const a = await session(proj);
	await b.stop();
	await eventually(() => assert.ok(a.notified.some((n) => /📡 alpha left/.test(n)), a.notified.join(" | ")), 3_000);
});

test("team: a peer that renames and leaves between two refreshes is named as the human last saw it", async (t) => {
	const proj = makeProject("p-live-rename-leave");
	const b = await session(proj);
	// A refreshes every 800 ms: B renames, A's human sees the new name on the board, and B leaves,
	// all before A's first refresh. What CI does to the RPC e2e, whose commands queue up that fast.
	withEnv(t, "PI_TELECOM_TICK_MS", "400");
	const a = await session(proj);
	await b.command("name ops");
	await a.command("");
	assert.ok(a.notified.some((n) => /• ops/.test(n)), a.notified.join(" | "));
	await b.stop();
	await eventually(() => assert.ok(a.notified.some((n) => /📡 ops left/.test(n)), a.notified.join(" | ")), 3_000);
});

test("team: a peer record missing for less than a refresh is not a departure; one that stays missing is", async (t) => {
	const proj = makeProject("p-live-flap");
	// Slower ticks for the observer (a refresh every 200 ms), so the gaps below fit inside one.
	withEnv(t, "PI_TELECOM_TICK_MS", "100");
	const a = await session(proj);
	const net = wire();
	const zulu = (): Presence => ({
		v: WIRE_VERSION, id: "flapping-peer-0001", callsign: "zulu", pid: process.ppid, ticks: processStartTicks(process.ppid),
		cwd: proj, projectRoot: findProjectRoot(proj), role: "main", state: "idle", claims: [], recent: [],
		startedAt: 1, heartbeatAt: Date.now(),
	});
	await sleep(500); // past the startup ticks
	net.writePresence(zulu());
	await eventually(() => assert.ok(a.notified.some((n) => /zulu joined/.test(n)), a.notified.join(" | ")));
	// What a sweeper that misjudged zulu's liveness does: unlink the record, which zulu then
	// writes again on its next refresh. Each gap is shorter than one of the observer's refreshes.
	for (let i = 0; i < 6; i++) {
		rmSync(join(net.root, "presence", "flapping-peer-0001.json"));
		await sleep(130);
		net.writePresence(zulu());
		await sleep(250);
	}
	assert.ok(!a.notified.some((n) => /left/.test(n)), `no false departure: ${a.notified.join(" | ")}`);
	assert.equal(a.notified.filter((n) => /zulu joined/.test(n)).length, 1, "nor a second join");
	net.removePresence("flapping-peer-0001");
	await eventually(() => assert.ok(a.notified.some((n) => /📡 zulu left/.test(n)), a.notified.join(" | ")));
});

// ------------------------------------------------------------------ the model, mid-run

test("mid-run: a teammate joining or leaving reaches a busy model as a passive team update", async () => {
	const proj = makeProject("p-live-midrun");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("the api layer");
	await b.tool({ action: "claim", paths: ["src/api/**"] });
	const full = (await a.prompt("a long refactor"))?.message?.content ?? "";
	assert.match(full, /1 other agent is working/);
	// alpha is now in a long run (no settle).
	const c = await session(proj);
	await c.prompt("the docs");
	await eventually(() => assert.equal(a.sentOf("telecom-brief").length, 1));
	const joined = a.sentOf("telecom-brief")[0];
	assert.match(joined?.content ?? "", /team update/);
	assert.match(joined?.content ?? "", /• joined: charlie/);
	assert.equal(joined?.options, undefined, "passive: steered into the run, never a new turn");
	await b.stop();
	await eventually(() => assert.equal(a.sentOf("telecom-brief").length, 2));
	assert.match(a.sentOf("telecom-brief")[1]?.content ?? "", /• bravo left \(its claims src\/api\/\*\* are free\)/);
	assert.equal(await a.prompt("next"), undefined, "the next brief does not repeat what the run was told");

	// Idle: nothing is sent; the next prompt's brief carries it.
	await a.settle();
	const d = await session(proj);
	await sleep(200);
	assert.equal(a.sentOf("telecom-brief").length, 2, "an idle agent is not told mid-run (it has no run)");
	const newcomer = (await d.tool({ action: "board" })).details.callsign; // bravo's word is free again
	assert.match((await a.prompt("more"))?.message?.content ?? "", new RegExp(`• joined: ${newcomer} `));
	assert.ok(c);
});

test("mid-run: a far newcomer in a big team is one roster line; an agent never briefed hears nothing", async () => {
	const proj = makeProject("p-live-midrun-many");
	const a = await session(proj);
	const [b, c, d] = [await session(proj), await session(proj), await session(proj)];
	await a.prompt("work on a.ts");
	const e = await session(proj);
	await e.prompt("the build");
	await eventually(() => assert.equal(a.sentOf("telecom-brief").length, 1));
	const update = a.sentOf("telecom-brief")[0]?.content ?? "";
	assert.match(update, /^• joined: echo \[(?:idle|busy)\][^\n]*$/m, "far from alpha's work: a roster entry, not a description");
	assert.doesNotMatch(update, /id \w{8}/);
	assert.ok(b && c && d);

	// Solo when its run started: no brief was sent, so a join mid-run waits for the next prompt.
	const solo = makeProject("p-live-midrun-solo");
	const x = await session(solo);
	assert.equal(await x.prompt("alone"), undefined, "no peers, no brief");
	const y = await session(solo);
	await sleep(200);
	assert.equal(x.sentOf("telecom-brief").length, 0);
	assert.match((await x.prompt("next"))?.message?.content ?? "", /1 other agent is working/);
	assert.ok(y);
});

test("briefs: a record one read missed is not told as a leave, nor its return as a join", async (t) => {
	const proj = makeProject("p-live-brief-flap");
	// Slower loops (a refresh every 200 ms): bravo writes its missing record again on its next one.
	withEnv(t, "PI_TELECOM_TICK_MS", "100");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("the parser");
	await sleep(500); // alpha's team refresh has bravo
	assert.match((await a.prompt("the lexer"))?.message?.content ?? "", /bravo/);
	// What a sweeper that misjudged bravo's liveness does.
	rmSync(join(wire().root, "presence", `${b.id}.json`));
	assert.equal(await a.prompt("more lexer work"), undefined, "a record missing from one read is no departure");
	await eventually(() => assert.ok(recordOf(b.id), "bravo wrote it again"));
	await sleep(500);
	assert.equal(await a.prompt("and more"), undefined, "nor is its return a join");
	assert.equal(a.sentOf("telecom-brief").length, 0, "nor was either told mid-run");
	assert.ok(!a.notified.some((n) => /left|joined/.test(n)), a.notified.join(" | "));
});

test("team: a clean leave counts at once though the process lives on; back with /telecom on, a missed read is no leave again", async () => {
	const proj = makeProject("p-live-leave-mark");
	const a = await session(proj);
	const b = await session(proj);
	await sleep(150); // alpha's team refresh has bravo
	assert.match((await a.prompt("the lexer"))?.message?.content ?? "", /bravo/);
	await b.command("off");
	assert.match((await a.prompt("more"))?.message?.content ?? "", /bravo left/, "the next brief has it, without waiting for a second refresh");
	await b.command("on");
	assert.match((await a.prompt("again"))?.message?.content ?? "", /joined: bravo/);
	await sleep(150); // alpha's team refresh has bravo again
	// The mark of the earlier leave was taken back: a missed read is a missed read again.
	rmSync(join(wire().root, "presence", `${b.id}.json`));
	const late = await a.prompt("still going");
	assert.equal(late, undefined, late?.message?.content);
});
