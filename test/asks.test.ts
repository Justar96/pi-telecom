/**
 * Asks against the real extension: a peer's messages held while an ask to it waits (so the
 * answer, which comes back as the ask's tool result, never overtakes them), and asks that do not
 * block (`wait: false`).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openTransport, parseEnvelope, WIRE_VERSION } from "../src/transport.ts";
import { eventually, makeProject, SCRATCH, Session, session, stopSessions, track } from "./harness.ts";

afterEach(stopSessions);

/** The handle of the ask `s` was last shown. */
function lastAskId(s: Session): string {
	return String(s.sentOf("telecom-ask").at(-1)?.details.askId);
}

/** `s`'s presence record as peers read it. */
function recordOf(s: Session) {
	return openTransport(process.env.PI_TELECOM_DIR as string)
		.readPeers()
		.find((p) => p.id === s.id);
}

/**
 * Send a broadcast from `from` and wait until `to` has it. Envelopes are drained in the order
 * they were sent, so everything `from` sent `to` before it has been handled by then.
 */
async function fence(from: Session, to: Session, tag: string): Promise<void> {
	await from.tool({ action: "broadcast", message: tag });
	await eventually(() => assert.ok(to.sentOf("telecom-broadcast").some((m) => m.content.includes(tag))));
}

// ------------------------------------------------------------------ held messages

test("held: a message sent before the answer is shown ahead of it in the ask's result, and not delivered again", async () => {
	const proj = makeProject("p-held-answer");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "may I continue the launch?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	// Sent back to back, as in the incident: all three are in alpha's inbox before its next drain,
	// so this also checks that the drain handles them in the order they were sent.
	await b.tool({ action: "send", to: "alpha", message: "authorize launch continuation" });
	await b.tool({ action: "send", to: "alpha", message: "use the staging pad" });
	await b.tool({ action: "reply", askId: lastAskId(b), message: "stop before launch" });
	const result = await pending;
	assert.equal(result.isError, false, result.text);
	const text = result.text;
	assert.match(text, /^bravo answered\. Before answering, bravo sent you 2 messages/);
	const first = text.indexOf("authorize launch continuation");
	const second = text.indexOf("use the staging pad");
	const answer = text.indexOf("stop before launch");
	assert.ok(first > 0 && first < second && second < answer, `send order, then the answer last:\n${text}`);
	assert.match(text, /Message 1 of 2 from bravo\*\* \(sent before the answer\)/);
	assert.match(text, /\*\*bravo's answer\*\* \(newest\):\n\nstop before launch$/);
	assert.equal(result.details.heldMessages.length, 2);
	// Nothing reaches alpha twice: the held messages were shown in the result only.
	await fence(b, a, "after the answer");
	assert.equal(a.sentOf("telecom-message").length, 0);
});

test("held: a message after the answer, and a broadcast while waiting, are not held", async () => {
	const proj = makeProject("p-held-not");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "which port?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await fence(b, a, "a broadcast is news for everyone");
	await b.tool({ action: "reply", askId: lastAskId(b), message: "8080" });
	await b.tool({ action: "send", to: "alpha", message: "and after the answer" });
	const result = await pending;
	assert.match(result.text, /^bravo answered:\n\n8080$/);
	await eventually(() => assert.equal(a.sentOf("telecom-message").length, 1));
	assert.match(a.sentOf("telecom-message")[0]?.content ?? "", /and after the answer/);
});

test("held: an aborted ask delivers what the peer sent meanwhile as ordinary messages, in order, once", async () => {
	const proj = makeProject("p-held-abort");
	const a = await session(proj);
	const b = await session(proj);
	const controller = new AbortController();
	const pending = a.tool({ action: "ask", to: "bravo", message: "ready?" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "send", to: "alpha", message: "first" });
	await b.tool({ action: "send", to: "alpha", message: "second" });
	await fence(b, a, "fence");
	assert.equal(a.sentOf("telecom-message").length, 0, "held while the ask waits");
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	const messages = a.sentOf("telecom-message");
	assert.deepEqual(
		messages.map((m) => /\*\*\n\n(\w+)/.exec(m.content)?.[1]),
		["first", "second"],
	);
	assert.match(messages[0]?.content ?? "", /^\*\*📡 Message from bravo\*\*/, "delivered as it would have been on arrival");
	await fence(b, a, "later");
	assert.equal(a.sentOf("telecom-message").length, 2, "delivered once");
});

test("held: an ask interrupted by a cycle ask delivers the held message", async (t) => {
	const proj = makeProject("p-held-cycle");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "A asks" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "send", to: "alpha", message: "context first" });
	await fence(b, a, "fence");
	assert.equal(a.sentOf("telecom-message").length, 0, "held while the ask waits");
	const controller = new AbortController();
	t.after(() => controller.abort());
	// bravo now asks alpha back: alpha already waits on bravo, so this closes a cycle.
	const back = b.tool({ action: "ask", to: "alpha", message: "B asks" }, controller.signal);
	const result = await pending;
	assert.equal(result.details.interrupted, true, result.text);
	await eventually(() => assert.equal(a.sentOf("telecom-message").length, 1));
	assert.match(a.sentOf("telecom-message")[0]?.content ?? "", /context first/);
	controller.abort();
	await back;
});

