#!/usr/bin/env node
/**
 * e2e-rpc — two REAL pi processes (RPC mode) in one project, talking through telecom.
 *
 * No model call is made: everything is driven through extension commands and passive
 * deliveries, so this runs offline and costs nothing. It proves what the in-process tests
 * cannot: the extension loads under pi's own loader (jiti, virtual modules), registers its tool
 * and command, and two separate OS processes find each other and exchange messages.
 *
 *   node scripts/e2e-rpc.mjs          # exit 0 = pass, 1 = a check failed, 2 = setup problem
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotify, isStatus, startPi } from "./rpc-driver.mjs";

const scratch = mkdtempSync(join(tmpdir(), "pi-telecom-e2e-"));
const project = join(scratch, "proj");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
const env = { ...process.env, PI_TELECOM_DIR: join(scratch, "switchboard"), PI_TELECOM_TICK_MS: "100" };

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : `\n    ${detail}`}`);
	if (!ok) failures++;
}

const a = startPi("agent-a", { cwd: project, env });
const b = startPi("agent-b", { cwd: project, env });
try {
	// 1. both load the extension and publish a callsign in the footer
	const statusA = await a.waitFor(isStatus(/📡 (alpha|bravo)/), 30_000).catch(() => null);
	const statusB = await b.waitFor(isStatus(/📡 (alpha|bravo)/), 30_000).catch(() => null);
	check("both pi processes load telecom and set a footer status", Boolean(statusA && statusB),
		`a: ${a.stderr().slice(-400)}\nb: ${b.stderr().slice(-400)}`);
	if (!statusA || !statusB) throw new Error("setup");

	// 2. each sees the other on the board (footer converges to "1 peer")
	await a.waitFor(isStatus(/1 peer/), 10_000).catch(() => {});
	await a.command("/telecom");
	const board = await a.waitFor(isNotify(/You are /), 10_000).catch(() => null);
	check("the board in process A lists the agent in process B", Boolean(board && /1 other agent live/.test(board.message) && /agent-b/.test(board.message)),
		board?.message);
	const callsignB = board?.message.match(/• (\w+) "agent-b"/)?.[1];
	check("callsigns are distinct", Boolean(callsignB) && !board.message.includes(`You are ${callsignB}.`), board?.message);

	// 3. a human broadcast from A reaches B as a passive message (no model turn)
	await a.command("/telecom broadcast heads-up: I'm refactoring the auth module");
	const delivered = await b
		.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-broadcast", 10_000)
		.catch(() => null);
	const text = typeof delivered?.message?.content === "string" ? delivered.message.content : JSON.stringify(delivered?.message?.content ?? "");
	check("B receives A's broadcast across processes", /Broadcast from \w+ \(from their human\)/.test(text) && /refactoring the auth module/.test(text), text);
	const startedRun = b.records.some((r) => r.type === "agent_start");
	check("a broadcast does not start a model turn in B", !startedRun);

	// 4. rename, then B sees the new callsign
	await b.command("/telecom name ops");
	await b.waitFor(isNotify(/you are now ops/), 5_000).catch(() => {});
	await a.command("/telecom");
	const board2 = await a.waitFor((r) => isNotify(/You are /)(r) && r !== board && /• ops/.test(r.message), 10_000).catch(() => null);
	check("a rename is visible to the peer", Boolean(board2), a.notifies().slice(-1)[0]);

	// 5. B leaves; A's board empties
	b.child.stdin.end();
	await new Promise((r) => b.child.once("exit", r));
	await a.waitFor(isStatus(/solo/), 10_000).catch(() => {});
	await a.command("/telecom");
	const board3 = await a.waitFor(isNotify(/No other agent is live/), 10_000).catch(() => null);
	check("a peer that exits disappears from the board", Boolean(board3), a.notifies().slice(-1)[0]);
} catch (error) {
	if (error.message !== "setup") {
		console.error(error);
		failures++;
	} else {
		failures = failures || 2;
	}
} finally {
	for (const p of [a, b]) {
		try {
			p.child.stdin.end();
			p.child.kill("SIGTERM");
		} catch {}
	}
	rmSync(scratch, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall e2e checks passed" : `\n${failures} e2e check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
