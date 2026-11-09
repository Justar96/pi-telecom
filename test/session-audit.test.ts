/**
 * session-audit — fixes found by reading real team sessions: tool results that told an agent
 * something already untrue (a wait it had just answered, a wait cycle with it, advice for an ask
 * it did not make), and inputs taken silently that did nothing (`!` claim patterns, a timeout
 * over the cap).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { openTransport, type Presence } from "../src/transport.ts";
import { eventually, makeProject, type Session, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

function published(s: Session): Presence | undefined {
	return openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === s.id);
}

test("status: a wait on this agent it already answered is neither a hint nor a cycle, though the waiter's record lags", async () => {
	const proj = makeProject("p-audit-answered");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "waiting for bravo's build", waitingFor: ["bravo"] });
	await eventually(() => assert.deepEqual(published(a)?.blockedOn, [b.id]));
	// Before bravo writes to alpha, the hint is right: alpha waits.
	const before = await b.tool({ action: "status", message: "building" });
	assert.match(before.text, /alpha waits for you/);
	// The go-ahead and the status in one batch: alpha's record still shows the wait.
	await b.tool({ action: "send", to: "alpha", message: "build is green, go ahead", unblocks: true });
	const after = await b.tool({ action: "status", message: "running the e2e for alpha", waitingFor: ["alpha"] });
	assert.doesNotMatch(after.text, /alpha waits for you/, "bravo just answered alpha");
	assert.doesNotMatch(after.text, /closes a wait cycle/, "alpha's wait on bravo is answered: no cycle");
	assert.match(after.text, /waiting for alpha/);
});

test("status: an FYI ends no wait, so the hint and the cycle stand", async () => {
	const proj = makeProject("p-audit-fyi");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "waiting for bravo's build", waitingFor: ["bravo"] });
	await eventually(() => assert.deepEqual(published(a)?.blockedOn, [b.id]));
	await b.tool({ action: "send", to: "alpha", message: "fyi: build is half done" });
	await b.tool({ action: "send", to: "alpha", message: "fyi: lint is green", interrupt: false });
	const after = await b.tool({ action: "status", message: "still building", waitingFor: ["alpha"] });
	assert.match(after.text, /alpha waits for you/);
	assert.match(after.text, /This closes a wait cycle: bravo → alpha → bravo/);
});

test("status: a reply also answers the waiter, and a later wait is told again", async () => {
	const proj = makeProject("p-audit-reply");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "ask", to: "bravo", message: "which port?", wait: false });
	await a.tool({ action: "status", message: "waiting for bravo's port", waitingFor: ["bravo"] });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", message: "12000" });
	assert.doesNotMatch((await b.tool({ action: "status", message: "done with alpha" })).text, /waits for you/);
	// alpha declares a new wait after the reply: that one is unanswered.
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	await new Promise((r) => setTimeout(r, 5));
	await a.tool({ action: "status", message: "now waiting for the schema", waitingFor: [] });
	await a.tool({ action: "status", message: "now waiting for the schema", waitingFor: ["bravo"] });
	await eventually(() => assert.deepEqual(published(a)?.blockedOn, [b.id]));
	assert.match((await b.tool({ action: "status", message: "on the schema" })).text, /alpha waits for you/);
});

test("claim: a `!` pattern is refused with the reason, and the other paths are still claimed", async () => {
	const proj = makeProject("p-audit-negated");
	const a = await session(proj);
	const res = await a.tool({ action: "claim", paths: ["src/orders/*.ts", "!src/orders/partial.ts"] });
	assert.equal(res.isError, false);
	assert.match(res.text, /^claimed src\/orders\/\*\.ts/);
	assert.match(res.text, /Not claimed: !src\/orders\/partial\.ts: a claim cannot exclude paths/);
	assert.deepEqual(res.details.refused, ["!src/orders/partial.ts"]);
	assert.deepEqual(published(a)?.claims.map((c) => c.pattern), ["src/orders/*.ts"], "nothing that matches no file is stored");
	const only = await a.tool({ action: "claim", paths: ["!src/x.ts"] });
	assert.equal(only.isError, true);
	assert.match(only.text, /a claim cannot exclude paths/);
});

test("ask: a timeout over the cap says it was capped", async () => {
	const proj = makeProject("p-audit-cap");
	const a = await session(proj);
	await session(proj);
	const res = await a.tool({ action: "ask", to: "bravo", message: "tell me when the suite ends", wait: false, timeoutSec: 7200 });
	assert.match(res.text, /if none comes within 3600s \(the most an ask waits; you asked for 7200s\), you are told/);
	const plain = await a.tool({ action: "ask", to: "bravo", message: "and the lint?", wait: false, timeoutSec: 600 });
	assert.match(plain.text, /within 600s, you are told/);
});
