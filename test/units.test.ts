import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mustYield, pickCallsign } from "../src/callsign.ts";
import { readConfig } from "../src/config.ts";
import { claimsOverlap, matchesClaim } from "../src/glob.ts";
import { createAskLedger } from "../src/ledger.ts";
import { canonicalPath, displayPath, findProjectRoot, readBranch } from "../src/project.ts";
import { openTransport, type Presence, parseEnvelope, transportRoot } from "../src/transport.ts";

const R = "/work/proj";

test("claims: plain paths cover a file or a whole directory", () => {
	assert.ok(matchesClaim(`${R}/src/auth/login.ts`, "src/auth", R));
	assert.ok(matchesClaim(`${R}/src/auth/login.ts`, "src/auth/", R));
	assert.ok(matchesClaim(`${R}/src/auth/login.ts`, "./src/auth/**", R));
	assert.ok(matchesClaim(`${R}/src/auth`, "src/auth", R));
	assert.ok(!matchesClaim(`${R}/src/authz/x.ts`, "src/auth", R), "segment-wise, not prefix-wise");
	assert.ok(matchesClaim(`${R}/README.md`, "README.md", R));
});

test("claims: globs", () => {
	assert.ok(matchesClaim(`${R}/src/a/b/c.test.ts`, "src/**/*.test.ts", R));
	assert.ok(matchesClaim(`${R}/src/c.test.ts`, "src/**/*.test.ts", R));
	assert.ok(!matchesClaim(`${R}/src/c.ts`, "src/**/*.test.ts", R));
	assert.ok(matchesClaim(`${R}/src/api/x.ts`, "src/{api,db}/**", R));
	assert.ok(!matchesClaim(`${R}/src/ui/x.ts`, "src/{api,db}/**", R));
	assert.ok(matchesClaim(`${R}/pkg/core/internal/a.ts`, "pkg/*/internal", R), "a glob naming a dir claims its contents");
});

test("claims: overlap", () => {
	assert.ok(claimsOverlap("src/auth", "src/auth/login.ts", R));
	assert.ok(claimsOverlap("src", "src/auth/**", R));
	assert.ok(!claimsOverlap("src/auth", "src/db", R));
	assert.ok(claimsOverlap("src/**/*.ts", "src/db", R));
	assert.ok(!claimsOverlap("docs/**", "src/**", R));
});

test("callsigns: first free NATO word, persisted preference, convergence", () => {
	assert.equal(pickCallsign(new Set()), "alpha");
	assert.equal(pickCallsign(new Set(["alpha", "bravo"])), "charlie");
	assert.equal(pickCallsign(new Set(["alpha"]), "kilo"), "kilo");
	assert.equal(pickCallsign(new Set(["kilo"]), "kilo"), "alpha");
	const base = { projectRoot: R, callsign: "alpha" } as Presence;
	const older = { ...base, id: "a", startedAt: 1 } as Presence;
	const younger = { ...base, id: "b", startedAt: 2 } as Presence;
	assert.ok(mustYield(younger, [older, younger]));
	assert.ok(!mustYield(older, [older, younger]));
	assert.ok(!mustYield(younger, [{ ...older, projectRoot: "/other" }, younger]), "other projects do not collide");
});

