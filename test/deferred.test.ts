/**
 * Deferred messages (`send` with `interrupt: false`): held by a busy recipient until its run ends,
 * read through `agent_before_settle` when the run can go on, and delivered as an idle wake-up when
 * it cannot. An idle recipient and an older peer see an ordinary message.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseEnvelope, WIRE_VERSION } from "../src/transport.ts";
import { eventually, makeProject, type Session, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

/** A busy session: a run is going on. */
function busy(s: Session): void {
	s.ctx.isIdle = () => false;
}

/** A run has started, and `watcher` has seen the record say so (its hint to a sender depends on it). */
async function running(s: Session, watcher: Session): Promise<void> {
	busy(s);
	await s.prompt("work on the schema migration");
	await eventually(async () => assert.match((await watcher.tool({ action: "board" })).text, /\[busy/));
}

/** A plain message that arrives after everything `from` sent `to` before it: the inbox is in order. */
async function fence(from: Session, to: Session, text: string): Promise<void> {
	await from.tool({ action: "send", to: to.id, message: text });
	await eventually(() => assert.ok(to.sentOf("telecom-message").some((m) => m.content.includes(text))));
}

const defer = { interrupt: false } as const;

test("deferred: a busy recipient holds it, and reads it with the run's last step, in order", async () => {
	const proj = makeProject("p-deferred-busy");
	const a = await session(proj);
	const b = await session(proj);
	await running(b, a);
	const sent = await a.tool({ action: "send", to: "bravo", message: "first report", ...defer });
	assert.equal(sent.isError, false, sent.text);
	assert.match(sent.text, /busy — it reaches them when their current run ends/);
	await a.tool({ action: "send", to: "bravo", message: "second report", ...defer });
	await fence(a, b, "urgent, plain");
	// Only the plain message was steered in; the two reports wait.
	assert.equal(b.sentOf("telecom-message").length, 1);
	const settled = await b.settle();
	assert.equal(settled.continue, true);
	assert.deepEqual(
		settled.entries.map((e: { content: string }) => e.content.match(/first report|second report/)?.[0]),
		["first report", "second report"],
	);
	assert.equal(settled.entries[0].type, "custom_message");
	assert.equal(settled.entries[0].customType, "telecom-message");
	assert.match(settled.entries[0].content, /^\*\*📡 Message from alpha\*\*\n\nfirst report\n\n\(Reply only if needed: action "send", to "alpha"\.\)$/);
	assert.equal(settled.entries[0].details.fromCallsign, "alpha");
	// Delivered once: nothing is left for the next settle or for agent_settled.
	assert.equal(b.sentOf("telecom-message").length, 1);
	assert.equal(await b.settle(), undefined);
	assert.equal(b.sentOf("telecom-message").length, 1);
});

test("deferred: the default still steers in, and an idle recipient is woken as before", async () => {
	const proj = makeProject("p-deferred-default");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	await a.tool({ action: "send", to: "bravo", message: "interrupting" });
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	assert.equal(b.sentOf("telecom-message")[0]?.options, undefined, "steered into the run");
	b.ctx.isIdle = () => true;
	const sent = await a.tool({ action: "send", to: "bravo", message: "idle report", ...defer });
	assert.match(sent.text, /idle — this wakes them/);
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 2));
	assert.equal(b.sentOf("telecom-message")[1]?.options?.triggerTurn, true);
	assert.equal(await b.settle(), undefined, "nothing was held");
});

test("deferred: it joins the reminder of an ask still owed in one continuation", async () => {
	const proj = makeProject("p-deferred-reminder");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	await a.tool({ action: "ask", to: "bravo", message: "which schema?", wait: false });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await a.tool({ action: "send", to: "bravo", message: "a report", ...defer });
	await fence(a, b, "plain fence");
	const settled = await b.settle();
	assert.equal(settled.continue, true);
	assert.equal(settled.entries.length, 2);
	assert.match(settled.entries[0].content, /Message from alpha\*\*\n\na report/);
	assert.match(settled.entries[1].content, /1 ask still waiting for your reply/);
});

