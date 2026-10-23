import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { claimsOverlap, laneRelativePattern, matchesClaim } from "../src/glob.ts";
import { canonicalPath, findProjectRoot, findRepo, isWithin } from "../src/project.ts";
import { isId, openTransport, transportRoot, type Envelope, type Presence } from "../src/transport.ts";

function scratch(t: TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "telecom-portable-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// Exercise Node's actual Windows path rules on every runner. Restore the built-ins before
// yielding: these tests never turn a Windows path into a local filesystem write.
function windowsPaths(run: () => void): void {
	const keys = ["basename", "dirname", "isAbsolute", "join", "normalize", "parse", "relative", "resolve", "sep"] as const;
	const original = Object.fromEntries(keys.map((key) => [key, path[key]]));
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	try {
		Object.assign(path, Object.fromEntries(keys.map((key) => [key, path.win32[key]])));
		Object.defineProperty(process, "platform", { value: "win32" });
		syncBuiltinESMExports();
		run();
	} finally {
		Object.assign(path, original);
		Object.defineProperty(process, "platform", platform);
		syncBuiltinESMExports();
	}
}

test("portability: Windows claims respect separators, drive roots and UNC shares", () => {
	windowsPaths(() => {
		const root = "C:\\Work\\repo";
		assert.ok(matchesClaim("C:\\Work\\repo\\src\\auth\\login.ts", "src\\**\\*.ts", root));
		assert.ok(matchesClaim("C:\\Work\\repo\\src\\auth\\login.ts", "src/**/*.ts", root));
		assert.ok(matchesClaim("c:\\Work\\repo\\src\\login.ts", "C:/Work/repo/src/*.ts", root));
		assert.ok(matchesClaim("\\\\?\\C:\\Work\\repo\\src\\login.ts", "src/*.ts", root));
		assert.ok(!matchesClaim("C:\\Work\\repo\\src\\deep\\login.ts", "src/*.ts", root), "a star cannot cross a Windows separator");
		assert.ok(matchesClaim("C:\\Work\\repo\\pkg\\core\\internal\\a.ts", "pkg/*/internal", root));
		assert.ok(matchesClaim("C:\\Work\\repo\\src", "src/**", root), "a directory claim includes the directory itself");
		assert.ok(!claimsOverlap("src/**", "docs/**/*.md", root));
		assert.equal(laneRelativePattern("C:\\Work\\repo\\src\\**", root), "src/**");
		assert.equal(laneRelativePattern("D:\\other\\src\\**", root), null);
		assert.ok(matchesClaim("C:\\file.ts", "/**", "C:\\"));
		assert.ok(matchesClaim("\\\\server\\share\\repo\\src\\a.ts", "src/*.ts", "\\\\server\\share\\repo"));
		assert.ok(!matchesClaim("\\\\server\\other\\repo\\src\\a.ts", "src/*.ts", "\\\\server\\share\\repo"));
	});
});

test("portability: glob characters in checkout directory names are literal", () => {
	const root = join("/work", "repo [copy]");
	assert.ok(matchesClaim(join(root, "src", "a.ts"), "src/*.ts", root));
	assert.ok(matchesClaim(join(root, "src", "deep", "a.ts"), "src/**", root));
	assert.ok(!matchesClaim(join("/work", "repo c", "src", "a.ts"), "src/*.ts", root));
	assert.ok(!claimsOverlap("src/**", "docs/**", root));
});

test("portability: dot-prefixed filenames remain inside their checkout", () => {
	assert.ok(isWithin(join("/repo", "..config", "file.ts"), "/repo"));
	assert.equal(laneRelativePattern(join("/repo", "..config", "**"), "/repo"), "..config/**");
	assert.ok(!isWithin("/repo-other/file.ts", "/repo"));
	windowsPaths(() => {
		assert.ok(isWithin("C:\\repo\\..config\\a.ts", "C:\\repo"));
		assert.ok(!isWithin("D:\\repo\\a.ts", "C:\\repo"));
	});
});

test("portability: tool paths accept file URLs and Windows shell/home spellings", (t) => {
	const dir = scratch(t);
	const file = join(dir, "space # café.txt");
	writeFileSync(file, "data");
	assert.equal(canonicalPath(pathToFileURL(file).href, dir), canonicalPath(file, dir));
	windowsPaths(() => {
		for (const input of ["/c/Work/repo/a.ts", "/mnt/c/Work/repo/a.ts", "/cygdrive/c/Work/repo/a.ts"]) {
			assert.equal(canonicalPath(input, "D:\\elsewhere"), "C:\\Work\\repo\\a.ts");
		}
		assert.equal(canonicalPath("~\\telecom-new.txt", "C:\\repo"), path.win32.resolve("C:\\repo", homedir(), "telecom-new.txt"));
	});
});

test("portability: symlinked checkouts and new files have one identity", (t) => {
	const base = scratch(t);
	const dir = join(base, "repo with spaces");
	mkdirSync(join(dir, ".git"), { recursive: true });
	const alias = join(base, "alias");
	symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(findProjectRoot(alias), findProjectRoot(dir));
	assert.equal(findRepo(alias), findRepo(dir));
	assert.equal(canonicalPath("new/deep/file.ts", alias), canonicalPath("new/deep/file.ts", dir));
	writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\r\n");
});

test("portability: file identity preserves distinct case and Unicode names when the volume does", (t) => {
	const dir = scratch(t);
	for (const [first, alternate] of [["MixedCase.txt", "mixedcase.txt"], ["café.txt", "cafe\u0301.txt"]]) {
		writeFileSync(join(dir, first), "one");
		if (existsSync(join(dir, alternate))) {
			assert.equal(canonicalPath(first, dir), canonicalPath(alternate, dir), "aliases on this volume are one path");
		} else {
			writeFileSync(join(dir, alternate), "two");
			assert.notEqual(canonicalPath(first, dir), canonicalPath(alternate, dir), "distinct files must stay distinct");
		}
	}
});

test("portability: transport ids cannot alias Windows device files or trailing dots", () => {
	for (const id of ["CON", "con.txt", "PRN", "aux", "nul", "COM1", "lpt9.log", "session.", ".", ".."]) {
		assert.equal(isId(id), false, id);
	}
	for (const id of ["console", "com10", "session-1", "a.b", "01a15af8-3f67-73cf-8df2-601a6e1a4a12"]) assert.ok(isId(id), id);
});

test("portability: uid-less accounts keep separate roots in a shared temp directory", (t) => {
	const base = scratch(t);
	const uid = Object.getOwnPropertyDescriptor(process, "getuid");
	let username = "first user";
	const temp = t.mock.method(os, "tmpdir", () => base);
	const user = t.mock.method(os, "userInfo", () => ({ username, homedir: "/users/shared", uid: -1, gid: -1, shell: null }));
	try {
		Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
		syncBuiltinESMExports();
		const first = transportRoot({});
		username = "second user";
		const second = transportRoot({});
		assert.ok(first.ok && second.ok);
		assert.notEqual(first.path, second.path);
		assert.deepEqual(transportRoot({}), second, "the default is stable across sessions");
	} finally {
		if (uid) Object.defineProperty(process, "getuid", uid);
		else delete (process as Partial<NodeJS.Process>).getuid;
		temp.mock.restore();
		user.mock.restore();
		syncBuiltinESMExports();
	}
});

function switchboard(t: TestContext) {
	const root = transportRoot({ PI_TELECOM_DIR: join(scratch(t), "switchboard") });
	assert.ok(root.ok);
	return openTransport(root.path);
}

function envelope(id: string): Envelope {
	return { v: 1, id, from: "alpha", fromCallsign: "alpha", to: "bravo", ts: Date.now(), kind: "message", text: id };
}

function fault(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`simulated ${code}`), { code });
}