test("held: /telecom off while asking delivers the held message", async () => {
	const proj = makeProject("p-held-off");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "still on?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "send", to: "alpha", message: "before you go" });
	await fence(b, a, "fence");
	assert.equal(a.sentOf("telecom-message").length, 0, "held while the ask waits");
	await a.command("off");
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.text, /disconnected/);
	assert.equal(a.sentOf("telecom-message").length, 1);
	assert.match(a.sentOf("telecom-message")[0]?.content ?? "", /before you go/);
});

test("held: a /reload while asking delivers the held message before pi drops the old runtime", async () => {
	// pi's own /reload is refused while the agent streams, so a blocking ask (always mid-tool-call)
	// is open during a reload only when a host or an extension reloads mid-run. pi awaits
	// session_shutdown and only then invalidates the old runtime's API: the ask ends inside the
	// handler, and what it held is delivered before that.
	const proj = makeProject("p-held-reload");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "still on?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "send", to: "alpha", message: "before the reload" });
	await fence(b, a, "fence");
	assert.equal(a.sentOf("telecom-message").length, 0, "held while the ask waits");
	await a.stop("reload");
	assert.equal(a.sentOf("telecom-message").length, 1, "delivered by the time session_shutdown returns");
	assert.match(a.sentOf("telecom-message")[0]?.content ?? "", /before the reload/);
	a.disposed = true; // what pi does next
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.text, /reloaded while waiting/);
	const replacement = track(await new Session(proj, { id: a.id }).start("reload"));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "yes" });
	await eventually(() => assert.equal(replacement.sentOf("telecom-reply").length, 1));
	assert.match(replacement.sentOf("telecom-reply")[0]?.content ?? "", /Late reply from bravo\*\* to your ask "still on\?"/);
	assert.equal(replacement.sentOf("telecom-message").length, 0, "and not delivered twice");
});

test("held: of two asks to one peer, the one that ends unanswered passes its held messages to the other", async () => {
	const proj = makeProject("p-held-two");
	const a = await session(proj);
	const b = await session(proj);
	const controller = new AbortController();
	const older = a.tool({ action: "ask", to: "bravo", message: "first question" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const newer = a.tool({ action: "ask", to: "bravo", message: "second question" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 2));
	await b.tool({ action: "send", to: "alpha", message: "a heads-up" });
	await fence(b, a, "fence");
	controller.abort();
	assert.equal((await older).isError, true);
	assert.equal(a.sentOf("telecom-message").length, 0, "still held: the other ask still waits on bravo");
	await b.tool({ action: "reply", askId: lastAskId(b), message: "ship it" });
	const result = await newer;
	const heldAt = result.text.indexOf("a heads-up");
	assert.ok(heldAt > 0 && heldAt < result.text.indexOf("ship it"), result.text);
	await fence(b, a, "later");
	assert.equal(a.sentOf("telecom-message").length, 0);
});

test("drain: envelopes from one sender are handled in the order they were sent", () => {
	const net = openTransport(join(SCRATCH, "drain-order"));
	const sent: string[] = [];
	for (let i = 0; i < 40; i++) {
		const kind = i % 2 === 0 ? "message" : "answer";
		const id = `env-${i}`;
		sent.push(id);
		const env = { v: WIRE_VERSION, id, ts: Date.now(), from: "bravo", fromCallsign: "bravo", to: "alpha", kind, text: String(i), ...(kind === "answer" ? { answerTo: "ask-1" } : {}) };
		assert.ok(net.deliver(env as never).ok);
	}
	const got: string[] = [];
	net.drain("alpha", (env) => got.push(env.id));
	assert.deepEqual(got, sent);
});

// ------------------------------------------------------------------ asks that do not wait

test("async ask: returns at once, publishes no wait, and the answer arrives as a reply that wakes", async () => {
	const proj = makeProject("p-async");
	const a = await session(proj);
	const b = await session(proj);
	const raw = await a.tools.get("telecom")?.execute("call-async", { action: "ask", to: "bravo", message: "tell me when the suite is green", wait: false });
	assert.deepEqual(raw.structuredContent, raw.details);
	const result = { text: String(raw.content[0].text), details: raw.details, isError: raw.isError === true };
	assert.equal(result.isError, false, result.text);
	assert.equal(result.details.async, true);
	assert.match(result.details.askId, /^ask-/);
	assert.match(result.text, /You are not waiting/);
	assert.match(result.text, /within 1800s/, "the default for an ask that does not wait");
	assert.deepEqual(recordOf(a)?.waitingOn, [], "not a wait-for edge");
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const ask = b.sentOf("telecom-ask")[0];
	assert.match(ask?.content ?? "", /they are not waiting; they get your reply when you send it/);
	assert.doesNotMatch(ask?.content ?? "", /blocked/);
	assert.deepEqual(ask?.options, { triggerTurn: true }, "still delivered like any ask");
	await b.tool({ action: "reply", askId: lastAskId(b), message: "green" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	const reply = a.sentOf("telecom-reply")[0];
	assert.match(reply?.content ?? "", /^\*\*📡 Reply from bravo\*\* to your ask "tell me when the suite is green"\n\ngreen$/);
	assert.equal(reply?.options?.triggerTurn, true, "the answer wakes the asker");
	assert.equal(await b.settle(), undefined, "answered: nothing owed");
});

test("async ask: does not interrupt the receiver's own wait on the asker", async () => {
	const proj = makeProject("p-async-cycle");
	const a = await session(proj);
	const b = await session(proj);
	// bravo waits on alpha; alpha's async ask back closes no cycle, since alpha waits on nobody.
	const pending = b.tool({ action: "ask", to: "alpha", message: "which schema?" });
	await eventually(() => assert.equal(a.sentOf("telecom-ask").length, 1));
	const bravoAsk = lastAskId(a);
	assert.equal((await a.tool({ action: "ask", to: "bravo", message: "ping me when merged", wait: false })).isError, false);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await a.tool({ action: "reply", askId: bravoAsk, message: "v2" });
	const result = await pending;
	assert.equal(result.details.interrupted, undefined, result.text);
	assert.match(result.text, /alpha answered:\n\nv2/);
	// The async ask is still owed: the settle reminder lists it, without calling bravo's asker blocked.
	const reminder = await b.settle();
	assert.match(reminder.entries[0].content, /1 ask still waiting for your reply/);
	assert.match(reminder.entries[0].content, /from alpha \(not blocked\): ping me when merged/);
});

test("async ask: an expired one is reported passively, and a later answer still arrives", async () => {
	const proj = makeProject("p-async-expire");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "slow one", wait: false, timeoutSec: 0.1 });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	const notice = a.sentOf("telecom-reply")[0];
	assert.match(notice?.content ?? "", /^\*\*📡 bravo did not answer your ask\*\* "slow one"/);
	assert.match(notice?.content ?? "", /telecom\(\{ action: "ask", to: "bravo", message: "…", wait: false \}\)/);
	assert.equal(notice?.options, undefined, "passive: it never wakes the asker");
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "done now" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 2));
	assert.match(a.sentOf("telecom-reply")[1]?.content ?? "", /^\*\*📡 Reply from bravo\*\* to your ask "slow one"\n\ndone now$/);
});

