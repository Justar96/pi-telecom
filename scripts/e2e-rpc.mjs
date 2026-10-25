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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNotify, isStatus, startPi } from "./rpc-driver.mjs";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-telecom-e2e-")));
const project = join(scratch, "proj with spaces & café");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
const env = { ...process.env, PI_TELECOM_DIR: join(scratch, "switchboard"), PI_TELECOM_TICK_MS: "100" };

let failures = 0;
let setupFailed = false;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : `\n    ${detail}`}`);
	if (!ok) failures++;
}

/**
 * Resolves once the session started as `name` has drained its inbox: telecom hands each envelope
 * to pi before removing it. The footer is no barrier for this: it is set only when its text
 * changes, and a delivery need not change it. Matched by name, since callsigns are unique only
 * within a project and every project here shares one switchboard.
 */
async function inboxDrained(name, timeoutMs) {
	const switchboard = env.PI_TELECOM_DIR;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let waiting = true;
		try {
			const records = readdirSync(join(switchboard, "presence")).filter((n) => n.endsWith(".json") && !n.startsWith("."));
			const id = records.map((n) => JSON.parse(readFileSync(join(switchboard, "presence", n), "utf8"))).find((r) => r.name === name)?.id;
			if (id) waiting = readdirSync(join(switchboard, "inbox", id)).some((n) => !n.startsWith("."));
		} catch (error) {
			// No inbox left is a drained one; anything else (a record a reader holds) is retried.
			if (error.code === "ENOENT" && error.path?.includes("inbox")) waiting = false;
		}
		if (!waiting) return;
		if (Date.now() > deadline) throw new Error(`${name}: inbox not drained within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The session id of the live record named `name`. */
function sessionId(name) {
	const dir = join(env.PI_TELECOM_DIR, "presence");
	const records = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	const id = records.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8"))).find((r) => r.name === name)?.id;
	if (!id) throw new Error(`${name}: no presence record`);
	return id;
}

/**
 * Put a direct message in `to`'s inbox the way a peer's telecom does (a temporary name, then a
 * rename), with `extra` wire fields. The model-driven `send` tool is the only sender of `defer`,
 * and these checks make no model calls.
 */
function sendEnvelope(from, to, text, extra = {}) {
	const dir = join(env.PI_TELECOM_DIR, "inbox", sessionId(to));
	mkdirSync(dir, { recursive: true });
	const id = `msg-e2e-${Math.random().toString(36).slice(2, 10)}`;
	const envelope = { v: 1, id, ts: Date.now(), from: sessionId(from), fromCallsign: "sender", to: sessionId(to), kind: "message", text, ...extra };
	const name = `${String(Date.now()).padStart(15, "0")}-${id}.json`;
	writeFileSync(join(dir, `.${name}`), `${JSON.stringify(envelope)}\n`);
	renameSync(join(dir, `.${name}`), join(dir, name));
}

