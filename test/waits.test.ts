/**
 * waits — declared waits that outlive a status and work, and end only when a message says so
 * (`unblocks`) or the agent clears them; who waits on an agent (board, brief), and wait cycles
 * told once they stall.
 */
import assert from "node:assert/strict";
import { afterEach, type TestContext, test } from "node:test";
import { openTransport, parseEnvelope, parsePresence, type Presence } from "../src/transport.ts";
import { eventually, makeProject, type Session, session, sleep, stopSessions } from "./harness.ts";

afterEach(stopSessions);

/** A session's record as its peers read it. */
function published(s: Session): Presence | undefined {
	return openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === s.id);
}

/**
 * A clock that can jump: every `Date.now()` reads real time plus what `jump` added, so waiting for
 * five minutes of idleness takes no time. Real time keeps running, so `eventually` still times out.
 */
function clock(t: TestContext): { jump(ms: number): void } {
	const real = Date.now;
	let offset = 0;
	t.mock.method(Date, "now", () => real() + offset);
	return {
		jump(ms) {
			offset += ms;
		},
	};
}

const messagesFrom = (s: Session, from: string) => s.sentOf("telecom-message").filter((m) => m.content.startsWith(`**📡 Message from ${from}`));
const stalls = (s: Session) => s.sentOf("telecom-message").filter((m) => m.content.startsWith("**📡 Wait cycle stalled"));

// ---------------------------------------------------------------- status keeps waits

test("status: a status without waitingFor keeps the wait, the same set keeps its age, and [] clears both", async () => {
	const proj = makeProject("p-waits-status");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const set = await a.tool({ action: "status", message: "waiting on the schema", waitingFor: ["bravo"] });
	assert.ok(!set.isError, set.text);
	assert.match(set.text, /^status set · waiting for bravo\. You are woken when one of them finishes a run or leaves\./);
	const since = published(a)?.blockedSince;
	assert.ok(since && since <= Date.now());
	await sleep(15);
	const kept = await a.tool({ action: "status", message: "still on the schema, reading the docs meanwhile" });
	assert.match(kept.text, /still waiting for bravo/);
	assert.deepEqual(kept.details.waitingFor, ["bravo"]);
	assert.deepEqual(published(a)?.blockedOn, [b.id]);
	const quiet = await a.tool({ action: "status" });
	assert.match(quiet.text, /waiting for bravo/);
	assert.deepEqual(published(a)?.blockedOn, [b.id], "reading the status changes nothing");
	await a.tool({ action: "status", waitingFor: ["bravo"] });
	assert.equal(published(a)?.blockedSince, since, "the same set declared again keeps its age");
	await sleep(15);
	await a.tool({ action: "status", waitingFor: ["bravo", "charlie"] });
	assert.deepEqual(published(a)?.blockedOn, [b.id, c.id]);
	assert.ok((published(a)?.blockedSince ?? 0) > (since ?? 0), "a different set is a new wait");
	const replaced = await a.tool({ action: "status", message: "now on the docs", waitingFor: ["charlie"] });
	assert.equal(replaced.text, "status set · waiting for charlie", "how a wait works was said once already");
	assert.deepEqual(published(a)?.blockedOn, [c.id]);
	const cleared = await a.tool({ action: "status", waitingFor: [] });
	assert.match(cleared.text, /no longer waiting for anyone/);
	assert.equal(published(a)?.blockedOn, undefined);
	assert.equal(published(a)?.blockedSince, undefined, "no wait, no age");
});

// ---------------------------------------------------------------- unblocks

