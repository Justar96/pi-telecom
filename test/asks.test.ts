/**
 * Asks against the real extension. An ask never blocks: it returns at once, and the answer
 * arrives as a reply message that wakes the asker (`ledger.ts`).
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

test("ask: an older peer blocked in an ask on this agent shows on the board, and a message to it is said to wait", async () => {
	const proj = makeProject("p-old-wait");
	const a = await session(proj);
	const net = openTransport(process.env.PI_TELECOM_DIR as string);
	const me = recordOf(a);
	assert.ok(me);
	const id = "00000000-0000-4000-8000-0000000old08";
	net.writePresence({ ...me, id, callsign: "zulu", state: "busy", waitingOn: [a.id], waitingSince: Date.now() - 40_000, claims: [], recent: [], startedAt: Date.now(), heartbeatAt: Date.now() });
	await eventually(async () => assert.match((await a.tool({ action: "board" })).text, /zulu \[busy, waiting on you \(asked 40s ago\)\]/));
	const sent = await a.tool({ action: "send", to: "zulu", message: "here is the schema" });
	assert.match(sent.text, /busy waiting on your answer — it reads this after you answer/);
	net.removePresence(id);
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

test("ask: returns at once, publishes no wait, and the answer arrives as a reply that wakes", async () => {
	const proj = makeProject("p-async");
	const a = await session(proj);
	const b = await session(proj);
	const raw = await a.tools.get("telecom")?.execute("call-async", { action: "ask", to: "bravo", message: "tell me when the suite is green" });
	assert.deepEqual(raw.structuredContent, raw.details);
	const result = { text: String(raw.content[0].text), details: raw.details, isError: raw.isError === true };
	assert.equal(result.isError, false, result.text);
	assert.match(result.details.askId, /^ask-/);
	assert.match(result.text, /^asked bravo \(idle — this wakes them\) — handle ask-\S+\nCarry on with other work: the answer arrives as a message and wakes you; if none comes within 1800s, you are told\.$/);
	assert.deepEqual(recordOf(a)?.waitingOn, [], "no wait-for edge: older peers read it as not waiting");
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const ask = b.sentOf("telecom-ask")[0];
	assert.match(ask?.content ?? "", /^\*\*📡 Ask from alpha\*\* — they get your reply when you send it/);
	assert.doesNotMatch(ask?.content ?? "", /blocked/);
	assert.deepEqual(ask?.options, { triggerTurn: true }, "an ask wakes its peer");
	await b.tool({ action: "reply", askId: lastAskId(b), message: "green" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	const reply = a.sentOf("telecom-reply")[0];
	assert.match(reply?.content ?? "", /^\*\*📡 Reply from bravo\*\* to your ask "tell me when the suite is green"\n\ngreen$/);
	assert.equal(reply?.options?.triggerTurn, true, "the answer wakes the asker");
	assert.equal(await b.settle(), undefined, "answered: nothing owed");
	// How an ask works is said once per context.
	const again = await a.tool({ action: "ask", to: "bravo", message: "and the docs?" });
	assert.match(again.text, /^asked bravo \([^)]*\) — handle ask-\S+$/);
});

test("ask: an older peer's ask (no `async`) is shown as blocking its asker", async () => {
	const proj = makeProject("p-old-ask");
	const b = await session(proj);
	const net = openTransport(process.env.PI_TELECOM_DIR as string);
	assert.ok(net.deliver({ v: WIRE_VERSION, id: "ask-old-1", ts: Date.now(), from: "old", fromCallsign: "zulu", to: b.id, kind: "ask", text: "which schema?" } as never).ok);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	assert.match(b.sentOf("telecom-ask")[0]?.content ?? "", /^\*\*📡 Ask from zulu\*\* — they are blocked until you reply/);
});

test("ask: an expired one is reported passively, and a later answer still arrives", async () => {
	const proj = makeProject("p-async-expire");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "slow one", timeoutSec: 0.1 });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	const notice = a.sentOf("telecom-reply")[0];
	assert.match(notice?.content ?? "", /^\*\*📡 bravo did not answer your ask\*\* "slow one"/);
	assert.match(notice?.content ?? "", /telecom\(\{ action: "ask", to: "bravo", message: "…" \}\)/);
	assert.equal(notice?.options, undefined, "passive: it never wakes the asker");
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "done now" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 2));
	assert.match(a.sentOf("telecom-reply")[1]?.content ?? "", /^\*\*📡 Reply from bravo\*\* to your ask "slow one"\n\ndone now$/);
});

test("ask: one open over a /reload still expires with its notice in the new runtime", async () => {
	const proj = makeProject("p-async-reload");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "tell me when merged", timeoutSec: 0.5 });
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

test("ask: /telecom off withdraws it from the peer's to-do list", async () => {
	const proj = makeProject("p-async-off");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "when you're done" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await a.command("off");
	await eventually(() => assert.ok(b.sentOf("telecom-reply").some((m) => /withdrew their ask/.test(m.content))));
	assert.equal(await b.settle(), undefined, "no reminder for a withdrawn ask");
});

test("ask: the peer leaving is reported passively", async () => {
	const proj = makeProject("p-async-gone");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "report back" });
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