const extra = [];
let a;
let b;
try {
	a = startPi("agent-a", { cwd: project, env });
	b = startPi("agent-b", { cwd: project, env });
	// 1. both load the extension and publish a callsign in the footer
	const statusA = await a.waitFor(isStatus(/📡 (alpha|bravo)/), 30_000).catch(() => null);
	const statusB = await b.waitFor(isStatus(/📡 (alpha|bravo)/), 30_000).catch(() => null);
	check("both pi processes load telecom and set a footer status", Boolean(statusA && statusB),
		`a: ${a.stderr().slice(-400)}\nb: ${b.stderr().slice(-400)}`);
	if (!statusA || !statusB) throw new Error("setup");

	// 2. each sees the other on the board (footer converges to "1 peer")
	await a.waitFor(isStatus(/1 peer/), 10_000).catch(() => {});
	// Started together, both may pick the same callsign; a team refresh resolves it moments later,
	// so the board is read again until it has (or the time is up).
	let board = null;
	let callsignB;
	for (const deadline = Date.now() + 10_000; ; ) {
		const since = a.records.length;
		await a.command("/telecom");
		board = await a.waitFor(isNotify(/You are /), 10_000, since).catch(() => null);
		callsignB = board?.message.match(/• (\w+) "agent-b"/)?.[1];
		if ((callsignB && !board.message.includes(`You are ${callsignB}.`)) || Date.now() > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	check("the board in process A lists the agent in process B", Boolean(board && /1 other agent live/.test(board.message) && /agent-b/.test(board.message)),
		board?.message);
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

	// 6. B leaves; A's human is told who left, and A's board empties
	const leftOffset = a.records.length;
	await b.stop();
	const leftNotice = await a.waitFor(isNotify(/📡 .*\bops left/), 10_000, leftOffset).catch(() => null);
	// On failure, everything needed to tell a missed notice from a missed departure: all of A's
	// notices, its footer since B stopped, and what the switchboard holds now.
	const leftDetail = () => {
		let files = [];
		try {
			files = readdirSync(join(env.PI_TELECOM_DIR, "presence"));
		} catch (error) {
			files = [String(error.code)];
		}
		const footer = a.records.slice(leftOffset).filter(isStatus(/./)).map((r) => r.statusText);
		return `notices: ${a.notifies().map((n) => n.split("\n")[0]).join(" | ")}\n    footer since stop: ${footer.join(" → ") || "(unchanged)"}\n    presence: ${files.join(", ")}`;
	};
	check("the human is told by name which peer left", Boolean(leftNotice), leftNotice ? "" : leftDetail());
	await a.waitFor(isStatus(/solo/), 10_000).catch(() => {});
	await a.command("/telecom");
	const board3 = await a.waitFor(isNotify(/No other agent is live/), 10_000).catch(() => null);
	check("a peer that exits disappears from the board", Boolean(board3), a.notifies().slice(-1)[0]);

	// 6b. the team log, across processes: B's history outlives B, and its real /reload was no leave
	await a.command("/telecom log");
	const log = await a.waitFor(isNotify(/📡 Team log/), 10_000).catch(() => null);
	check(
		"the team log in A shows its broadcast, and B leaving once, as ops: its real /reload was no departure",
		Boolean(log && /\bops left/.test(log.message) && log.message.match(/ left/g)?.length === 1 && /heads-up: I'm refactoring the auth module/.test(log.message)),
		log?.message,
	);

	// 7. the same session opened in two pi processes: the younger steps back
	const sessionDir = join(scratch, "sessions");
	const sid = "11111111-2222-4333-8444-555555555555";
	const s1 = startPi("dup-1", { cwd: project, env, session: ["--session-dir", sessionDir, "--session-id", sid] });
	extra.push(s1);
	await s1.waitFor(isStatus(/📡/), 30_000);
	const s2 = startPi("dup-2", { cwd: project, env, session: ["--session-dir", sessionDir, "--session-id", sid] });
	extra.push(s2);
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
	const repo = join(scratch, "repo [copy]");
	const lane = join(scratch, "repo lane café");
	let git = true;
	try {
		mkdirSync(repo);
		const g = (...args) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
		g("init", "-q", "-b", "main");
		g("commit", "-q", "--allow-empty", "-m", "init");
		g("worktree", "add", "-q", "-b", "lane-b", lane);
	} catch (error) {
		git = false;
		setupFailed = true;
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
			Boolean(laneBoard && /• \w+ "lane-agent" \[idle(?: \d+[smhd])?\] on lane-b  in worktree /.test(laneBoard.message)),
			laneBoard?.message ?? main.notifies().slice(-1)[0],
		);
		check("agents in other projects are not counted in the repository's team", Boolean(laneBoard && /1 other agent live/.test(laneBoard.message)), laneBoard?.message);
	}

	// 9. Real turns with a local fixture provider: no network or paid model calls.
	const taskProject = join(scratch, "tasks");
	mkdirSync(taskProject);
	const fixture = fileURLToPath(new URL("./rpc-fixture.ts", import.meta.url));
	const taskArgs = ["-e", fixture, "--model", "telecom-rpc-test/fixture"];
	const taskEnv = { ...env, PI_TELECOM_MAX_WAKES: "1" };
	const leader = startPi("task-leader", { cwd: taskProject, env: taskEnv, args: taskArgs });
	const worker = startPi("task-worker", { cwd: taskProject, env: taskEnv, args: taskArgs });
	extra.push(leader, worker);
	await Promise.all([leader.waitFor(isStatus(/1 peer/), 30_000), worker.waitFor(isStatus(/1 peer/), 30_000)]);
	const settled = (record) => record.type === "agent_settled";
	const completed = (agent, offset) => agent.records.slice(offset).some((r) =>
		r.type === "message_end" && r.message?.role === "assistant" && r.message.model === "fixture" && r.message.stopReason === "stop");
	const taskOffsets = [leader.records.length, worker.records.length];
	await leader.command("/telecom run review your changes");
	await Promise.all([leader, worker].map((agent, i) => agent.waitFor(settled, 15_000, taskOffsets[i])));
	check("/telecom run starts real turns in the caller and its peer", [leader, worker].every((agent, i) => completed(agent, taskOffsets[i])));
	const workerStatus = worker.records.filter(isStatus(/📡/)).at(-1)?.statusText ?? "";
	const workerCallsign = workerStatus.match(/📡 ([\w-]+)/)?.[1];
	if (!workerCallsign) throw new Error("task worker has no callsign");

	// Hold a real stream while several messages are steered in, then use the remaining idle wake.
	await worker.command("/telecom-test hold");
	const heldOffset = worker.records.length;
	worker.send({ type: "prompt", message: "hold this turn" });
	await worker.waitFor((r) => r.type === "message_start" && r.message?.role === "assistant", 10_000, heldOffset);
	for (let i = 0; i < 3; i++) await leader.command(`/telecom msg ${workerCallsign} busy message ${i}`);
	// A barrier, not a timing guess: steering leaves no record until the stream ends.
	await inboxDrained("task-worker", 10_000);
	await worker.command("/telecom-test release");
	await worker.waitFor(settled, 10_000, heldOffset);
	const busyMessages = worker.records.slice(heldOffset).filter((r) => r.type === "message_end" && r.message?.customType === "telecom-message");
	check(
		"busy messages are steered without a wake-limit warning",
		busyMessages.length === 3 && busyMessages.every((r) => !/without starting a turn/.test(JSON.stringify(r.message.content))),
		JSON.stringify(busyMessages.map((r) => r.message.content)),
	);
	const wakeOffset = worker.records.length;
	await leader.command(`/telecom msg ${workerCallsign} wake after busy messages`);
	const woke = await worker.waitFor(settled, 10_000, wakeOffset).catch(() => null);
	check("steering into a real busy run preserves the next idle wake", Boolean(woke) && completed(worker, wakeOffset));

	// A message sent with `interrupt: false` waits for the end of the run: a plain one sent at the
	// same moment, during a tool call, is steered in right after that call.
	await worker.command("/telecom-test tool");
	const deferOffset = worker.records.length;
	worker.send({ type: "prompt", message: "run a slow tool" });
	await worker.waitFor((r) => r.type === "tool_execution_start", 10_000, deferOffset);
	sendEnvelope("task-leader", "task-worker", "plain message while the tool runs");
	sendEnvelope("task-leader", "task-worker", "deferred message while the tool runs", { defer: true });
	await inboxDrained("task-worker", 10_000);
	await worker.waitFor(settled, 20_000, deferOffset);
	const run = worker.records.slice(deferOffset);
	const at = (re) => run.findIndex((r) => r.type === "message_end" && r.message?.customType === "telecom-message" && re.test(JSON.stringify(r.message.content)));
	const plainAt = at(/plain message while the tool runs/);
	const deferredAt = at(/deferred message while the tool runs/);
	const answeredAt = run.findIndex((r) => r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "stop");
	check("control: a plain message sent during a tool call is steered in right after it", plainAt !== -1 && answeredAt !== -1 && plainAt < answeredAt,
		`plain at ${plainAt}, first answer at ${answeredAt}, deferred at ${deferredAt}`);
	check("a deferred message arrives when the run is about to end, in the same run", deferredAt > answeredAt && answeredAt !== -1 && run.filter((r) => r.type === "agent_start").length === 1,
		`first answer at ${answeredAt}, deferred at ${deferredAt}, runs ${run.filter((r) => r.type === "agent_start").length}`);

	// The explicit run command also works after the automatic wake allowance is exhausted.
	const repeatOffsets = [leader.records.length, worker.records.length];
	await leader.command("/telecom run finish your review");
	await Promise.all([leader, worker].map((agent, i) => agent.waitFor(settled, 10_000, repeatOffsets[i])));
	check("an explicit team task bypasses the automatic wake limit", [leader, worker].every((agent, i) => completed(agent, repeatOffsets[i])));

	await worker.command("/telecom off");
	await worker.command("/reload");
	const offOffset = worker.records.length;
	await worker.command("/telecom");
	const off = await worker.waitFor(isNotify(/telecom is off.*\/telecom on/), 10_000, offOffset).catch(() => null);
	check("/telecom off stays off after a real /reload", Boolean(off));
	const absentOffset = leader.records.length;
	await leader.command("/telecom");
	check("a disabled session leaves its peers' board", Boolean(await leader.waitFor(isNotify(/No other agent is live/), 10_000, absentOffset).catch(() => null)));
	await worker.command("/telecom on");
	await worker.command("/reload");
	const onOffset = worker.records.length;
	await worker.command("/telecom");
	check("/telecom on reconnects and stays on after a real /reload", Boolean(await worker.waitFor(isNotify(/You are /), 10_000, onOffset).catch(() => null)));
} catch (error) {
	if (error.message !== "setup") {
		console.error(error);
		failures++;
	} else {
		setupFailed = true;
	}
} finally {
	await Promise.all([a, b, ...extra].filter(Boolean).map((p) => p.stop()));
	rmSync(scratch, { recursive: true, force: true });
}
console.log(setupFailed ? "\ne2e checks incomplete: a precondition is missing" : failures === 0 ? "\nall e2e checks passed" : `\n${failures} e2e check(s) failed`);
process.exit(setupFailed ? 2 : failures === 0 ? 0 : 1);