test("async ask: one open over a /reload still expires with its notice in the new runtime", async () => {
	const proj = makeProject("p-async-reload");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "tell me when merged", wait: false, timeoutSec: 0.5 });
	await a.stop("reload");
	const replacement = track(await new Session(proj, { id: a.id }).start("reload"));
	await eventually(() => assert.equal(replacement.sentOf("telecom-reply").length, 1));
	const notice = replacement.sentOf("telecom-reply")[0];
	assert.match(notice?.content ?? "", /^\*\*📡 bravo did not answer your ask\*\* "tell me when merged"/);
	assert.equal(notice?.options, undefined, "passive, as without the reload");
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "merged" });
	await eventually(() => assert.equal(replacement.sentOf("telecom-reply").length, 2));
	assert.match(replacement.sentOf("telecom-reply")[1]?.content ?? "", /^\*\*📡 Reply from bravo\*\* to your ask "tell me when merged"\n\nmerged$/);
});

test("async ask: /telecom off withdraws it from the peer's to-do list", async () => {
	const proj = makeProject("p-async-off");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "when you're done", wait: false });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await a.command("off");
	await eventually(() => assert.ok(b.sentOf("telecom-reply").some((m) => /withdrew their ask/.test(m.content))));
	assert.equal(await b.settle(), undefined, "no reminder for a withdrawn ask");
});

test("async ask: the peer leaving is reported passively", async () => {
	const proj = makeProject("p-async-gone");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "report back", wait: false });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.stop();
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	const notice = a.sentOf("telecom-reply")[0];
	assert.match(notice?.content ?? "", /bravo did not answer your ask\*\* "report back"/);
	assert.match(notice?.content ?? "", /session ended before it answered/);
	assert.equal(notice?.options, undefined);
});

test("wire: `async` is kept only on an ask, and only as true", () => {
	const base = { v: WIRE_VERSION, id: "ask-1", ts: 1, from: "a", fromCallsign: "alpha", to: "b", text: "q" };
	assert.equal(parseEnvelope({ ...base, kind: "ask", async: true })?.async, true);
	assert.equal(parseEnvelope({ ...base, kind: "ask", async: "yes" })?.async, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "message", async: true })?.async, undefined);
	assert.equal(parseEnvelope({ ...base, kind: "ask" })?.async, undefined, "an older peer's ask blocks, as before");
});
