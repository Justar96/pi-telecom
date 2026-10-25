/**
 * claims-hold — what keeps a claim alive while its owner is idle: a process it is tied to
 * (`claim` with `pid`), and a declared wait on a live teammate; and how a claim that lapses is
 * worded. Real extension instances on a scratch switchboard, with real child processes.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { lockLines } from "../src/locks.ts";
import { findProjectRoot } from "../src/project.ts";
import { isAlive, jobRuns, openTransport, parsePresence, type Presence, processStartTicks, WIRE_VERSION } from "../src/transport.ts";
import { eventually, makeProject, type Session, session, sleep, stopSessions, withEnv } from "./harness.ts";

const jobs: ChildProcess[] = [];

/**
 * The claim TTL of tests that check a claim is still held past it. Each heartbeat holds a claim
 * for one more TTL, so a runner that stalls the event loop for longer (Windows CI starting a child
 * Node process) lets it lapse: 300 ms was not enough there.
 */
const HOLD_TTL_MIN = "0.02"; // 1.2 s
/** Well past one `HOLD_TTL_MIN`. */
const PAST_TTL_MS = 1_800;

afterEach(async () => {
	for (const job of jobs.splice(0)) job.kill("SIGKILL");
	await stopSessions();
});

/** A real process that runs for a minute: the stand-in for a background build. */
async function startJob(): Promise<ChildProcess> {
	const job = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	jobs.push(job);
	await new Promise<void>((resolve, reject) => {
		job.once("spawn", () => resolve());
		job.once("error", reject);
	});
	return job;
}

/** Kill it and wait until it is reaped, so its pid is certainly not a running process. */
async function endJob(job: ChildProcess): Promise<void> {
	const done = new Promise<void>((resolve) => job.once("exit", () => resolve()));
	job.kill("SIGKILL");
	await done;
}

/** A session's record as its peers read it. */
function published(s: Session): Presence | undefined {
	return openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === s.id);
}

const lockMessages = (s: Session) => s.sentOf("telecom-claim").filter((m) => /is yours now/.test(m.content));
const logOf = async (s: Session) => (await s.tool({ action: "log" })).text;

function record(extra: Partial<Presence> = {}): Presence {
	return {
		v: WIRE_VERSION, id: "s-1", callsign: "golf", pid: 1, ticks: null, cwd: "/r", projectRoot: "/r", role: "main", state: "idle",
		claims: [], recent: [], startedAt: 1, heartbeatAt: Date.now(), ...extra,
	};
}

// ---------------------------------------------------------------- units

test("claims with a pid: the pid and its start ticks are validated on the wire, and the board says what a lock waits for", () => {
	const now = Date.now();
	const raw = {
		...record(),
		claims: [
			{ pattern: "@cargo", since: now, expiresAt: now + 1000, pid: 4242, pidStart: 77 },
			{ pattern: "a.ts", since: now, expiresAt: now + 1000, pid: "4242", pidStart: 77 },
			{ pattern: "b.ts", since: now, expiresAt: now + 1000, pid: -3 },
			{ pattern: "c.ts", since: now, expiresAt: now + 1000, pid: 1.5 },
			{ pattern: "d.ts", since: now, expiresAt: now + 1000, pidStart: 77 },
			{ pattern: "e.ts", since: now, expiresAt: now + 1000, pid: 9, pidStart: "x" },
		],
	};
	const claims = parsePresence(raw)?.claims ?? [];
	assert.deepEqual(claims.map((c) => [c.pattern, c.pid, c.pidStart]), [
		["@cargo", 4242, 77],
		["a.ts", undefined, undefined],
		["b.ts", undefined, undefined],
		["c.ts", undefined, undefined],
		["d.ts", undefined, undefined],
		["e.ts", 9, undefined],
	]);
	assert.deepEqual(lockLines([record({ claims })], "me", now), ["@cargo — golf, while pid 4242 runs"]);
	assert.deepEqual(lockLines([record({ claims, id: "me" })], "me", now), ["@cargo — you, while pid 4242 runs"]);
	const plain = record({ claims: [{ pattern: "@cargo", since: now, expiresAt: now + 1000 }] });
	assert.deepEqual(lockLines([plain], "me", now), ["@cargo — golf"]);
});

// ---------------------------------------------------------------- claims tied to a process