test("waits end only when told: an FYI, reading it and work after it leave the wait; a message that unblocks, or [], ends it", async (t) => {
	const time = clock(t);
	const proj = makeProject("p-waits-unblocks");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	await a.tool({ action: "status", message: "waiting for green", waitingFor: ["bravo", "charlie"] });
	await b.tool({ action: "send", to: "alpha", message: "fyi: the schema moved to v3" });
	await eventually(() => assert.equal(messagesFrom(a, "bravo").length, 1));
	const fyi = messagesFrom(a, "bravo")[0]?.content ?? "";
	assert.match(fyi, /\(Still waiting for bravo, charlie\. If this is what you waited for from bravo, drop the wait: telecom\(\{ action: "status", waitingFor: \["charlie"\] \}\)\.\)$/);
	await b.tool({ action: "send", to: "alpha", message: "fyi: and the client too" });
	await eventually(() => assert.equal(messagesFrom(a, "bravo").length, 2));
	assert.doesNotMatch(messagesFrom(a, "bravo")[1]?.content ?? "", /Still waiting/, "said once per wait, not on every message");
	// Work after hearing is no sign the wait is over: an edit, a claim on files, a long command.
	await a.write("notes.md", "starting on the work");
	await a.tool({ action: "claim", paths: ["src/**"] });
	await a.prompt("run the gate");
	await a.fire("tool_call", { toolName: "bash", toolCallId: "gate-1", input: { command: "cargo nextest run" } });
	time.jump(20_000);
	await eventually(() => assert.equal(published(a)?.step?.tool, "bash"));
	await sleep(150); // several team refreshes
	assert.deepEqual(published(a)?.blockedOn, [b.id, c.id], "only the agent, or a message that says so, ends a wait");
	assert.ok(!a.sentOf("telecom-message").some((m) => /Your wait on/.test(m.content)), "nothing is guessed, so nothing is told");
	await a.fire("tool_execution_end", { toolName: "bash", toolCallId: "gate-1", result: {}, isError: false });
	await c.tool({ action: "send", to: "alpha", message: "tests are green", unblocks: true });
	await eventually(() => assert.deepEqual(published(a)?.blockedOn, [b.id]));
	assert.doesNotMatch(messagesFrom(a, "charlie")[0]?.content ?? "", /Still waiting/, "the wait it ended is not mentioned");
	await a.tool({ action: "status", waitingFor: [] });
	assert.equal(published(a)?.blockedOn, undefined);
	assert.equal(published(a)?.blockedSince, undefined);
});

test("unblocks: an answer leaves the wait with a line, once per wait, unless it says it unblocks", async () => {
	const proj = makeProject("p-waits-answers");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "waiting for bravo's review", waitingFor: ["bravo"] });
	const askId = () => /askId: "([^"]+)"/.exec(b.sentOf("telecom-ask").at(-1)?.content ?? "")?.[1] ?? "";
	await a.tool({ action: "ask", to: "bravo", message: "is the review done?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: askId(), message: "not yet" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	assert.match(a.sentOf("telecom-reply")[0]?.content ?? "", /not yet\n\n\(Still waiting for bravo\. If this is what you waited for from bravo, drop the wait: telecom\(\{ action: "status", waitingFor: \[\] \}\)\.\)$/);
	assert.deepEqual(published(a)?.blockedOn, [b.id]);
	await a.tool({ action: "ask", to: "bravo", message: "tell me when it is" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 2));
	await b.tool({ action: "reply", askId: askId(), message: "almost" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 2));
	assert.doesNotMatch(a.sentOf("telecom-reply")[1]?.content ?? "", /Still waiting/, "once per wait");
	// Declared again, it is said again.
	await a.tool({ action: "status", waitingFor: [] });
	await new Promise((r) => setTimeout(r, 2));
	await a.tool({ action: "status", message: "waiting for bravo's review", waitingFor: ["bravo"] });
	await a.tool({ action: "ask", to: "bravo", message: "and the docs?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 3));
	await b.tool({ action: "reply", askId: askId(), message: "almost too" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 3));
	assert.match(a.sentOf("telecom-reply")[2]?.content ?? "", /almost too\n\n\(Still waiting for bravo\./);
	// An answer that says it unblocks ends the wait.
	await a.tool({ action: "ask", to: "bravo", message: "and now?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 4));
	await b.tool({ action: "reply", askId: askId(), message: "done", unblocks: true });
	await eventually(() => assert.equal(published(a)?.blockedOn, undefined));
	assert.doesNotMatch(a.sentOf("telecom-reply").at(-1)?.content ?? "", /Still waiting/);
});

test("unblocks: the wire field is kept on a message or answer only, and only when it is true", () => {
	const base = { v: 1, id: "e", ts: 1, from: "a", to: "b", text: "" };
	assert.equal(parseEnvelope({ ...base, kind: "message", unblocks: true })?.unblocks, true);
	assert.equal(parseEnvelope({ ...base, kind: "answer", answerTo: "x", unblocks: true })?.unblocks, true);
	assert.equal(parseEnvelope({ ...base, kind: "message", unblocks: "true" })?.unblocks, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message", unblocks: 1 })?.unblocks, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message", unblocks: false })?.unblocks, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "broadcast", unblocks: true })?.unblocks, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "ask", unblocks: true })?.unblocks, undefined);
});

