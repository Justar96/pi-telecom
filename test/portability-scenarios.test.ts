/** Filesystem portability through real extension sessions, on each runner's native volume. */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { eventually, makeProject, session, stopSessions } from "./harness.ts";

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
	await eventually(() => assert.equal(a.sentOf("telecom-change").length, 1));
	assert.ok((await a.write("résumé.txt", "stale")).blocked, "different directory spellings must not hide peer changes");
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