test("a pid that is not running does not turn the claim away: it is a normal claim, and the result says so", async () => {
	const proj = makeProject("p-pid-dead");
	const a = await session(proj);
	const job = await startJob();
	const dead = job.pid as number;
	await endJob(job);
	const made = await a.tool({ action: "claim", paths: ["@cargo", "src/**"], pid: dead });
	assert.ok(!made.isError, made.text);
	assert.match(made.text, new RegExp(`pid ${dead} is not running, so this is a normal claim: idle claims expire after \\d+ min\\.`));
	assert.equal(made.text.match(/is not running/g)?.length, 1, "said once");
	assert.deepEqual(published(a)?.claims.map((c) => [c.pattern, c.pid, c.pidStart]), [["src/**", undefined, undefined], ["@cargo", undefined, undefined]]);
	const bad = await a.tool({ action: "claim", paths: ["@cargo"], pid: -5 });
	assert.ok(!bad.isError);
	assert.match(bad.text, /pid -5 is not running, so this is a normal claim/);
	// A dead pid does not inherit the one a live claim had: the agent just said which process it means.
	const live = await startJob();
	await a.tool({ action: "claim", paths: ["@cargo"], pid: live.pid });
	await a.tool({ action: "claim", paths: ["@cargo"], pid: dead });
	assert.equal(published(a)?.claims.find((c) => c.pattern === "@cargo")?.pid, undefined);
	const refused = await session(proj).then((b) => b.tool({ action: "claim", paths: ["@cargo"], pid: dead }));
	assert.ok(refused.isError, "a held lock is still refused, pid or not");
	assert.doesNotMatch(refused.text, /is not running, so this is a normal claim/);
});

test("a claim tied to a running process outlives its TTL while the owner is idle, and its release comes with the process's exit", async (t) => {
	withEnv(t, "PI_TELECOM_CLAIM_TTL_MIN", HOLD_TTL_MIN);
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-pid-hold");
	const a = await session(proj);
	const b = await session(proj);
	const job = await startJob();
	const pid = job.pid as number;
	const claimed = await a.tool({ action: "claim", paths: ["@cargo", "src/**"], message: "the epoch batch", pid });
	assert.ok(!claimed.isError, claimed.text);
	assert.match(claimed.text, new RegExp(`kept while process ${pid} runs`));
	assert.match(claimed.text, new RegExp(`It stays yours while process ${pid} runs, and is released when it exits`));
	for (const c of published(a)?.claims ?? []) {
		assert.equal(c.pid, pid, "every claim of the call carries the pid");
		assert.equal(c.pidStart, processStartTicks(pid) ?? undefined, "with its start time, where the platform gives one");
	}
	assert.ok(!(await b.tool({ action: "claim", paths: ["@cargo"], queue: true })).isError);
	const board = (await b.tool({ action: "board" })).text;
	assert.match(board, new RegExp(`@cargo — alpha, while pid ${pid} runs`));
	await sleep(PAST_TTL_MS); // idling past the TTL, many heartbeats
	assert.equal(published(a)?.claims.length, 2, "the batch still runs: both claims stay");
	assert.equal(lockMessages(b).length, 0);
	assert.equal(a.sentOf("telecom-claim").filter((m) => /expired/.test(m.content)).length, 0);

	await endJob(job);
	await eventually(() => assert.equal(published(a)?.claims.length, 0), 5_000);
	await eventually(() => assert.equal(lockMessages(b).length, 1), 5_000);
	const notice = a.sentOf("telecom-claim").find((m) => /claims released/.test(m.content));
	assert.match(notice?.content ?? "", new RegExp(`Process ${pid} exited, so src/\\*\\*, @cargo are released\\. Claim again if you still need them\\.`));
	assert.equal(notice?.options, undefined, "passive: an idle agent is not woken for it");
	await eventually(async () => assert.match(await logOf(a), new RegExp(`released src/\\*\\*, @cargo: process ${pid} exited`)));
});

test("a claim for a process that exits is logged as exactly that, and a lock goes to the first in line at once", async (t) => {
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-pid-exit");
	const a = await session(proj);
	const b = await session(proj);
	const job = await startJob();
	const pid = job.pid as number;
	await a.tool({ action: "claim", paths: ["@cargo"], pid });
	await b.tool({ action: "claim", paths: ["@cargo"], queue: true });
	await endJob(job);
	await eventually(() => assert.equal(lockMessages(b).length, 1), 5_000);
	assert.match(lockMessages(b)[0]?.content ?? "", /@cargo is yours now/);
	await eventually(async () => assert.match(await logOf(a), new RegExp(`released @cargo: process ${pid} exited`)));
	assert.equal(published(a)?.claims.length, 0);
	assert.equal(published(b)?.claims[0]?.pattern, "@cargo");
});

test("a claim made again without a pid keeps the one it had; with one, replaces it", async () => {
	const proj = makeProject("p-pid-renew");
	const a = await session(proj);
	const one = await startJob();
	const two = await startJob();
	await a.tool({ action: "claim", paths: ["@cargo"], pid: one.pid });
	await a.tool({ action: "claim", paths: ["@cargo"] });
	assert.equal(published(a)?.claims[0]?.pid, one.pid);
	await a.tool({ action: "claim", paths: ["@cargo"], pid: two.pid });
	assert.equal(published(a)?.claims[0]?.pid, two.pid);
	await a.tool({ action: "release", paths: ["@cargo"] });
	await a.tool({ action: "claim", paths: ["@cargo"] });
	assert.equal(published(a)?.claims[0]?.pid, undefined, "a released claim leaves nothing behind");
});

// ---------------------------------------------------------------- a freeze while waiting

