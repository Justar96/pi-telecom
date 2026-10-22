/** Message delivery and command scenarios against the real extension and a scratch switchboard. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openTransport, TEXT_CAP } from "../src/transport.ts";
import { eventually, makeProject, makeWorktree, Session, session, stopSessions, track, withEnv } from "./harness.ts";

afterEach(stopSessions);

test("reply: a failed delivery keeps the ask available for a shorter reply", async (t) => {
	const proj = makeProject("p-reply-retry");
	const a = await session(proj);
	const b = await session(proj);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = a.tool({ action: "ask", to: "bravo", message: "what changed?" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const failed = await b.tool({ action: "reply", message: "x".repeat(TEXT_CAP + 1) });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /exceeds/);
	const retry = await b.tool({ action: "reply", message: "the cache key" });
	assert.equal(retry.isError, false, retry.text);
	assert.match((await pending).text, /bravo answered:\n\nthe cache key/);
});

test("wake limit: steering messages into a busy session preserves its idle wake budget", async (t) => {
	withEnv(t, "PI_TELECOM_MAX_WAKES", "1");
	const proj = makeProject("p-busy-wakes");
	const a = await session(proj);
	const b = await session(proj);
	b.ctx.isIdle = () => false;
	for (let i = 0; i < 3; i++) await a.tool({ action: "send", to: "bravo", message: `busy ${i}` });
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 3));
	for (const message of b.sentOf("telecom-message")) {
		assert.equal(message.options, undefined, "default delivery steers into the running turn");
		assert.doesNotMatch(message.content, /without starting a turn/);
	}
	b.ctx.isIdle = () => true;
	await a.tool({ action: "send", to: "bravo", message: "idle wake" });
	await a.tool({ action: "send", to: "bravo", message: "over budget" });
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 5));
	assert.equal(b.sentOf("telecom-message")[3]?.options?.triggerTurn, true);
	assert.equal(b.sentOf("telecom-message")[4]?.options, undefined);
	assert.match(b.sentOf("telecom-message")[4]?.content ?? "", /without starting a turn/);
});

test("ask: an already aborted call never sends a question or wakes a peer", async () => {
	const proj = makeProject("p-pre-aborted");
	const a = await session(proj);
	const b = await session(proj);
	const controller = new AbortController();
	controller.abort();
	const result = await a.tool({ action: "ask", to: "bravo", message: "cancelled" }, controller.signal);
	assert.equal(result.isError, true);
	assert.match(result.text, /aborted/);
	await a.tool({ action: "broadcast", message: "after cancellation" });
	await eventually(() => assert.equal(b.sentOf("telecom-broadcast").length, 1));
	assert.equal(b.sentOf("telecom-ask").length, 0);
	assert.equal(await b.settle(), undefined);
});

test("reply: only the addressed peer can settle a waiting ask", async (t) => {
	const proj = makeProject("p-reply-sender");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const controller = new AbortController();
	t.after(() => controller.abort());
	let settled = false;
	const pending = a.tool({ action: "ask", to: "bravo", message: "which key?" }, controller.signal).then((r) => {
		settled = true;
		return r;
	});
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const askId = b.sentOf("telecom-ask")[0]?.details.askId;
	assert.equal((await c.tool({ action: "reply", to: a.id, askId, message: "from someone else" })).isError, false);
	await c.tool({ action: "broadcast", message: "after the unrelated reply" });
	await eventually(() => assert.equal(a.sentOf("telecom-broadcast").length, 1));
	assert.equal(settled, false, "a third session must not consume bravo's answer slot");
	await b.tool({ action: "reply", message: "tenant id" });
	assert.match((await pending).text, /bravo answered:\n\ntenant id/);
});

test("withdrawal: only the asker can withdraw its question", async (t) => {
	const proj = makeProject("p-withdraw-sender");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = a.tool({ action: "ask", to: "bravo", message: "still needed" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const net = openTransport(process.env.PI_TELECOM_DIR as string);
	assert.ok(net.deliver({
		v: 1, id: "wrong-withdrawal", ts: Date.now(), from: c.id, fromCallsign: "charlie", to: b.id,
		kind: "event", topic: "ask.withdrawn", text: "", data: { askId: b.sentOf("telecom-ask")[0]?.details.askId },
	}).ok);
	await c.tool({ action: "broadcast", message: "after withdrawal" });
	await eventually(() => assert.equal(b.sentOf("telecom-broadcast").length, 1));
	assert.equal(b.sentOf("telecom-reply").length, 0);
	assert.equal((await b.tool({ action: "reply", message: "yes" })).isError, false);
	assert.match((await pending).text, /bravo answered:\n\nyes/);
});

test("delivery: a misplaced envelope cannot wake the wrong recipient", async () => {
	const proj = makeProject("p-wrong-inbox");
	const a = await session(proj);
	const b = await session(proj);
	const inbox = join(process.env.PI_TELECOM_DIR as string, "inbox", b.id);
	mkdirSync(inbox, { recursive: true });
	writeFileSync(join(inbox, "000-misplaced.json"), JSON.stringify({
		v: 1, id: "misplaced", ts: Date.now(), from: b.id, fromCallsign: "bravo", to: a.id,
		kind: "ask", text: "for alpha only",
	}));
	await a.tool({ action: "broadcast", message: "after misplaced envelope" });
	await eventually(() => assert.equal(b.sentOf("telecom-broadcast").length, 1));
	assert.equal(b.sentOf("telecom-ask").length, 0);
	assert.equal(await b.settle(), undefined);
});

test("asks: a departed sender in another project leaves no reply reminder", async () => {
	const a = await session(makeProject("p-cross-project-asker"));
	const b = await session(makeProject("p-cross-project-recipient"));
	const pending = a.tool({ action: "ask", to: b.id, message: "cross-project question", timeoutSec: 0.1 });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await pending;
	await a.stop();
	await eventually(() => assert.doesNotMatch(b.status ?? "", /ask.*waiting/));
	assert.equal(await b.settle(), undefined);
});

test("/telecom run: tasks reach this session and repository lanes, including busy sessions with wakes off", async (t) => {
	withEnv(t, "PI_TELECOM_MAX_WAKES", "0");
	const proj = makeProject("p-run-team");
	const lane = makeWorktree(proj, "lane", "lane", makeProject("p-run-team-lane", false));
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(lane);
	const unrelated = await session(makeProject("p-run-unrelated"));
	const disabled = await session(proj);
	await disabled.command("off");
	b.ctx.isIdle = () => false;
	const prompt = "Review your changes.\n\n```ts\n  const value = 1;\n```";
	const said = await a.command(`run ${prompt}`);
	assert.match(said.join("\n"), /task sent to alpha \(this session\), bravo, charlie/);
	for (const recipient of [a, b, c]) {
		await eventually(() => assert.equal(recipient.sentOf("telecom-message").length, 1));
		const message = recipient.sentOf("telecom-message")[0];
		assert.equal(message?.options?.triggerTurn, true, "a deliberate human task bypasses the automatic wake limit");
		assert.ok(message?.content.endsWith(prompt), "multiline prompts keep their formatting");
		assert.match((await recipient.tool({ action: "board" })).text, /task: Review your changes\./);
	}
	assert.equal(unrelated.sentOf("telecom-message").length, 0);
	assert.equal(disabled.sentOf("telecom-message").length, 0);
});

test("/telecom run: solo sessions work, while empty or oversized prompts start nothing", async () => {
	const a = await session(makeProject("p-run-solo"));
	assert.match((await a.command("run")).join("\n"), /usage: \/telecom run/);
	assert.match((await a.command(`run ${"é".repeat(TEXT_CAP / 2 + 1)}`)).join("\n"), /exceeds/);
	assert.equal(a.sentOf("telecom-message").length, 0);
	assert.match((await a.command("run run the tests")).join("\n"), /task sent to alpha \(this session\)/);
	assert.equal(a.sentOf("telecom-message").length, 1);
});

test("/telecom run: a failed peer inbox is reported while reachable sessions get the task", async () => {
	const proj = makeProject("p-run-partial");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	writeFileSync(join(process.env.PI_TELECOM_DIR as string, "inbox", b.id), "not a directory");
	const said = await a.command("run report your progress");
	assert.match(said.join("\n"), /task sent to alpha \(this session\), charlie \(failed: bravo\)/);
	assert.equal(a.sentOf("telecom-message").length, 1);
	await eventually(() => assert.equal(c.sentOf("telecom-message").length, 1));
	assert.equal(b.sentOf("telecom-message").length, 0);
});

test("/telecom off and on: claims are released, waits end, and this session reconnects once", async (t) => {
	const proj = makeProject("p-toggle");
	writeFileSync(join(proj, "shared.ts"), "old\n");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "claim", paths: ["shared.ts"] });
	assert.ok((await b.edit("shared.ts", "old", "new")).blocked);
	await eventually(() => assert.equal(a.sentOf("telecom-claim").length, 1));
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = a.tool({ action: "ask", to: "bravo", message: "before disconnect" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	assert.match((await a.command("off")).join("\n"), /is off.*\/telecom on/);
	assert.match((await pending).text, /disconnected/);
	await eventually(() => assert.ok(b.sentOf("telecom-claim").some((m) => /released shared\.ts/.test(m.content))));
	await eventually(() => assert.ok(b.sentOf("telecom-reply").some((m) => /withdrew/.test(m.content))));
	assert.match((await b.tool({ action: "board" })).text, /No other agent is live/);
	assert.equal(await a.prompt("work while telecom is off"), undefined);
	assert.equal((await a.tool({ action: "board" })).isError, true);
	assert.match((await a.command("help")).join("\n"), /\/telecom on/);
	assert.match((await a.command("run stay disconnected")).join("\n"), /is off/);
	assert.equal(a.sentOf("telecom-message").length, 0);
	const completions = a.commands.get("telecom")?.getArgumentCompletions?.("")?.map((c) => c.value) ?? [];
	for (const command of ["run", "on", "off"]) assert.ok(completions.includes(command), `${command} is discoverable while off`);
	assert.match((await a.command("on")).join("\n"), /is on.*alpha/);
	assert.match((await a.command("on")).join("\n"), /already on/);
	assert.doesNotMatch((await a.tool({ action: "board" })).text, /claims: shared\.ts/);
	await b.tool({ action: "send", to: "alpha", message: "welcome back" });
	await eventually(() => assert.equal(a.sentOf("telecom-message").length, 1));
	assert.match(a.sentOf("telecom-message")[0]?.content ?? "", /welcome back/);
});

test("/telecom off survives reload; on overrides a disabled environment and survives another reload", async (t) => {
	const proj = makeProject("p-toggle-reload");
	const a = await session(proj);
	await a.command("off");
	await a.stop("reload");
	const disabled = new Session(proj, { id: a.id });
	disabled.entries.push(...a.entries);
	track(await disabled.start("reload"));
	assert.equal((await disabled.tool({ action: "board" })).isError, true);
	assert.equal(openTransport(process.env.PI_TELECOM_DIR as string).readPeers().some((p) => p.id === a.id), false);
	withEnv(t, "PI_TELECOM_DISABLE", "1");
	assert.match((await disabled.command("on")).join("\n"), /is on/);
	await disabled.stop("reload");
	const enabled = new Session(proj, { id: a.id });
	enabled.entries.push(...disabled.entries);
	track(await enabled.start("reload"));
	assert.equal((await enabled.tool({ action: "board" })).isError, false);
});

test("reload: an open wait ends and only its intended peer's late answer wakes the replacement", async (t) => {
	const proj = makeProject("p-pending-reload");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj);
	const controller = new AbortController();
	t.after(() => controller.abort());
	const pending = a.tool({ action: "ask", to: "bravo", message: "finish after reload" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const askId = b.sentOf("telecom-ask")[0]?.details.askId;
	await a.stop("reload");
	assert.match((await pending).text, /reloaded/);
	const replacement = new Session(proj, { id: a.id });
	track(await replacement.start("reload"));
	await c.tool({ action: "reply", to: a.id, askId, message: "unrelated" });
	await eventually(() => assert.equal(replacement.sentOf("telecom-reply").length, 1));
	assert.equal(replacement.sentOf("telecom-reply")[0]?.options, undefined);
	await b.tool({ action: "reply", message: "the real answer" });
	await eventually(() => assert.equal(replacement.sentOf("telecom-reply").length, 2));
	const late = replacement.sentOf("telecom-reply")[1];
	assert.match(late?.content ?? "", /Late reply from bravo.*finish after reload/s);
	assert.equal(late?.options?.triggerTurn, true);
});
