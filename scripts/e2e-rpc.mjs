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
import { execFileSync } from "node:child_process";
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

const extra = [];
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

	// 5. a real /reload in B: A keeps seeing B, a message sent during the reload is not lost
	const statusCount = b.records.filter(isStatus(/📡/)).length;
	const reloadId = b.send({ type: "prompt", message: "/reload" });
	await a.command("/telecom broadcast sent while you reload");
	await b.waitFor((r) => r.type === "response" && r.id === reloadId, 20_000).catch(() => null);
	await b.waitFor((r) => isStatus(/📡/)(r) && b.records.filter(isStatus(/📡/)).indexOf(r) >= statusCount, 20_000).catch(() => null);
	const afterReload = await b
		.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-broadcast" && /while you reload/.test(JSON.stringify(r.message.content)), 15_000)
		.catch(() => null);
	check("a message sent during a real /reload still arrives", Boolean(afterReload));
	await b.command("/telecom");
	const boardB = await b.waitFor((r) => isNotify(/You are ops/)(r), 10_000).catch(() => null);
	check("the callsign survives /reload", Boolean(boardB), b.notifies().slice(-1)[0]);

	// 6. B leaves; A's board empties
	b.child.stdin.end();
	await new Promise((r) => b.child.once("exit", r));
	await a.waitFor(isStatus(/solo/), 10_000).catch(() => {});
	await a.command("/telecom");
	const board3 = await a.waitFor(isNotify(/No other agent is live/), 10_000).catch(() => null);
	check("a peer that exits disappears from the board", Boolean(board3), a.notifies().slice(-1)[0]);

	// 7. the same session opened in two pi processes: the younger steps back
	const sessionDir = join(scratch, "sessions");
	const sid = "11111111-2222-4333-8444-555555555555";
	const s1 = startPi("dup-1", { cwd: project, env, session: ["--session-dir", sessionDir, "--session-id", sid] });
	await s1.waitFor(isStatus(/📡/), 30_000);
	const s2 = startPi("dup-2", { cwd: project, env, session: ["--session-dir", sessionDir, "--session-id", sid] });
	extra.push(s1, s2);
	const backedOff = await s2.waitFor(isStatus(/off \(session open elsewhere\)/), 15_000).catch(() => null);
	check("the second process of one session backs off", Boolean(backedOff), JSON.stringify(s2.records.filter(isStatus(/./)).map((r) => r.statusText)));
	await a.command("/telecom");
	const boardDup = await a.waitFor((r) => isNotify(/You are /)(r) && /1 other agent live/.test(r.message) && /dup-1/.test(r.message), 10_000).catch(() => null);
	check("peers see that session exactly once", Boolean(boardDup), a.notifies().slice(-1)[0]);

	// 8a. a new session that names the old one as its parent, in the same process (what `/fork`
	// and `/clone` do): pi tears the old session down first, so the new one is not its subagent
	const renewed = startPi("renewed", { cwd: project, env, session: ["--session-dir", join(scratch, "sessions-renewed")] });
	extra.push(renewed);
	await renewed.waitFor(isStatus(/📡/), 30_000);
	const stateId = renewed.send({ type: "get_state" });
	const state = await renewed.waitFor((r) => r.type === "response" && r.id === stateId, 10_000).catch(() => null);
	const parentSession = state?.data?.sessionFile;
	check("get_state names the session file", typeof parentSession === "string", JSON.stringify(state));
	if (typeof parentSession === "string") {
		const statusesBefore = renewed.records.filter(isStatus(/📡/)).length;
		const newId = renewed.send({ type: "new_session", parentSession });
		await renewed.waitFor((r) => r.type === "response" && r.id === newId, 15_000).catch(() => null);
		await renewed
			.waitFor((r) => isStatus(/📡/)(r) && renewed.records.filter(isStatus(/📡/)).indexOf(r) >= statusesBefore, 15_000)
			.catch(() => null);
		await renewed.command("/telecom");
		const own = await renewed.waitFor(isNotify(/You are /), 10_000).catch(() => null);
		const callsign = own?.message.match(/You are ([\w-]+)\./)?.[1] ?? "";
		check(
			"a session started in the same process with the old one as parent is not its subagent",
			Boolean(own) && !/-\d+$/.test(callsign) && !/subagent/.test(own.message),
			own?.message ?? renewed.notifies().slice(-1)[0],
		);
	}

	// 8. a real `git worktree add`: the main checkout and the worktree are one team, in two lanes
	const repo = join(scratch, "repo");
	const lane = join(scratch, "repo-lane");
	let git = true;
	try {
		mkdirSync(repo);
		const g = (...args) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: repo, stdio: "pipe" });
		g("init", "-q", "-b", "main");
		g("commit", "-q", "--allow-empty", "-m", "init");
		g("worktree", "add", "-q", "-b", "lane-b", lane);
	} catch (error) {
		git = false;
		console.log(`- skipped the worktree checks: git is not usable here (${error.message.split("\n")[0]})`);
	}
	if (git) {
		const main = startPi("main-agent", { cwd: repo, env });
		const wt = startPi("lane-agent", { cwd: lane, env });
		extra.push(main, wt);
		await main.waitFor(isStatus(/📡 \w+ · 1 peer/), 30_000).catch(() => null);
		await main.command("/telecom");
		const laneBoard = await main.waitFor(isNotify(/You are /), 10_000).catch(() => null);
		check(
			"an agent in a git worktree is on the main checkout's board, with its lane",
			Boolean(laneBoard && /• \w+ "lane-agent" \[idle\] on lane-b  in worktree /.test(laneBoard.message)),
			laneBoard?.message ?? main.notifies().slice(-1)[0],
		);
		check("agents in other projects are not counted in the repository's team", Boolean(laneBoard && /1 other agent live/.test(laneBoard.message)), laneBoard?.message);
	}
} catch (error) {
	if (error.message !== "setup") {
		console.error(error);
		failures++;
	} else {
		failures = failures || 2;
	}
} finally {
	for (const p of [a, b, ...extra]) {
		try {
			p.child.stdin.end();
			p.child.kill("SIGTERM");
		} catch {}
	}
	rmSync(scratch, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall e2e checks passed" : `\n${failures} e2e check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
