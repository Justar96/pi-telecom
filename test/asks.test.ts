/**
 * Asks against the real extension. An ask never blocks: it returns at once, and the answer
 * arrives as a reply message that wakes the asker (`ledger.ts`).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openTransport, parseEnvelope, WIRE_VERSION } from "../src/transport.ts";
import { eventually, makeProject, SCRATCH, Session, session, sleep, stopSessions, track } from "./harness.ts";

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

test("ask: naming several agents is refused with the call for each, and nothing is sent", async () => {
	const proj = makeProject("p-ask-several");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	await eventually(async () => assert.match((await a.tool({ action: "board" })).text, /charlie/));
	const asked = await a.tool({ action: "ask", to: "bravo, charlie", message: "who reviewed PR1?" });
	assert.equal(asked.isError, true);
	assert.equal(
		asked.text,
		'telecom: an ask goes to one agent, and each answer comes back on its own handle. Nothing was sent. Ask each: telecom({ action: "ask", to: "bravo", message: "…" }), telecom({ action: "ask", to: "charlie", message: "…" }). For one message they all read: telecom({ action: "send", to: "bravo, charlie", message: "…" }).',
	);
	await sleep(200);
	assert.equal(b.sentOf("telecom-ask").length + c.sentOf("telecom-ask").length, 0);
});

test("reply: the handle of an agent's own ask sends the text to whom the ask went, as a message", async () => {
	const proj = makeProject("p-reply-own");
	const a = await session(proj);
	const b = await session(proj);
	const asked = await a.tool({ action: "ask", to: "bravo", message: "review PR 12?" });
	const askId = String(asked.details.askId);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "one finding" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	// The ask is answered; the asker uses its handle to tell bravo more.
	const more = await a.tool({ action: "reply", askId, message: "fixed in the next commit" });
	assert.equal(more.isError, false, more.text);
	assert.match(more.text, new RegExp(`^"${askId}" is your own ask to bravo, so this went to them as a message: sent to bravo`));
	await eventually(() => assert.ok(b.sentOf("telecom-message").some((m) => /fixed in the next commit/.test(m.content))));
	assert.equal(b.sentOf("telecom-reply").length, 0, "not an answer to an ask bravo never made");
});

test("ask: several names are resolved as send resolves them: duplicates, the caller and a stray comma fall away", async () => {
	const proj = makeProject("p-ask-several-names");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	await eventually(async () => assert.match((await a.tool({ action: "board" })).text, /charlie/));
	for (const to of ["bravo, bravo", "bravo,", "@bravo, Bravo", "bravo, alpha"]) {
		const asked = await a.tool({ action: "ask", to, message: `one agent: ${to}` });
		assert.equal(asked.isError, false, `${to}: ${asked.text}`);
		assert.match(asked.text, /^asked bravo/);
	}
	const unknown = await a.tool({ action: "ask", to: "bravo, zulu", message: "x" });
	assert.equal(unknown.isError, true);
	assert.match(unknown.text, /no live agent answers to "zulu"[\s\S]*Nothing was sent\./);
	await sleep(200);
	assert.equal(b.sentOf("telecom-ask").length, 4);
	assert.equal(c.sentOf("telecom-ask").length, 0);
});

test("reply: an own ask's handle with `to` naming its peer goes as a message too; a peer that left is named, not its id", async () => {
	const proj = makeProject("p-reply-own-to");
	const a = await session(proj);
	const b = await session(proj);
	const askId = String((await a.tool({ action: "ask", to: "bravo", message: "review PR 12?" })).details.askId);
	const more = await a.tool({ action: "reply", askId, to: "bravo", message: "the head moved" });
	assert.match(more.text, new RegExp(`^"${askId}" is your own ask to bravo, so this went to them as a message`));
	await eventually(() => assert.ok(b.sentOf("telecom-message").some((m) => /the head moved/.test(m.content))));
	await b.stop();
	await eventually(async () => assert.doesNotMatch((await a.tool({ action: "board" })).text, /bravo/), 5_000);
	const gone = await a.tool({ action: "reply", askId, message: "still there?" });
	assert.equal(gone.isError, true);
	assert.equal(gone.text, `telecom: "${askId}" is your own ask to bravo, who is gone — their session ended, so nothing was sent. telecom({ action: "board" }) shows who is here.`);
});

test("reply: an own ask's handle still reaches its peer after a /reload", async () => {
	const proj = makeProject("p-reply-own-reload");
	const a = await session(proj);
	const b = await session(proj);
	const askId = String((await a.tool({ action: "ask", to: "bravo", message: "review PR 12?" })).details.askId);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", askId: lastAskId(b), message: "done" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	await a.stop("reload");
	const replacement = track(await new Session(proj, { id: a.id }).start("reload"));
	const more = await replacement.tool({ action: "reply", askId, message: "thanks, merged" });
	assert.equal(more.isError, false, more.text);
	await eventually(() => assert.ok(b.sentOf("telecom-message").some((m) => /thanks, merged/.test(m.content))));
});