test("blockedSince: read like the other times: a past time with a wait, never a forged future one", () => {
	const base = { v: 1, id: "s1", callsign: "bravo", pid: 1, ticks: null, cwd: "/x", projectRoot: "/x", claims: [], recent: [], startedAt: 1, heartbeatAt: 1 };
	const waits = { blockedOn: ["s2"] };
	assert.equal(parsePresence({ ...base, ...waits, blockedSince: 5 })?.blockedSince, 5);
	assert.equal(parsePresence({ ...base, ...waits, blockedSince: Date.now() + 3_600_000 })?.blockedSince, undefined);
	assert.equal(parsePresence({ ...base, ...waits, blockedSince: "5" })?.blockedSince, undefined);
	assert.equal(parsePresence({ ...base, blockedSince: 5 })?.blockedSince, undefined, "an age without a wait is nothing");
});

// ---------------------------------------------------------------- waiting on you

test("board and brief: who waits on you, oldest first with their task; a brief names them without times", async (t) => {
	const time = clock(t);
	const proj = makeProject("p-waits-onyou");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	await c.tool({ action: "status", message: `drafting the migration ${"x".repeat(100)}`, waitingFor: ["alpha"] });
	time.jump(2 * 3_600_000);
	await b.tool({ action: "status", message: "writing the api", waitingFor: ["alpha"] });
	time.jump(48 * 60_000);
	await eventually(() => assert.deepEqual(published(c)?.blockedOn, [a.id]));
	const board = (await a.tool({ action: "board" })).text;
	const line = /^Waiting on you: (.*)$/m.exec(board)?.[1] ?? "";
	assert.match(line, /^charlie 3h — drafting the migration x+…?; bravo 48m — writing the api$/);
	assert.ok(!/x{61}/.test(line), "the task is clipped");
	assert.doesNotMatch((await b.tool({ action: "board" })).text, /Waiting on you/, "nobody waits on bravo");
	const brief = (await a.prompt("start the work"))?.message?.content ?? "";
	assert.match(brief, /Waiting on you: (bravo, charlie|charlie, bravo)\. Give each what it needs: telecom\(\{ action: "send", to: "(bravo|charlie)", message: "…", unblocks: true \}\)\./);
	assert.doesNotMatch(brief.split("\n").find((l: string) => l.startsWith("Waiting on you")) ?? "", /\d+[smhd]\b/, "a clock must not make news");
});

// ---------------------------------------------------------------- cycles

test("cycles: told, with a wake-up, only once everyone on one has been idle five minutes; once per stall", async (t) => {
	const time = clock(t);
	const proj = makeProject("p-waits-stall");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "need bravo's schema", waitingFor: ["bravo"] });
	const closing = await b.tool({ action: "status", message: "need alpha's API", waitingFor: ["alpha"] });
	assert.match(closing.text, /This closes a wait cycle: bravo → alpha → bravo\./);
	assert.match(closing.text, /telecom\(\{ action: "send", to: "alpha", message: "…", unblocks: true \}\)/);
	await sleep(150); // several team refreshes: idle, but not for long
	assert.equal(stalls(a).length + stalls(b).length, 0, "a fresh cycle is not a stall");
	// One side is busy writing the go-ahead: that is no stall, however long it takes.
	await b.prompt("write the go-ahead");
	time.jump(6 * 60_000);
	await sleep(150);
	assert.equal(stalls(a).length + stalls(b).length, 0, "a busy member is not stalled");
	await b.settle();
	await sleep(150);
	assert.equal(stalls(a).length + stalls(b).length, 0, "idle again, but not for five minutes");
	time.jump(6 * 60_000);
	await eventually(() => assert.equal(stalls(a).length, 1));
	await eventually(() => assert.equal(stalls(b).length, 1));
	const note = stalls(a)[0];
	assert.match(note?.content ?? "", /Wait cycle stalled: alpha → bravo → alpha/);
	assert.match(note?.content ?? "", /everyone on it has been idle for \d+m or more, so nobody moves unless you do/);
	assert.match(note?.content ?? "", /telecom\(\{ action: "send", to: "bravo", message: "…", unblocks: true \}\)/);
	assert.deepEqual(note?.options, { triggerTurn: true }, "news about a wait the agent declared wakes it");
	await sleep(200);
	assert.equal(stalls(a).length, 1, "one stall is told once");
	assert.equal(stalls(b).length, 1);
	// A new idle spell is a new stall.
	await a.prompt("one more try");
	await a.settle();
	time.jump(6 * 60_000);
	await eventually(() => assert.equal(stalls(a).length, 2));
	await eventually(() => assert.equal(stalls(b).length, 2));
	// Dropping a wait ends the cycle: nothing more to tell.
	await a.tool({ action: "status", waitingFor: [] });
	time.jump(6 * 60_000);
	await sleep(200);
	assert.equal(stalls(a).length, 2);
});
