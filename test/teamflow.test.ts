/**
 * teamflow — how telecom reads in a team of more than two: one message to several teammates,
 * replies that reach whom they name, updates without lock churn, and lane notes that name the
 * right checkout (and stay quiet about a worktree claimed whole).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, type TestContext, test } from "node:test";
import { renderBrief, TASK_ONLY_HOLD_MS } from "../src/board.ts";
import { findRepo } from "../src/project.ts";
import { openTransport, parseEnvelope, type Presence, WIRE_VERSION } from "../src/transport.ts";
import { withoutSelfName } from "../src/util.ts";
import { eventually, makeProject, makeWorktree, type Session, session, sleep, stopSessions } from "./harness.ts";

afterEach(stopSessions);

function published(s: Session): Presence | undefined {
	return openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === s.id);
}

/** A clock `ms` ahead from now on (for this test): how a task set long ago looks. */
function ahead(t: TestContext, ms: number): void {
	const real = Date.now;
	t.mock.method(Date, "now", () => real() + ms);
}

test("send: one message to several teammates reaches each, and each sees who else got it", async () => {
	const proj = makeProject("p-flow-group");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const d = await session(proj);
	const sent = await a.tool({ action: "send", to: "bravo, charlie", message: "joint review: is B1 cleared?" });
	assert.ok(!sent.isError, sent.text);
	assert.match(sent.text, /^sent to bravo \([^)]*\); charlie \([^)]*\)\. Each sees who else got it\./);
	assert.deepEqual(sent.details.reached, ["bravo", "charlie"]);
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	await eventually(() => assert.equal(c.sentOf("telecom-message").length, 1));
	const toBravo = b.sentOf("telecom-message")[0]?.content ?? "";
	assert.match(toBravo, /Message from alpha — also to charlie\*\*/);
	assert.match(toBravo, /to "alpha", or "alpha, charlie" for all of them/);
	assert.match(c.sentOf("telecom-message")[0]?.content ?? "", /Message from alpha — also to bravo\*\*/);
	await sleep(100);
	assert.equal(d.sentOf("telecom-message").length, 0, "only the named teammates get it");
	// One name that answers to nobody: nothing goes out, so nobody reads half a thread.
	const bad = await a.tool({ action: "send", to: "bravo, zulu", message: "again" });
	assert.ok(bad.isError);
	assert.match(bad.text, /no live agent answers to "zulu".*Nothing was sent\./);
	await sleep(100);
	assert.equal(b.sentOf("telecom-message").length, 1);
	// A single name reads as it always did.
	const one = await a.tool({ action: "send", to: "delta", message: "solo" });
	assert.equal(one.details.to, "delta");
	await eventually(() => assert.equal(d.sentOf("telecom-message").length, 1));
	assert.doesNotMatch(d.sentOf("telecom-message")[0]?.content ?? "", /also to/);
});

test("reply: `to` picks that teammate's ask, and with none open goes as a message, never to another asker", async () => {
	const proj = makeProject("p-flow-reply");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const asked = await c.tool({ action: "ask", to: "alpha", message: "is the gate green?", wait: false });
	assert.ok(!asked.isError, asked.text);
	await eventually(() => assert.equal(a.sentOf("telecom-ask").length, 1));
	// alpha means bravo: before, the one open ask (charlie's) took the answer.
	const toBravo = await a.tool({ action: "reply", to: "bravo", message: "hold the sign-off" });
	assert.ok(!toBravo.isError, toBravo.text);
	assert.match(toBravo.text, /^no ask from bravo was waiting, so this went as a message: sent to bravo/);
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	assert.match(b.sentOf("telecom-message")[0]?.content ?? "", /hold the sign-off/);
	await sleep(100);
	assert.equal(c.sentOf("telecom-reply").length, 0, "charlie's ask got no answer meant for bravo");
	// Naming the asker answers its ask.
	const toCharlie = await a.tool({ action: "reply", to: "charlie", message: "green" });
	assert.match(toCharlie.text, /^replied to charlie/);
	await eventually(() => assert.equal(c.sentOf("telecom-reply").length, 1));
});

test("briefs: taking and releasing a lock is not team news; queuing for your own lock is", async () => {
	const proj = makeProject("p-flow-locks");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("the build");
	assert.ok((await a.prompt("work"))?.message?.content, "the first brief");
	await b.tool({ action: "claim", paths: ["@cargo"], message: "nextest" });
	await b.tool({ action: "claim", paths: ["src/build/**"], message: "build rework" });
	const update = (await a.prompt("more"))?.message?.content ?? "";
	assert.match(update, /• bravo claimed src\/build\/\*\*/);
	assert.doesNotMatch(update, /@cargo/);
	await b.tool({ action: "release", paths: ["@cargo"] });
	assert.equal(await a.prompt("again"), undefined, "a released lock alone makes no update");
	// alpha holds a lock and bravo lines up for it: alpha is told, to release it soon.
	await a.tool({ action: "claim", paths: ["@runtime"], message: "e2e" });
	const queued = await b.tool({ action: "claim", paths: ["@runtime"], queue: true });
	assert.ok(!queued.isError, queued.text);
	await eventually(async () => assert.match((await a.prompt("next"))?.message?.content ?? "", /• bravo queued for @runtime \(yours\)/));
});