test("project: git root, branch, canonical and display paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "telecom-proj-"));
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	assert.equal(findProjectRoot(join(dir, "src", "deep")), findProjectRoot(dir));
	assert.equal(readBranch(dir), "feature/x");
	const root = findProjectRoot(dir);
	assert.equal(canonicalPath("@src/a.ts", join(root, "src", "..")), join(root, "src", "a.ts"));
	assert.equal(canonicalPath("src/new/file.ts", root), join(root, "src", "new", "file.ts"));
	assert.equal(displayPath(join(root, "src", "a.ts"), root), "src/a.ts");
	assert.equal(displayPath("/elsewhere/x", root), "/elsewhere/x");
	// A worktree: .git is a file pointing at the real git dir.
	const wt = mkdtempSync(join(tmpdir(), "telecom-wt-"));
	mkdirSync(join(dir, ".git", "worktrees", "wt"), { recursive: true });
	writeFileSync(join(dir, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/wt-branch\n");
	writeFileSync(join(wt, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "wt")}\n`);
	assert.equal(readBranch(wt), "wt-branch");
});

test("config: defaults and validation", () => {
	const cfg = readConfig({});
	assert.equal(cfg.guard, "standard");
	assert.equal(cfg.askTimeoutMs, 300_000);
	assert.equal(readConfig({ PI_TELECOM_GUARD: "STRICT" }).guard, "strict");
	assert.equal(readConfig({ PI_TELECOM_GUARD: "nonsense" }).guard, "standard");
	assert.equal(readConfig({ PI_TELECOM_ASK_TIMEOUT_MS: "-5" }).askTimeoutMs, 300_000);
	assert.equal(readConfig({ PI_TELECOM_CALLSIGN: "Bad Name!" }).callsign, undefined);
	assert.equal(readConfig({ PI_TELECOM_CALLSIGN: "Ops" }).callsign, "ops");
	assert.equal(readConfig({ PI_TELECOM_DISABLE: "1" }).disabled, true);
});

test("transport: root safety, delivery order, validation, sweep of dead sessions", () => {
	const base = mkdtempSync(join(tmpdir(), "telecom-root-"));
	const pinned = transportRoot({ PI_TELECOM_DIR: join(base, "sb") });
	assert.ok(pinned.ok);
	const fallback = transportRoot({ XDG_RUNTIME_DIR: join(base, "missing") });
	assert.ok(fallback.ok && fallback.path.includes("pi-telecom-"), "falls back under the OS temp dir");
	if (!pinned.ok) return;
	const t = openTransport(pinned.path);
	const presence = (id: string, pid: number): Presence => ({
		v: 1, id, callsign: id, pid, ticks: null, cwd: "/x", projectRoot: "/x", role: "main",
		state: "idle", claims: [], recent: [], startedAt: 1, heartbeatAt: 1,
	});
	assert.ok(t.writePresence(presence("live", process.pid)).ok);
	assert.ok(t.writePresence(presence("dead", 2 ** 22 + 12345)).ok);
	assert.deepEqual(t.readPeers().map((p) => p.id), ["live"]);
	assert.deepEqual(t.sweep(), ["dead"]);
	for (const n of [1, 2, 3]) {
		const sent = t.deliver({ v: 1, id: `m${n}`, ts: n, from: "dead", fromCallsign: "d", to: "live", kind: "message", text: `n${n}` });
		assert.ok(sent.ok);
	}
	assert.deepEqual(t.drain("live").envelopes.map((e) => e.text), ["n1", "n2", "n3"]);
	assert.equal(t.drain("live").envelopes.length, 0, "drain removes");
	assert.equal(parseEnvelope({ v: 1, id: "../x", ts: 1, from: "a", to: "b", kind: "message", text: "" }), null);
	assert.equal(parseEnvelope({ v: 1, id: "x", ts: 1, from: "a", to: "b", kind: "answer", text: "" }), null, "answer needs answerTo");
	const big = t.deliver({ v: 1, id: "big", ts: 1, from: "a", fromCallsign: "a", to: "live", kind: "message", text: "x".repeat(40_000) });
	assert.ok(!big.ok);
});

test("ledger: answer, timeout, interruption, peer gone, late replies", async () => {
	const ledger = createAskLedger();
	const meta = { to: "peer", toCallsign: "bravo", text: "q?" };
	const answered = ledger.awaitAnswer("a1", meta, 10_000);
	assert.ok(ledger.settle("a1", "yes", "bravo"));
	assert.deepEqual(await answered, { ok: true, text: "yes", fromCallsign: "bravo" });

	const timed = ledger.awaitAnswer("a2", meta, 1);
	await new Promise((r) => setTimeout(r, 5));
	ledger.expire(Date.now());
	const t = await timed;
	assert.ok(!t.ok && /did not answer/.test(t.reason));
	assert.deepEqual(ledger.wasAbandoned("a2"), { toCallsign: "bravo", text: "q?" });

	const interrupted = ledger.awaitAnswer("a3", meta, 10_000);
	ledger.interruptAll({ id: "in1", from: "peer", fromCallsign: "bravo", text: "and you?", at: 1, reminded: false });
	const i = await interrupted;
	assert.ok(!i.ok && i.interruptedBy?.id === "in1");

	const gone = ledger.awaitAnswer("a4", meta, 10_000);
	ledger.failPeerGone((id) => id === "peer");
	const g = await gone;
	assert.ok(!g.ok && /ended/.test(g.reason));

	const controller = new AbortController();
	const aborted = ledger.awaitAnswer("a5", meta, 10_000, controller.signal);
	controller.abort();
	const a = await aborted;
	assert.ok(!a.ok && /aborted/.test(a.reason));
	assert.equal(ledger.outboundCount(), 0);
});
