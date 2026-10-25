/**
 * briefs — what a brief describes in a big team and how long its lines run: who counts as a
 * recent contact, the cap on listed claims, paths outside the repository, and the status budget.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { makeProject, makeWorktree, SCRATCH, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

const CONTACT_WINDOW_MS = 30 * 60_000;

/** Run `fn` with the clock `ms` ahead: how a contact from long ago looks, without waiting for it. */
async function inTheFuture<T>(ms: number, fn: () => Promise<T>): Promise<T> {
	const real = Date.now;
	Date.now = () => real() + ms;
	try {
		return await fn();
	} finally {
		Date.now = real;
	}
}

test("briefs: only a recent contact pulls a peer into the full brief, in a team past the describe-all size", async () => {
	const proj = makeProject("p-briefs-contacts");
	const a = await session(proj);
	const others = [await session(proj), await session(proj), await session(proj), await session(proj), await session(proj)];
	const tasks = ["release notes", "the build", "the api layer", "docs", "benchmarks"];
	for (const [i, s] of others.entries()) await s.prompt(tasks[i] as string);
	// bravo and charlie are contacts now; delta only comes later, after 30 minutes have passed.
	await a.tool({ action: "send", to: "bravo", message: "ping me when the notes are in" });
	await a.tool({ action: "send", to: "charlie", message: "ping me when the build is green" });
	// The clock stays ahead for the rest, so bravo and charlie are old contacts throughout.
	await inTheFuture(CONTACT_WINDOW_MS + 60_000, async () => {
		await a.tool({ action: "send", to: "delta", message: "which docs?" });
		const full = (await a.prompt("work on something else"))?.message?.content ?? "";
		assert.match(full, /5 other agents are working/);
		assert.match(full, /• delta \[[^\]]*\][^\n]*\n\s+task: the api layer/, "talked with it a minute ago");
		assert.doesNotMatch(full, /• bravo|• charlie/, "talked with them over half an hour ago");
		assert.match(full, /Also here, not near your work so far: bravo \[busy\] release notes; charlie \[busy\] the build/);
		// Peers that are far all along are no news.
		assert.equal(await a.prompt("again"), undefined, "no update for peers that are far all along");
		// Talking with one makes it near, and it is described once, as it is now.
		await a.tool({ action: "send", to: "echo", message: "are the docs done?" });
		assert.match((await a.prompt("more"))?.message?.content ?? "", /• now working near you: echo/);
	});
});

test("briefs: a peer described and then far again produces no update, and its held news arrives once it is near", async () => {
	const proj = makeProject("p-briefs-held");
	const a = await session(proj);
	const [b, c, d, e] = [await session(proj), await session(proj), await session(proj), await session(proj)];
	await b.prompt("release notes");
	await c.prompt("the build");
	await d.prompt("docs");
	await e.prompt("benchmarks");
	await a.tool({ action: "send", to: "bravo", message: "ping me when the notes are in" });
	const full = (await a.prompt("work"))?.message?.content ?? "";
	assert.match(full, /• bravo \[busy\][^\n]*\n\s+task: release notes/);
	// Half an hour on, bravo is far. Its task changes meanwhile: held back, not news. (The clock
	// stays ahead for the rest: a move alone is also held for minutes after the last update.)
	await b.prompt("now the changelog");
	await inTheFuture(CONTACT_WINDOW_MS + 60_000, async () => {
		assert.equal(await a.prompt("later"), undefined, "a described peer going far is no news");
		// Near again: what changed since this agent was told is reported.
		await a.tool({ action: "send", to: "bravo", message: "how is the changelog?" });
		assert.match((await a.prompt("again"))?.message?.content ?? "", /• bravo is now on: now the changelog/);
	});
});