test("lanes: a lane note names the checkout the file lies in, not where its editor started", async () => {
	const proj = makeProject("p-flow-lane-place");
	const wt = makeWorktree(proj, "wb", "lane-b");
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "src", "y.ts"), "y\n");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "claim", paths: ["src/**"], message: "auth rewrite" });
	const file = join(wt, "src", "y.ts");
	await b.read(file);
	const edit = await b.edit(file, "y", "Y");
	assert.equal(edit.blocked, undefined, "another lane is never held back");
	await eventually(() => assert.equal(a.sentOf("telecom-claim").length, 1));
	const notice = a.sentOf("telecom-claim")[0]?.content ?? "";
	assert.match(notice, /bravo edited src\/y\.ts in worktree [^\n]*wb, inside your claim "src\/\*\*"/);
	assert.doesNotMatch(notice, /in the main checkout/);
});

test("lanes: a worktree claimed whole is that copy, so edits and claims in other checkouts get no merge note", async () => {
	const proj = makeProject("p-flow-whole-wt");
	const wt = makeWorktree(proj, "wa", "lane-a");
	mkdirSync(join(proj, "src"), { recursive: true });
	writeFileSync(join(proj, "src", "y.ts"), "y\n");
	const a = await session(proj);
	const b = await session(proj);
	const claimed = await a.tool({ action: "claim", paths: [join(wt, "**")], message: "my worktree" });
	assert.ok(!claimed.isError, claimed.text);
	await b.read("src/y.ts");
	const edit = await b.edit("src/y.ts", "y", "Y");
	assert.equal(edit.blocked, undefined);
	assert.doesNotMatch(edit.note ?? "", /alpha's claim/);
	const claim = await b.tool({ action: "claim", paths: ["src/y.ts"] });
	assert.ok(!claim.isError, claim.text);
	assert.doesNotMatch(claim.text, /overlaps alpha's claim/);
	await sleep(150);
	assert.equal(a.sentOf("telecom-claim").length, 0, "alpha is not told about a copy it never claimed");
	// Inside the claimed worktree the claim binds as before.
	mkdirSync(join(wt, "src"), { recursive: true });
	writeFileSync(join(wt, "src", "z.ts"), "z\n");
	await b.read(join(wt, "src", "z.ts"));
	assert.match((await b.edit(join(wt, "src", "z.ts"), "z", "Z")).blocked ?? "", /inside alpha's claim "\*\* \(in [^)]*wa\)"/);
});

test("wire: a message's group is peer data — callsigns only, capped, and only on messages", () => {
	const id = (n: number) => `0000000${n}-0000-7000-8000-000000000000`;
	const base = { v: WIRE_VERSION, id: "m-1", ts: Date.now(), from: id(1), fromCallsign: "alpha", to: id(2), text: "hi" };
	const group = ["bravo", "charlie", "Not A Callsign\n", 7, ...Array.from({ length: 12 }, (_, i) => `x${i}`)];
	assert.deepEqual(parseEnvelope({ ...base, kind: "message", group })?.group, ["bravo", "charlie", "x0", "x1", "x2", "x3"]);
	assert.equal(parseEnvelope({ ...base, kind: "message", group: ["bravo"] })?.group, undefined, "a group of one is a plain message");
	assert.equal(parseEnvelope({ ...base, kind: "broadcast", group: ["bravo", "charlie"] })?.group, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message", group: "bravo, charlie" })?.group, undefined);
});

test("waits: a wait that ends by itself says so, with the task peers see and the call to keep waiting", async () => {
	const proj = makeProject("p-flow-wait-ended");
	writeFileSync(join(proj, "notes.md"), "n\n");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	await a.tool({ action: "status", message: "waiting for golf's verdict", waitingFor: ["bravo", "charlie"] });
	await b.tool({ action: "send", to: "alpha", message: "verdict: not cleared, fix B1" });
	await eventually(() => assert.equal(a.sentOf("telecom-message").length, 1));
	await a.read("notes.md");
	await a.edit("notes.md", "n", "fixing B1");
	await eventually(() => assert.deepEqual(published(a)?.blockedOn, [c.id]));
	await eventually(() => assert.ok(a.sentOf("telecom-message").some((m) => /Your wait on bravo ended/.test(m.content))));
	const told = a.sentOf("telecom-message").find((m) => /Your wait on bravo ended/.test(m.content));
	assert.match(told?.content ?? "", /You still wait for charlie\. Peers see your task as "waiting for golf's verdict"; if it says you wait, update it/);
	assert.match(told?.content ?? "", /telecom\(\{ action: "status", waitingFor: \["charlie","bravo"\] \}\)/);
	assert.equal(told?.options, undefined, "information: no turn of its own");
});

test("waits: a run that ended with a message to the waiter wakes it once, with the message", async () => {
	const proj = makeProject("p-flow-wait-once");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("run the gate");
	await a.tool({ action: "status", message: "waiting for the gate", waitingFor: ["bravo"] });
	await sleep(100); // the wait has seen bravo busy
	await b.tool({ action: "send", to: "alpha", message: "gate is red: lint" });
	await b.settle();
	await eventually(() => assert.ok(a.sentOf("telecom-message").some((m) => /gate is red/.test(m.content))));
	await sleep(200);
	assert.ok(!a.sentOf("telecom-message").some((m) => /finished its run/.test(m.content)), "no second wake-up for the same run");
	// A run that ends without a word still wakes the waiter.
	await b.prompt("rerun the gate");
	await sleep(100);
	await b.settle();
	await eventually(() => assert.ok(a.sentOf("telecom-message").some((m) => /bravo finished its run \(task: rerun the gate\)/.test(m.content))));
});

test("waits: a wait cycle is pointed out once, not on every status that keeps it", async () => {
	const proj = makeProject("p-flow-cycle-once");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "need bravo's freeze", waitingFor: ["bravo"] });
	const first = await b.tool({ action: "status", message: "need alpha's review", waitingFor: ["alpha"] });
	assert.match(first.text, /This closes a wait cycle: bravo → alpha → bravo\./);
	const again = await b.tool({ action: "status", message: "still need alpha's review", waitingFor: ["alpha"] });
	assert.doesNotMatch(again.text, /closes a wait cycle/);
	assert.match(again.text, /waiting for alpha/);
});

test("claim: a path claim long after the task was set shows the task peers see, once", async (t) => {
	const proj = makeProject("p-flow-stale-task");
	const a = await session(proj);
	await session(proj);
	await a.tool({ action: "status", message: "D3 HOLD: no verdict yet" });
	const fresh = await a.tool({ action: "claim", paths: ["src/a.ts"] });
	assert.doesNotMatch(fresh.text, /Peers still see your task/, "a task set just now is current");
	ahead(t, 5 * 60_000);
	const later = await a.tool({ action: "claim", paths: ["src/fixture.ts"], message: "B1 test-only fix" });
	assert.match(later.text, /Peers still see your task as "D3 HOLD: no verdict yet" \(set 5m ago\)\. If this claim starts other work, say so: telecom\(\{ action: "status", message: "…" \}\)\./);
	assert.doesNotMatch((await a.tool({ action: "claim", paths: ["src/b.ts"] })).text, /Peers still see your task/, "once per task");
	assert.doesNotMatch((await a.tool({ action: "claim", paths: ["@cargo"] })).text, /Peers still see your task/, "a lock is not new work");
});

test("status and messages: a leading own callsign is dropped; peers already see who wrote it", async () => {
	const proj = makeProject("p-flow-self-name");
	const a = await session(proj);
	const b = await session(proj);
	const set = await a.tool({ action: "status", message: "alpha: B2 done, standby" });
	assert.match(set.text, /peers now see alpha: B2 done, standby$/);
	await a.tool({ action: "send", to: "bravo", message: "alpha → bravo: the freeze is on" });
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	assert.match(b.sentOf("telecom-message")[0]?.content ?? "", /\*\*\n\nthe freeze is on\n/);
	assert.equal(withoutSelfName("alpha → golf, three verdicts:", "alpha"), "three verdicts:");
	assert.equal(withoutSelfName("alpha → bravo and delta: go", "alpha"), "go");
	assert.equal(withoutSelfName("alpha (lead): plan", "alpha"), "alpha (lead): plan", "anything else is kept");
	assert.equal(withoutSelfName("alphabet: soup", "alpha"), "alphabet: soup");
	assert.equal(withoutSelfName("alpha:", "alpha"), "alpha:", "nothing left: kept whole");
});

test("briefs: an agent editing two checkouts by turns is one move, not one per turn", () => {
	const proj = makeProject("p-flow-lane-set");
	const wt = makeWorktree(proj, "wb", "lane-b");
	const peer = (id: string, recent: Presence["recent"] = []): Presence => ({
		v: 1, id, callsign: id, pid: process.pid, ticks: null, cwd: proj, projectRoot: proj, repo: findRepo(proj), role: "main",
		state: "busy", task: "port", claims: [], recent, startedAt: 1, heartbeatAt: Date.now(),
	});
	const me = peer("alpha");
	const old = Date.now() - TASK_ONLY_HOLD_MS - 1;
	const notes = { path: join(proj, "notes.md"), op: "edit" as const };
	const code = { path: join(wt, "src", "x.ts"), op: "edit" as const };
	const first = renderBrief(me, [me, peer("bravo", [{ ...notes, at: 1 }])], null);
	const moved = renderBrief(me, [me, peer("bravo", [{ ...code, at: 3 }, { ...notes, at: 2 }])], { ...first.state, toldAt: old });
	assert.match(moved.text ?? "", /• bravo now works on lane-b in worktree [^\n]*wb$/m);
	// Notes again: the newest edit is back in the main checkout, but it works in the same two.
	const back = renderBrief(me, [me, peer("bravo", [{ ...notes, at: 4 }, { ...code, at: 3 }])], { ...moved.state, toldAt: old });
	assert.equal(back.text, null, "editing by turns is no news");
});