test("claims are kept past the TTL while the owner waits on a live teammate, and lapse once the wait is cleared", async (t) => {
	withEnv(t, "PI_TELECOM_CLAIM_TTL_MIN", HOLD_TTL_MIN);
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-freeze");
	const a = await session(proj);
	await session(proj);
	await a.tool({ action: "claim", paths: ["src/auth/**", "@cargo"], message: "frozen until delta commits" });
	await a.tool({ action: "status", message: "claims held until delta commits", waitingFor: ["bravo"] });
	await sleep(PAST_TTL_MS);
	assert.equal(published(a)?.claims.length, 2, "the freeze has no edits to renew with, and holds");
	assert.equal(a.sentOf("telecom-claim").filter((m) => /expired/.test(m.content)).length, 0);

	await a.tool({ action: "status", message: "delta is done", waitingFor: [] });
	assert.equal(published(a)?.blockedOn, undefined);
	await eventually(() => assert.equal(published(a)?.claims.length, 0), 5_000);
	const notice = a.sentOf("telecom-claim").find((m) => /2 claims expired/.test(m.content));
	assert.match(notice?.content ?? "", /No activity inside it for [\d.]+ minutes/);
	assert.match(notice?.content ?? "", /@cargo was not claimed again within [\d.]+ minutes while you were idle/);
	assert.match(notice?.content ?? "", /Expired: src\/auth\/\*\*\./);
});

test("a forgotten wait does not hold claims: the freeze ends once the awaited teammate has done nothing for long", async (t) => {
	withEnv(t, "PI_TELECOM_CLAIM_TTL_MIN", HOLD_TTL_MIN);
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-freeze-forgotten");
	const a = await session(proj);
	const now = Date.now();
	const away = (extra: Partial<Presence>): Presence =>
		record({
			id: "idle-session-0001", callsign: "zulu", pid: process.ppid, ticks: processStartTicks(process.ppid), cwd: proj, projectRoot: findProjectRoot(proj),
			stateSince: now - 3 * 60 * 60_000, startedAt: 1, ...extra,
		});
	const transport = openTransport(process.env.PI_TELECOM_DIR as string);
	// Idle for three hours, heartbeat fresh, with no job running: not at work.
	transport.writePresence(away({}));
	await a.tool({ action: "claim", paths: ["src/auth/**"] });
	await eventually(async () => assert.ok(!(await a.tool({ action: "status", message: "waiting for zulu", waitingFor: ["zulu"] })).isError));
	await eventually(() => assert.equal(published(a)?.claims.length, 0), 5_000);
	const lapsed = a.sentOf("telecom-claim").filter((m) => /claim expired/.test(m.content));
	assert.equal(lapsed.length, 1);

	// The same teammate idle just as long, but with its background job running (a claim tied to a pid): at work.
	const job = await startJob();
	transport.writePresence(away({ claims: [{ pattern: "@cargo", since: now, expiresAt: now + 3_600_000, pid: job.pid as number }] }));
	await a.tool({ action: "claim", paths: ["src/ui/**"] });
	await sleep(PAST_TTL_MS);
	assert.equal(published(a)?.claims.length, 1, "its job runs, so the wait still holds");
	transport.removePresence("idle-session-0001");
});

test("a wait on a teammate that has left does not freeze claims", async (t) => {
	withEnv(t, "PI_TELECOM_CLAIM_TTL_MIN", HOLD_TTL_MIN);
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-freeze-gone");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "claim", paths: ["src/auth/**"] });
	await a.tool({ action: "status", message: "waiting for bravo", waitingFor: ["bravo"] });
	await sleep(PAST_TTL_MS);
	assert.equal(published(a)?.claims.length, 1, "bravo is still here, so the wait holds");
	await b.stop();
	await eventually(() => assert.equal(published(a)?.claims.length, 0), 8_000);
});

// ---------------------------------------------------------------- wording

test("a lapsed path claim and a lapsed lock are logged as what they are", async (t) => {
	withEnv(t, "PI_TELECOM_CLAIM_TTL_MIN", "0.005");
	withEnv(t, "PI_TELECOM_HEARTBEAT_MS", "40");
	const proj = makeProject("p-expiry-wording");
	const a = await session(proj);
	await session(proj);
	await a.tool({ action: "claim", paths: ["src/a.ts", "docs/b.md", "@cargo"] });
	await eventually(async () => {
		const log = await logOf(a);
		assert.match(log, /claim expired \(no edits inside for [\d.]+ min\): src\/a\.ts, docs\/b\.md/);
		assert.match(log, /lock lapsed \(not claimed again within [\d.]+ min\): @cargo/);
		assert.doesNotMatch(log, /expired unused/);
	}, 5_000);
});

test("jobRuns: a job that exited but is not reaped yet has finished, though its pid still answers", { skip: process.platform !== "linux" }, async () => {
	// sh starts `sleep 0` and then becomes `sleep 60` (exec), which never reaps it: a zombie.
	const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
	jobs.push(parent);
	const pid = Number(await new Promise<string>((resolve) => parent.stdout?.once("data", (d) => resolve(String(d).trim()))));
	await eventually(() => assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /\) Z /));
	assert.equal(isAlive(pid, null), true, "a signal still reaches it");
	assert.equal(jobRuns(pid, null), false);
	assert.equal(jobRuns(parent.pid as number, null), true);
});