test("portability: a temporarily unreadable message is kept for the next drain", (t) => {
	const wire = switchboard(t);
	assert.ok(wire.deliver(envelope("locked")).ok);
	assert.ok(wire.deliver(envelope("next")).ok);
	const inbox = join(wire.root, "inbox", "bravo");
	const locked = join(inbox, readdirSync(inbox).find((name) => name.endsWith("-locked.json"))!);
	const originalRead = fs.readFileSync;
	const read = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFileSync>) => {
		if (String(args[0]) === locked) throw fault("EACCES");
		return originalRead(...args);
	});
	// Capture the originals above before syncing, so the mocked function cannot recurse.
	const got: string[] = [];
	try {
		syncBuiltinESMExports();
		wire.drain("bravo", (message) => got.push(message.id));
	} finally {
		read.mock.restore();
		syncBuiltinESMExports();
	}
	assert.ok(existsSync(locked), "an OS sharing violation is not a malformed message");
	assert.deepEqual(got, ["next"]);
	wire.drain("bravo", (message) => got.push(message.id));
	assert.deepEqual(got, ["next", "locked"]);
});

test("portability: an inbox cleanup failure does not stop the remaining messages", (t) => {
	const wire = switchboard(t);
	assert.ok(wire.deliver(envelope("locked")).ok);
	assert.ok(wire.deliver(envelope("next")).ok);
	const remove = fs.rmSync;
	const mocked = t.mock.method(fs, "rmSync", (...args: Parameters<typeof rmSync>) => {
		if (String(args[0]).endsWith("-locked.json")) throw fault("EPERM");
		return remove(...args);
	});
	try {
		syncBuiltinESMExports();
		const got: string[] = [];
		const result = wire.drain("bravo", (message) => got.push(message.id));
		assert.deepEqual(got, ["locked", "next"]);
		assert.ok(result.failed.some((error) => error.includes("EPERM")));
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
});

test("portability: an atomic write failure remains a result even when its temp file is locked", (t) => {
	const wire = switchboard(t);
	const remove = fs.rmSync;
	const rename = t.mock.method(fs, "renameSync", () => { throw fault("EBUSY"); });
	const cleanup = t.mock.method(fs, "rmSync", (...args: Parameters<typeof rmSync>) => {
		if (String(args[0]).includes(".tmp-")) throw fault("EPERM");
		return remove(...args);
	});
	try {
		syncBuiltinESMExports();
		const result = wire.deliver(envelope("failed"));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /EBUSY/);
	} finally {
		rename.mock.restore();
		cleanup.mock.restore();
		syncBuiltinESMExports();
	}
});

