/** Filesystem portability through real extension sessions, on each runner's native volume. */
import assert from "node:assert/strict";
import fs, { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { eventually, makeProject, NOTICE_WAIT_MS, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

test("portable sessions: symlink aliases share a team, notices and the stale-write guard", async () => {
	const dir = makeProject("p-portable aliases [copy] & café");
	const alias = `${dir}-alias`;
	symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
	writeFileSync(join(dir, "résumé.txt"), "before");
	const a = await session(dir);
	const b = await session(alias);
	const board = await a.tool({ action: "board" });
	assert.match(board.text, /1 other agent live/);
	await a.read("résumé.txt");
	assert.equal((await b.edit("résumé.txt", "before", "after")).blocked, undefined);
	await eventually(() => assert.equal(a.sentOf("telecom-change").length, 1), NOTICE_WAIT_MS);
	assert.ok((await a.write("résumé.txt", "stale")).blocked, "different directory spellings must not hide peer changes");
});

test("portable sessions: one failed presence write is not a warning; a write that keeps failing is", async (t) => {
	const dir = makeProject("p-portable presence lock");
	const a = await session(dir);
	const rename = t.mock.method(fs, "renameSync", () => {
		throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
	});
	try {
		syncBuiltinESMExports();
		await a.command("name kilo");
		assert.ok(!a.notified.some((n) => /telecom presence/.test(n)), `a passing lock stays quiet: ${a.notified.join(" | ")}`);
		await a.command("name lima");
		await a.command("name mike");
		assert.equal(a.notified.filter((n) => /telecom presence/.test(n)).length, 1, "a write that keeps failing is reported once");
	} finally {
		rename.mock.restore();
		syncBuiltinESMExports();
	}
});

test("portable sessions: claims distinguish a direct child from deeper native paths", async () => {
	const dir = makeProject("p-portable claims [copy]");
	mkdirSync(join(dir, "src", "nested"), { recursive: true });
	const a = await session(dir);
	const b = await session(dir);
	const claim = await a.tool({ action: "claim", paths: ["src/*.ts"] });
	assert.equal(claim.isError, false, claim.text);
	assert.equal((await b.write(join("src", "nested", "free.ts"), "free")).blocked, undefined);
	assert.ok((await b.write(join("src", "claimed.ts"), "held")).blocked);
});
