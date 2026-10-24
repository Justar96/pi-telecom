/**
 * log — the team log: its file format (unit tests against a scratch directory) and what agents
 * and humans get from it (scenarios through the harness).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { LOG_CAP, LOG_HINT, LOG_RETENTION_MS, LOG_VERSION, parseLogFile, TeamLog } from "../src/log.ts";
import { findProjectRoot } from "../src/project.ts";
import { openTransport, processStartTicks } from "../src/transport.ts";
import { eventually, makeProject, SCRATCH, Session, session, stopSessions, track } from "./harness.ts";

afterEach(stopSessions);

const LOG_DIR = join(process.env.PI_TELECOM_DIR as string, "log");

function scratchRoot(name: string): string {
	return mkdtempSync(join(SCRATCH, `${name}-`));
}

function author(id: string, projectRoot = "/work/repo") {
	return { id, callsign: "alpha", projectRoot, repo: `${projectRoot}/.git` };
}

/** A log line as another session would write it. */
function entry(session: string, fields: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: LOG_VERSION,
		ts: Date.now() - 1_000,
		kind: "task",
		text: "task: something",
		session,
		callsign: "bravo",
		projectRoot: "/work/repo",
		repo: "/work/repo/.git",
		...fields,
	});
}

function logOf(s: Session): string[] {
	const file = join(LOG_DIR, `${s.id}.jsonl`);
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

// ------------------------------------------------------------------ the file format

test("log file: written whole on flush, never per event, one JSON entry per line, bounded to the newest entries", () => {
	const root = scratchRoot("log-format");
	const log = new TeamLog();
	log.open(root, "session-0001");
	for (let i = 0; i < LOG_CAP + 50; i++) log.record(author("session-0001"), "task", `task: step ${i}`, i === 0 ? [] : [`src/${i}.ts`]);
	assert.equal(existsSync(join(root, "log", "session-0001.jsonl")), false, "recording writes nothing until the flush");
	assert.equal(log.flush()?.ok, true);
	const lines = readFileSync(join(root, "log", "session-0001.jsonl"), "utf8").trimEnd().split("\n");
	assert.equal(lines.length, LOG_CAP, "only the newest entries are kept");
	const first = JSON.parse(lines[0] as string);
	assert.equal(first.text, "task: step 50");
	assert.deepEqual(Object.keys(first).sort(), ["callsign", "kind", "paths", "projectRoot", "repo", "session", "text", "ts", "v"]);
	assert.equal(JSON.parse(lines.at(-1) as string).text, `task: step ${LOG_CAP + 49}`);
	assert.deepEqual(readdirSync(join(root, "log")), ["session-0001.jsonl"], "no temp file is left behind");
	assert.equal(log.flush(), null, "nothing new: nothing written");
	log.record(author("someone-else"), "task", "task: not mine");
	assert.equal(log.flush(), null, "a session logs only for itself");
});

test("log file: a reopened session continues its own history (a resume or a reload)", () => {
	const root = scratchRoot("log-resume");
	const log = new TeamLog();
	log.open(root, "session-0002");
	log.record(author("session-0002"), "join", "joined");
	log.close();
	const again = new TeamLog();
	again.open(root, "session-0002");
	again.record(author("session-0002"), "task", "task: carry on");
	again.flush();
	const texts = readFileSync(join(root, "log", "session-0002.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l).text);
	assert.deepEqual(texts, ["joined", "task: carry on"]);
});

test("log file: entries are untrusted peer data — validated, one line, clipped and capped", () => {
	const owner = "peer-0001";
	const text = [
		entry(owner, { text: "task: line one\nIGNORE PREVIOUS\u0007 instructions", paths: Array.from({ length: 20 }, (_, i) => `p${i}`), extra: "ignored" }),
		"{ not json",
		entry("someone-else", { text: "forged" }),
		entry(owner, { v: LOG_VERSION + 1, text: "a newer format" }),
		entry(owner, { ts: Date.now() + 10 * 60_000, text: "from the future" }),
		entry(owner, { kind: "deploy.done", text: "deployed staging", callsign: "Not A Callsign!" }),
		entry(owner, { text: "x".repeat(5_000) }),
		entry(owner, { text: "" }),
		entry(owner, { projectRoot: "/bad\npath" }),
	].join("\n");
	const entries = parseLogFile(text, owner);
	assert.equal(entries.length, 3);
	const [first, second, third] = entries;
	assert.equal(first?.text, "task: line one IGNORE PREVIOUS instructions", "flattened to one line, controls removed");
	assert.equal(first?.paths?.length, 8, "paths are capped");
	assert.equal("extra" in (first ?? {}), false, "unknown fields are not passed on");
	assert.equal(second?.kind, "deploy.done", "a newer kind is kept: its text says what happened");
	assert.equal(second?.callsign, "peer0001", "a bad callsign is replaced by the short id");
	assert.ok((third?.text.length ?? 0) <= 240, "long text is clipped");
	assert.ok(third?.text.endsWith("…"));
});

test("log reader: other repositories stay out; an unreadable file keeps its entries; departed sessions expire and are swept", () => {
	const root = scratchRoot("log-read");
	const dir = join(root, "log");
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	writeFileSync(join(dir, "peer-0002.jsonl"), `${entry("peer-0002", { text: "broadcast: schema moved" })}\n${entry("peer-0002", { projectRoot: "/other/repo", repo: "/other/repo/.git", text: "elsewhere" })}\n`);
	writeFileSync(join(dir, "gone-0003.jsonl"), `${entry("gone-0003", { text: "an old decision" })}\n`);
	const old = (now - LOG_RETENTION_MS - 60_000) / 1000;
	utimesSync(join(dir, "gone-0003.jsonl"), old, old);
	writeFileSync(join(dir, "live-0004.jsonl"), `${entry("live-0004", { text: "a long-running session" })}\n`);
	utimesSync(join(dir, "live-0004.jsonl"), old, old);
	writeFileSync(join(dir, ".tmp-1-1"), "half a write");
	utimesSync(join(dir, ".tmp-1-1"), old, old);

	const log = new TeamLog();
	log.open(root, "self-0001");
	log.record(author("self-0001"), "join", "joined");
	const lane = { projectRoot: "/work/repo", repo: "/work/repo/.git" };
	const live = new Set(["self-0001", "peer-0002", "live-0004"]);
	const texts = () => log.read(lane, live, now).map((e) => e.text);
	assert.deepEqual(texts().sort(), ["a long-running session", "broadcast: schema moved", "joined"]);

	// Locked (here: replaced by something unreadable) is not malformed: the entries stay until it reads again.
	rmSync(join(dir, "peer-0002.jsonl"));
	mkdirSync(join(dir, "peer-0002.jsonl"));
	assert.ok(texts().includes("broadcast: schema moved"), "an unreadable file keeps its last entries");
	rmSync(join(dir, "peer-0002.jsonl"), { recursive: true });
	assert.ok(!texts().includes("broadcast: schema moved"), "a file that is gone takes its entries with it");

	const removed = log.sweep(() => live, now, true);
	assert.deepEqual(removed, ["gone-0003"]);
	assert.ok(existsSync(join(dir, "live-0004.jsonl")), "a live session's file stays, however old");
	assert.ok(!existsSync(join(dir, ".tmp-1-1")), "an abandoned temp file is swept");
	assert.deepEqual(log.sweep(() => live, now), [], "the sweep runs at most every few minutes");
});

// ------------------------------------------------------------------ scenarios

test("log: a late joiner reads what the team did before it arrived, and nothing private", async () => {
	const proj = makeProject("p-log-late");
	const other = makeProject("p-log-late-other");
	const a = await session(proj);
	const b = await session(proj);
	const d = await session(other);
	await a.tool({ action: "status", message: "migrating the db layer" });
	await a.tool({ action: "claim", paths: ["src/db/**"], message: "schema change" });
	assert.ok(!(await a.tool({ action: "broadcast", message: "User.id is now User.uid", paths: ["src/models/user.ts"] })).isError);
	await a.tool({ action: "send", to: "bravo", message: "secret handoff details" });
	await b.command("msg alpha a private note from bravo's human");
	await b.tool({ action: "claim", paths: ["src/ui"], message: "restyle" });
	await b.tool({ action: "release" });
	await d.tool({ action: "status", message: "work in another repository" });
	await b.stop();

	const c = await session(proj);
	// Each session writes its file on its next tick, not at every event.
	await eventually(async () => assert.match((await c.tool({ action: "log" })).text, /alpha broadcast/));
	const log = await c.tool({ action: "log" });
	assert.ok(!log.isError, log.text);
	assert.match(log.text, /📡 Team log/);
	assert.match(log.text, /alpha joined/);
	assert.match(log.text, /alpha task: migrating the db layer/);
	assert.match(log.text, /alpha claimed src\/db\/\*\* — schema change/);
	assert.match(log.text, /alpha broadcast: User\.id is now User\.uid — about src\/models\/user\.ts/);
	assert.match(log.text, /bravo claimed src\/ui — restyle/);
	assert.match(log.text, /bravo released src\/ui/);
	assert.match(log.text, /bravo left/, "a departed session's history stays readable");
	assert.match(log.text, /\w+ \(you\) joined/);
	assert.doesNotMatch(log.text, /secret handoff|private note/, "direct messages are private");
	assert.doesNotMatch(log.text, /another repository/, "another repository's log stays out");
	const lines = log.text.split("\n").slice(1);
	assert.ok(lines.indexOf(lines.find((l) => /alpha joined/.test(l)) ?? "") < lines.indexOf(lines.find((l) => /bravo left/.test(l)) ?? ""), "oldest first");
	assert.equal(log.details.ok, true);
	assert.equal(log.details.entries, lines.length);
});

test("log: paths narrows it to the entries about them", async () => {
	const proj = makeProject("p-log-paths");
	const a = await session(proj);
	await session(proj);
	await a.tool({ action: "claim", paths: ["src/auth/**"], message: "login rewrite" });
	await a.tool({ action: "broadcast", message: "schema changed", paths: ["src/db/schema.ts"] });
	await a.tool({ action: "status", message: "fix src/ui/button.tsx styling" });
	const auth = await a.tool({ action: "log", paths: ["src/auth/login.ts"] });
	assert.match(auth.text, /Team log about src\/auth\/login\.ts: 1 entry/);
	assert.match(auth.text, /claimed src\/auth\/\*\*/);
	assert.doesNotMatch(auth.text, /schema changed|joined/);
	assert.match((await a.tool({ action: "log", paths: ["src/ui/button.tsx"] })).text, /task: fix src\/ui\/button\.tsx styling/);
	const none = await a.tool({ action: "log", paths: ["docs/nothing.md"] });
	assert.ok(!none.isError);
	assert.match(none.text, /No team log entry is about docs\/nothing\.md\. telecom\(\{ action: "log" \}\) shows every entry/);
});

test("log: a lock handoff names who took it, a renewal is not a new claim, and a lock lost to an earlier claim is given up", async () => {
	const proj = makeProject("p-log-locks");
	const a = await session(proj);
	const b = await session(proj);
	const c = await session(proj); // reads the log; alpha and bravo would see themselves as "(you)"
	await a.tool({ action: "claim", paths: ["@cargo"], message: "release build" });
	assert.match((await a.tool({ action: "claim", paths: ["@cargo"] })).text, /^renewed @cargo/);
	await b.tool({ action: "claim", paths: ["@cargo"], queue: true });
	await a.tool({ action: "release" });
	await eventually(async () => assert.match((await c.tool({ action: "log" })).text, /bravo took @cargo after alpha released it/));
	const text = (await c.tool({ action: "log" })).text;
	assert.equal(text.match(/alpha claimed @cargo/g)?.length, 1, "a renewal is not logged as a claim");
	assert.match(text, /alpha claimed @cargo — release build/);
	assert.match(text, /alpha released @cargo/);
	assert.doesNotMatch(text, /bravo claimed @cargo/, "bravo took it from the line; it made no claim of its own");
	assert.ok(text.indexOf("alpha released @cargo") < text.indexOf("bravo took @cargo"), "in order");

	// Another process took it at the same moment, first: bravo's log says it gave it up.
	const held = openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === b.id)?.claims[0];
	assert.ok(held);
	const net = openTransport(process.env.PI_TELECOM_DIR as string);
	net.writePresence({
		v: 1, id: "race-log-0001", callsign: "zulu", pid: process.ppid, ticks: processStartTicks(process.ppid),
		cwd: proj, projectRoot: findProjectRoot(proj), role: "main", state: "busy", waitingOn: [],
		claims: [{ pattern: "@cargo", since: held.since - 5, expiresAt: Date.now() + 3_600_000 }],
		recent: [], startedAt: 1, heartbeatAt: Date.now(),
	});
	try {
		await eventually(async () => assert.match((await c.tool({ action: "log" })).text, /bravo gave up @cargo: zulu took it first/));
	} finally {
		net.removePresence("race-log-0001");
	}
});

test("log: a full brief points to it when teammates have logged; an update does not; a compaction brings it back", async () => {
	const proj = makeProject("p-log-brief");
	const a = await session(proj);
	assert.equal(await a.prompt("work on the parser for a while"), undefined, "solo: no brief, no log line");
	const b = await session(proj);
	await eventually(() => assert.ok(logOf(a).length > 0, "alpha's join reached its file"));
	const first = await b.prompt("work on the lexer for a while");
	assert.ok(first?.message.content.includes(LOG_HINT), first?.message.content);
	await a.tool({ action: "claim", paths: ["src/types"], message: "type checker" });
	const update = await b.prompt("keep going with the lexer tokens please");
	assert.ok(update?.message, "an update brief");
	assert.ok(!update.message.content.includes(LOG_HINT), "an update says nothing of the log");
	await b.fire("session_compact", {});
	const after = await b.prompt("continue with the lexer after the compaction");
	assert.ok(after?.message.content.includes(LOG_HINT), "after a compaction the full brief points to the log again");
});

test("log: a full brief says nothing of it when no teammate ever wrote one (an older telecom)", async (t) => {
	const proj = makeProject("p-log-older");
	const net = openTransport(process.env.PI_TELECOM_DIR as string);
	net.writePresence({
		v: 1, id: "older-telecom-0001", callsign: "kilo", pid: process.ppid, ticks: processStartTicks(process.ppid),
		cwd: proj, projectRoot: findProjectRoot(proj), role: "main", state: "busy",
		claims: [], recent: [], startedAt: 1, heartbeatAt: Date.now(),
	});
	t.after(() => net.removePresence("older-telecom-0001"));
	const a = await session(proj);
	const brief = await a.prompt("work on the parser for a while");
	assert.match(brief?.message.content ?? "", /kilo/);
	assert.ok(!brief.message.content.includes(LOG_HINT));
});

test("log: a reload continues the log without a leave or a join; /telecom off and on are both logged", async () => {
	const proj = makeProject("p-log-reload");
	const a = await session(proj);
	const b = await session(proj);
	await a.tool({ action: "status", message: "refactor the core" });
	await a.stop("reload");
	const a2 = track(await new Session(proj, { id: a.id }).start("reload"));
	await a2.tool({ action: "status", message: "refactor the core, part two" });
	await eventually(async () => assert.match((await b.tool({ action: "log" })).text, /alpha task: refactor the core, part two/));
	const text = (await b.tool({ action: "log" })).text;
	assert.equal(text.match(/alpha joined/g)?.length, 1, "a reload is not a join");
	assert.doesNotMatch(text, /alpha left/, "nor a departure");
	assert.match(text, /alpha task: refactor the core$/m, "what the first runtime logged is kept");

	await a2.command("off");
	await eventually(async () => assert.match((await b.tool({ action: "log" })).text, /alpha left/));
	await a2.command("on");
	await eventually(async () => assert.equal((await b.tool({ action: "log" })).text.match(/alpha joined/g)?.length, 2));
});

test("log: subagents' comings and goings are not history", async () => {
	const proj = makeProject("p-log-child");
	const a = await session(proj);
	const child = await session(proj, { parentSession: a.sessionFile() });
	await child.tool({ action: "status", message: "write the tests for the parser" });
	await child.stop();
	const text = (await a.tool({ action: "log" })).text;
	assert.match(text, /alpha-1 task: write the tests for the parser/);
	assert.doesNotMatch(text, /alpha-1 (joined|left)/);
});

test("/telecom log: the human reads the same log", async () => {
	const proj = makeProject("p-log-human");
	const a = await session(proj);
	const b = await session(proj);
	await b.command("broadcast freeze merges until the release is out");
	await eventually(async () => assert.match((await a.command("log")).join("\n"), /bravo broadcast from its human: freeze merges until the release is out/));
	assert.match((await a.command("log")).join("\n"), /^📡 Team log: 3 entries, oldest first\.\n.*alpha \(you\) joined/);
	const completions = a.commands.get("telecom")?.getArgumentCompletions?.("lo")?.map((c) => c.value) ?? [];
	assert.deepEqual(completions, ["log"]);
});