test("briefs: a peer's claims are capped at six in a brief, an update and the roster, and the board lists all", async () => {
	const proj = makeProject("p-briefs-claims");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("the gateway");
	const paths = Array.from({ length: 9 }, (_, i) => `crates/gw-${i}`);
	await b.tool({ action: "claim", paths });
	const full = (await a.prompt("work"))?.message?.content ?? "";
	const claimsLine = /claims: ([^\n]*)/.exec(full)?.[1] ?? "";
	assert.equal(claimsLine.split("crates/gw-").length - 1, 6, "six patterns listed");
	assert.match(claimsLine, /\+3 more \(telecom board\)$/);

	// The board is the on-demand view, with everything.
	const board = (await a.tool({ action: "board" })).text;
	for (const p of paths) assert.ok(board.includes(p), `board lists ${p}`);
	assert.doesNotMatch(board, /more \(telecom board\)/);

	// An update naming many new claims is capped the same way.
	const more = Array.from({ length: 8 }, (_, i) => `crates/new-${i}`);
	await b.tool({ action: "claim", paths: more });
	const update = (await a.prompt("next"))?.message?.content ?? "";
	assert.match(update, /• bravo claimed [^\n]*\+2 more \(telecom board\)/);
	assert.equal((/claimed ([^\n]*)/.exec(update)?.[1] ?? "").split("crates/new-").length - 1, 6);
	// ...while the next update still sees the true list: releasing one reports exactly that one.
	await b.tool({ action: "release", paths: ["crates/gw-0"] });
	assert.match((await a.prompt("last"))?.message?.content ?? "", /• bravo released crates\/gw-0$/m);
});

test("briefs: roster entries cap a far peer's claims", async () => {
	const proj = makeProject("p-briefs-roster");
	const a = await session(proj);
	const peers = [await session(proj), await session(proj), await session(proj), await session(proj)];
	for (const [i, s] of peers.entries()) await s.prompt(`task ${i}`);
	await peers[0]?.tool({ action: "claim", paths: Array.from({ length: 10 }, (_, i) => `far/p-${i}`) });
	const full = (await a.prompt("work"))?.message?.content ?? "";
	const entry = /bravo \[busy\][^;\n]*/.exec(full)?.[0] ?? "";
	assert.equal(entry.split("far/p-").length - 1, 6, entry);
	assert.match(entry, /\+4 more \(telecom board\)\)/);
});

test("briefs: a recently changed path outside the repository is left out of the brief and the board; one in a sibling worktree stays", async () => {
	const proj = makeProject("p-briefs-outside");
	writeFileSync(join(proj, "in.ts"), "x\n");
	// A worktree beside the checkout (`sols_market-polish` next to `sols_market`) is the same repository.
	const polish = makeWorktree(proj, "polish", "polish");
	writeFileSync(join(polish, "lane.ts"), "x\n");
	const outsideDir = join(SCRATCH, "outside-repo");
	mkdirSync(outsideDir, { recursive: true });
	const outside = join(outsideDir, "openapi_adr036.py");
	writeFileSync(outside, "x\n");
	const a = await session(proj);
	const b = await session(proj);
	await b.prompt("the gateway");
	await b.edit(join(polish, "lane.ts"), "x", "y");
	await b.edit("in.ts", "x", "y");
	await b.edit(outside, "x", "y");
	const full = (await a.prompt("work"))?.message?.content ?? "";
	assert.match(full, /recently changed: in\.ts \(/);
	assert.match(full, /lane\.ts in \S+polish/, "a sibling worktree is part of the repository");
	assert.doesNotMatch(full, /openapi_adr036/);
	const board = (await a.tool({ action: "board" })).text;
	assert.match(board, /recently changed: in\.ts \(/);
	assert.match(board, /lane\.ts in \S+polish/);
	assert.doesNotMatch(board, /openapi_adr036/);
});

test("status: a long status is kept whole on the board, shortened with a pointer in a brief, and never reported back as a correction", async () => {
	const proj = makeProject("p-briefs-status");
	const a = await session(proj);
	const b = await session(proj);
	const task = `Phase 3 accepted 4/4 at commit 980; strict SQL plus public positive opening is next. ${"evidence ".repeat(20)}`.trim();
	assert.ok(task.length > 200 && task.length < 400);
	const res = await b.tool({ action: "status", message: task });
	assert.ok(res.text.includes(task));
	assert.doesNotMatch(res.text, /cut to|characters/);
	const full = (await a.prompt("work"))?.message?.content ?? "";
	assert.match(full, /task: Phase 3 accepted 4\/4 at commit 980; [^\n]*… \(full: telecom board\)/);
	assert.ok(!full.includes(task));
	assert.ok(((await a.tool({ action: "board" })).text).includes(task), "the board shows it whole");
	// A status past the wire cap is cut quietly: the result shows what peers see.
	const huge = await b.tool({ action: "status", message: "x ".repeat(400) });
	assert.match(huge.text, /peers now see bravo: (x ){100,}x?…?/);
	assert.doesNotMatch(huge.text, /cut to/);
});