test("portability: Windows retries a rename over a presence file a reader holds open", (t) => {
	const wire = switchboard(t);
	const record: Presence = { v: 1, id: "live", callsign: "alpha", pid: process.pid, ticks: null, cwd: wire.root, projectRoot: wire.root, role: "main", state: "idle", claims: [], recent: [], startedAt: 1, heartbeatAt: Date.now() };
	const original = fs.renameSync;
	let refusals = 2;
	const rename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
		if (refusals-- > 0) throw fault("EPERM");
		return original(...args);
	});
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	try {
		Object.defineProperty(process, "platform", { value: "win32" });
		syncBuiltinESMExports();
		assert.ok(wire.writePresence(record).ok, "a passing sharing violation is retried");
		assert.equal(rename.mock.callCount(), 3);
		Object.defineProperty(process, "platform", { value: "linux" });
		refusals = 1;
		assert.equal(wire.writePresence(record).ok, false, "elsewhere EPERM is a real refusal, not a lock");
	} finally {
		Object.defineProperty(process, "platform", platform);
		rename.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal(wire.readPeers().length, 1);
});

test("portability: a failed write's reason leaves out the temp name, so it is reported once", (t) => {
	const wire = switchboard(t);
	const rename = t.mock.method(fs, "renameSync", (from: string, to: string) => {
		throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
	});
	try {
		syncBuiltinESMExports();
		const first = wire.deliver(envelope("one"));
		const second = wire.deliver(envelope("two"));
		assert.ok(!first.ok && !second.ok);
		if (first.ok || second.ok) return;
		assert.doesNotMatch(first.reason, /\.tmp-/);
		assert.match(first.reason, /EPERM: operation not permitted, rename$/);
	} finally {
		rename.mock.restore();
		syncBuiltinESMExports();
	}
});

test("portability: a locked presence is not swept as corrupt", (t) => {
	const wire = switchboard(t);
	const record: Presence = { v: 1, id: "live", callsign: "alpha", pid: process.pid, ticks: null, cwd: wire.root, projectRoot: wire.root, role: "main", state: "idle", claims: [], recent: [], startedAt: 1, heartbeatAt: Date.now() };
	assert.ok(wire.writePresence(record).ok);
	assert.equal(wire.readPeers().length, 1);
	const file = join(wire.root, "presence", "live.json");
	fs.utimesSync(file, new Date(0), new Date(0));
	const read = fs.readFileSync;
	const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFileSync>) => {
		if (String(args[0]) === file) throw fault("EBUSY");
		return read(...args);
	});
	try {
		syncBuiltinESMExports();
		assert.equal(wire.readPeers().length, 1, "keep the last validated live presence during a lock");
		assert.deepEqual(wire.sweep(), []);
		assert.ok(existsSync(file));
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
});
