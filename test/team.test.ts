/**
 * team — end-to-end scenarios: real extension instances, a real (scratch) switchboard, real
 * files on disk. Each scenario uses its own project directory so they cannot see each other.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { eventually, makeProject, Session, sleep } from "./harness.ts";

const open: Session[] = [];
async function session(cwd: string, opts: { name?: string } = {}): Promise<Session> {
	const s = await new Session(cwd, opts).start();
	open.push(s);
	return s;
}
after(async () => {
	for (const s of open) await s.stop();
});

test("agents in one project get callsigns and see each other; other projects stay off the board", async () => {
	const proj = makeProject("p-board");
	const other = makeProject("p-board-other");
	const a = await session(proj);
	const b = await session(join(proj)); // same root
	const c = await session(other);
	const board = await a.tool({ action: "board" });
	assert.match(board.text, /You are alpha/);
	assert.match(board.text, /bravo/);
	assert.doesNotMatch(board.text, /• alpha .*in .*p-board-other/);
	assert.match(board.text, /1 more agent in other projects/);
	assert.equal((await c.tool({ action: "board" })).details.callsign, "alpha", "callsigns are per project");
	const machine = await a.tool({ action: "board", scope: "machine" });
	assert.match(machine.text, /p-board-other/);
	await eventually(() => assert.match(b.status ?? "", /📡 bravo · 1 peer/));
});

test("send wakes the peer; broadcast is passive; status shows on the board", async () => {
	const proj = makeProject("p-send");
	const a = await session(proj);
	const b = await session(proj);
	const sent = await a.tool({ action: "send", to: "bravo", message: "please run the tests when you're done" });
	assert.ok(!sent.isError, sent.text);
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	const msg = b.sentOf("telecom-message")[0];
	assert.match(msg?.content ?? "", /Message from alpha/);
	assert.deepEqual(msg?.options, { triggerTurn: true });

	await a.tool({ action: "broadcast", message: "I renamed User.id to User.uid" });
	await eventually(() => assert.equal(b.sentOf("telecom-broadcast").length, 1));
	assert.equal(b.sentOf("telecom-broadcast")[0]?.options, undefined, "broadcast does not wake");

	await b.tool({ action: "status", message: "migrating the db layer" });
	assert.match((await a.tool({ action: "board" })).text, /task: migrating the db layer/);

	const bad = await a.tool({ action: "send", to: "zulu", message: "hi" });
	assert.ok(bad.isError);
	assert.match(bad.text, /no live agent answers to "zulu".*bravo/);
	assert.ok((await a.tool({ action: "send", to: "alpha", message: "me" })).isError, "self-target refused");
});

test("ask blocks until reply; reply infers the single outstanding ask", async () => {
	const proj = makeProject("p-ask");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "which port does the dev server use?" });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const ask = b.sentOf("telecom-ask")[0];
	assert.deepEqual(ask?.options, { triggerTurn: true });
	assert.match(b.status ?? "", /1 ask waiting/);
	const reply = await b.tool({ action: "reply", message: "5173" });
	assert.ok(!reply.isError, reply.text);
	const answer = await pending;
	assert.ok(!answer.isError);
	assert.match(answer.text, /bravo answered:\n\n5173/);
});

test("simultaneous asks do not deadlock", async () => {
	const proj = makeProject("p-deadlock");
	const a = await session(proj);
	const b = await session(proj);
	const fromA = a.tool({ action: "ask", to: "bravo", message: "A asks" });
	const fromB = b.tool({ action: "ask", to: "alpha", message: "B asks" });
	const [ra, rb] = await Promise.all([fromA, fromB]);
	// Each side is interrupted by the other's question instead of waiting for a timeout.
	assert.ok(ra.details.interrupted || rb.details.interrupted, `${ra.text}\n---\n${rb.text}`);
	const interrupted = ra.details.interrupted ? a : b;
	const res = await interrupted.tool({ action: "reply", askId: (ra.details.interrupted ? ra : rb).details.inboundAskId, message: "answer" });
	assert.ok(!res.isError, res.text);
});

test("ask times out with a useful reason; a late answer still arrives", async () => {
	const proj = makeProject("p-timeout");
	const a = await session(proj);
	const b = await session(proj);
	const result = await a.tool({ action: "ask", to: "bravo", message: "slow question", timeoutSec: 0.1 });
	assert.ok(result.isError);
	assert.match(result.text, /did not answer within/);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.tool({ action: "reply", message: "late answer" });
	await eventually(() => assert.equal(a.sentOf("telecom-reply").length, 1));
	assert.match(a.sentOf("telecom-reply")[0]?.content ?? "", /Late reply from bravo\*\* to your ask "slow question"/);
});

test("an unanswered ask keeps the agent going until it replies (settle reminder, once)", async () => {
	const proj = makeProject("p-remind");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "need a decision", timeoutSec: 5 });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	const first = await b.settle();
	assert.equal(first?.continue, true);
	assert.match(first.entries[0].content, /still blocked on your reply/);
	assert.equal(await b.settle(), undefined, "reminded once, never loops");
	await b.tool({ action: "reply", message: "go with option 2" });
	assert.match((await pending).text, /option 2/);
});

test("a peer's edit to a file you read produces one coalesced change notice", async () => {
	const proj = makeProject("p-notice");
	writeFileSync(join(proj, "shared.ts"), "export const a = 1;\nexport const b = 2;\n");
	writeFileSync(join(proj, "untouched.ts"), "x\n");
	const a = await session(proj);
	const b = await session(proj);
	await b.read("shared.ts");
	await a.edit("shared.ts", "export const a = 1;", "export const a = 10;");
	await a.edit("shared.ts", "export const b = 2;", "export const b = 20;");
	await a.write("untouched.ts", "y\n");
	await eventually(() => assert.equal(b.sentOf("telecom-change").length, 1), 3_000);
	await sleep(1_500);
	const notices = b.sentOf("telecom-change");
	assert.equal(notices.length, 1, "coalesced, and nothing about files bravo never touched");
	assert.match(notices[0]?.content ?? "", /alpha changed a file you are working with/);
	assert.match(notices[0]?.content ?? "", /shared\.ts — edited/);
	assert.match(notices[0]?.content ?? "", /you read this file earlier/);
	assert.equal(notices[0]?.options, undefined, "passive: never wakes an idle agent");
	// The board shows what alpha changed recently.
	assert.match((await b.tool({ action: "board" })).text, /recently changed: untouched\.ts .*shared\.ts/);
});

test("guard: a whole-file write over a peer's unseen change is blocked until re-read", async () => {
	const proj = makeProject("p-stale");
	writeFileSync(join(proj, "config.json"), '{ "port": 1 }\n');
	const a = await session(proj);
	const b = await session(proj);
	await b.read("config.json");
	await a.edit("config.json", '"port": 1', '"port": 2');
	await eventually(() => assert.equal(b.sentOf("telecom-change").length, 1), 3_000);
	const blocked = await b.write("config.json", '{ "port": 3 }\n');
	assert.ok(blocked.blocked, "stale write must be blocked");
	assert.match(blocked.blocked ?? "", /alpha edited config\.json .*after you last read it/);
	assert.equal(readFileSync(join(proj, "config.json"), "utf8"), '{ "port": 2 }\n', "alpha's change survives");
	await b.read("config.json");
	const allowed = await b.write("config.json", '{ "port": 3 }\n');
	assert.equal(allowed.blocked, undefined);
});

test("guard: a stale anchored edit goes through with a warning (standard mode)", async () => {
	const proj = makeProject("p-stale-edit");
	writeFileSync(join(proj, "a.ts"), "one\ntwo\nthree\n");
	const a = await session(proj);
	const b = await session(proj);
	await b.read("a.ts");
	await a.edit("a.ts", "one", "ONE");
	await eventually(() => assert.equal(b.sentOf("telecom-change").length, 1), 3_000);
	const res = await b.edit("a.ts", "three", "THREE");
	assert.equal(res.blocked, undefined);
	assert.match(res.note ?? "", /⚠ telecom: alpha edited a\.ts .*re-read the file/);
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "ONE\ntwo\nTHREE\n");
});

test("guard: writing a file a peer just changed, without reading it, is blocked", async () => {
	const proj = makeProject("p-unseen");
	writeFileSync(join(proj, "README.md"), "# old\n");
	const a = await session(proj);
	const b = await session(proj);
	await a.edit("README.md", "# old", "# new");
	const res = await b.write("README.md", "# mine\n");
	assert.match(res.blocked ?? "", /alpha edited README\.md .*you have not read it/);
});

test("guard stays out of the way for solo work and own changes", async () => {
	const proj = makeProject("p-solo");
	writeFileSync(join(proj, "solo.ts"), "a\n");
	const a = await session(proj);
	await a.read("solo.ts");
	writeFileSync(join(proj, "solo.ts"), "changed by a formatter\n");
	const res = await a.write("solo.ts", "b\n");
	assert.equal(res.blocked, undefined);
	assert.equal(res.note, undefined);
});

test("claims: overlap refused, path held back once with owner told, release tells the contester", async () => {
	const proj = makeProject("p-claim");
	writeFileSync(join(proj, "auth.ts"), "export {}\n");
	const a = await session(proj);
	const b = await session(proj);
	const claimed = await a.tool({ action: "claim", paths: ["auth.ts", "src/auth/**"], message: "rewriting login" });
	assert.ok(!claimed.isError, claimed.text);
	const overlap = await b.tool({ action: "claim", paths: ["src"] });
	assert.ok(overlap.isError);
	assert.match(overlap.text, /overlaps alpha's claim "src\/auth\/\*\*"/);

	await b.read("auth.ts");
	const first = await b.edit("auth.ts", "export {}", "export const x = 1;");
	assert.match(first.blocked ?? "", /inside alpha's claim "auth\.ts" \(rewriting login\)/);
	await eventually(() => assert.equal(a.sentOf("telecom-claim").length, 1));
	assert.match(a.sentOf("telecom-claim")[0]?.content ?? "", /bravo needs a path you claimed/);

	const retry = await b.edit("auth.ts", "export {}", "export const x = 1;");
	assert.equal(retry.blocked, undefined, "standard mode lets a deliberate retry through");
	assert.match(retry.note ?? "", /You went ahead after the warning/);
	// The owner hears about the edit inside its claim.
	await eventually(() => assert.ok(a.sentOf("telecom-change").some((m) => /inside your claim "auth\.ts"/.test(m.content))), 3_000);

	const released = await a.tool({ action: "release" });
	assert.match(released.text, /told bravo/);
	await eventually(() => assert.ok(b.sentOf("telecom-claim").some((m) => /alpha released/.test(m.content))));
});

test("team brief: given at the start of a prompt only when the team changed", async () => {
	const proj = makeProject("p-brief");
	const a = await session(proj);
	assert.equal(await a.prompt("solo work"), undefined, "no brief when alone");
	const b = await session(proj);
	await b.prompt("fix the flaky upload test");
	const brief = await a.prompt("next thing");
	assert.match(brief?.message?.content ?? "", /you are "alpha"\. 1 other agent is working/);
	assert.match(brief?.message?.content ?? "", /bravo \[busy\].*\n\s+task: fix the flaky upload test/);
	assert.equal(await a.prompt("and another"), undefined, "unchanged team → no repeat");
	await b.tool({ action: "claim", paths: ["tests/upload"] });
	assert.match((await a.prompt("again"))?.message?.content ?? "", /claims: tests\/upload/);
});

test("leaving: presence removed; a blocked ask to the departed peer fails fast", async () => {
	const proj = makeProject("p-leave");
	const a = await session(proj);
	const b = await session(proj);
	const pending = a.tool({ action: "ask", to: "bravo", message: "still there?", timeoutSec: 30 });
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	await b.stop();
	const res = await pending;
	assert.ok(res.isError);
	assert.match(res.text, /bravo's session ended before it answered/);
	assert.match((await a.tool({ action: "board" })).text, /No other agent is live/);
});

test("wake limit: a chatty peer cannot start unlimited turns", async () => {
	const proj = makeProject("p-wakes");
	const a = await session(proj);
	const b = await session(proj);
	for (let i = 0; i < 8; i++) await a.tool({ action: "send", to: "bravo", message: `ping ${i}` });
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 8));
	const woke = b.sentOf("telecom-message").filter((m) => m.options?.triggerTurn).length;
	assert.equal(woke, 6);
	assert.match(b.sentOf("telecom-message")[7]?.content ?? "", /arrived without starting a turn/);
});

test("/telecom: human messages, rename, board", async () => {
	const proj = makeProject("p-cmd");
	const a = await session(proj);
	const b = await session(proj);
	const out = await a.command("msg bravo hold off on main, I'm rebasing");
	assert.match(out[0] ?? "", /sent to bravo/);
	await eventually(() => assert.equal(b.sentOf("telecom-message").length, 1));
	assert.match(b.sentOf("telecom-message")[0]?.content ?? "", /Message from alpha \(from their human\)/);
	assert.match((await b.command("name bravo"))[0] ?? "", /you are now bravo/);
	assert.match((await b.command("name alpha"))[0] ?? "", /taken/);
	assert.match((await b.command("name ops"))[0] ?? "", /you are now ops/);
	assert.ok(b.entries.some((e) => (e.data as { callsign?: string }).callsign === "ops"), "callsign persisted for resume");
	assert.match((await a.command(""))[0] ?? "", /• ops/);
});

test("callsign is kept across a resume when still free", async () => {
	const proj = makeProject("p-resume");
	const first = await session(proj);
	await first.command("name kilo");
	const entries = [...first.entries];
	await first.stop();
	const resumed = new Session(proj, { id: first.id });
	resumed.entries.push(...entries);
	await resumed.start();
	open.push(resumed);
	assert.equal((await resumed.tool({ action: "board" })).details.callsign, "kilo");
});

test("an aborted ask is withdrawn from the peer's to-do list", async () => {
	const proj = makeProject("p-withdraw");
	const a = await session(proj);
	const b = await session(proj);
	const controller = new AbortController();
	const pending = a.tool({ action: "ask", to: "bravo", message: "never mind soon" }, controller.signal);
	await eventually(() => assert.equal(b.sentOf("telecom-ask").length, 1));
	controller.abort();
	assert.ok((await pending).isError);
	await eventually(() => assert.ok(b.sentOf("telecom-reply").some((m) => /withdrew their ask/.test(m.content))));
	assert.equal(await b.settle(), undefined, "no reminder for a withdrawn ask");
});