test("deferred: a run that cannot continue delivers it as an idle wake-up when it settles", async () => {
	const proj = makeProject("p-deferred-noncontinue");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	await a.tool({ action: "send", to: "bravo", message: "report one", ...defer });
	await a.tool({ action: "send", to: "bravo", message: "report two", ...defer });
	await fence(a, b, "plain fence");
	const before = b.sentOf("telecom-message").length;
	// pi cannot go on (an abort, or nothing to continue with): the boundary adds nothing.
	for (const [outcome, canContinue] of [["aborted", true], ["completed", false]] as const) {
		const result = await b.fire("agent_before_settle", { entries: [], continue: false, outcome, context: { canContinue } });
		assert.equal(result, undefined);
	}
	assert.equal(b.sentOf("telecom-message").length, before, "held until the run has settled");
	b.ctx.isIdle = () => true;
	await b.fire("agent_settled", { aborted: true });
	const delivered = b.sentOf("telecom-message").slice(before);
	assert.equal(delivered.length, 2);
	assert.match(delivered[0]?.content ?? "", /report one/);
	assert.match(delivered[1]?.content ?? "", /report two/);
	assert.equal(delivered[0]?.options, undefined, "appended: one turn reads them all");
	assert.equal(delivered[1]?.options?.triggerTurn, true, "the last one starts it");
	await b.fire("agent_settled", { aborted: false });
	assert.equal(b.sentOf("telecom-message").length, before + 2, "delivered once");
});

test("deferred: over the cap the oldest is steered in at once, none is dropped", async () => {
	const proj = makeProject("p-deferred-cap");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	const total = 14;
	for (let i = 1; i <= total; i++) await a.tool({ action: "send", to: "bravo", message: `report ${i}`, ...defer });
	await eventually(() => assert.ok(b.sentOf("telecom-message").length >= 2));
	const early = b.sentOf("telecom-message");
	assert.equal(early.length, 2);
	assert.match(early[0]?.content ?? "", /report 1\b/);
	assert.equal(early[0]?.options, undefined, "steered into the run, not woken");
	const settled = await b.settle();
	const rest = settled.entries.map((e: { content: string }) => e.content.match(/report (\d+)/)?.[1]);
	assert.deepEqual(rest, Array.from({ length: total - 2 }, (_, i) => String(i + 3)));
});

test("deferred: a message from the peer a blocking ask waits on is held with that ask, not deferred", async () => {
	const proj = makeProject("p-deferred-ask-hold");
	const a = await session(proj);
	const b = await session(proj);
	busy(a);
	const pending = a.tool({ action: "ask", to: "bravo", message: "may I continue?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "send", to: "alpha", message: "a note before the answer", ...defer });
	const askId = b.sentOf("telecom-ask")[0]?.details.askId as string;
	await b.tool({ action: "reply", askId, message: "yes" });
	const result = await pending;
	assert.match(result.text, /a note before the answer/);
	assert.equal(await a.settle(), undefined, "the note was shown with the answer, and is not delivered again");
});

test("deferred: leaving hands what is held to pi's queue for the next run", async () => {
	const proj = makeProject("p-deferred-leave");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	await a.tool({ action: "send", to: "bravo", message: "held at the end", ...defer });
	await fence(a, b, "plain fence");
	assert.equal(b.sentOf("telecom-message").length, 1);
	await b.stop("reload");
	const queued = b.sentOf("telecom-message").slice(1);
	assert.equal(queued.length, 1);
	assert.match(queued[0]?.content ?? "", /held at the end/);
	assert.deepEqual(queued[0]?.options, { deliverAs: "nextTurn" });
});

test("deferred: /telecom off hands what is held to pi's queue", async () => {
	const proj = makeProject("p-deferred-off");
	const a = await session(proj);
	const b = await session(proj);
	busy(b);
	await a.tool({ action: "send", to: "bravo", message: "held at off", ...defer });
	await fence(a, b, "plain fence");
	await b.command("off");
	const queued = b.sentOf("telecom-message").filter((m) => m.options?.deliverAs === "nextTurn");
	assert.equal(queued.length, 1);
	assert.match(queued[0]?.content ?? "", /held at off/);
});

test("wire: defer is kept only as true on a message", () => {
	const base = { v: WIRE_VERSION, id: "m1", ts: 1, from: "a", to: "b", text: "x" };
	assert.equal(parseEnvelope({ ...base, kind: "message", defer: true })?.defer, true);
	assert.equal(parseEnvelope({ ...base, kind: "message", defer: "yes" })?.defer, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message", defer: 1 })?.defer, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message" })?.defer, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "broadcast", defer: true })?.defer, undefined);
});
