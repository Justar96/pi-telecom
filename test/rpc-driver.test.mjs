import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { startPi } from "../scripts/rpc-driver.mjs";

function fixture(t) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		kill: () => assert.fail("a clean RPC shutdown must not need a signal"),
	});
	child.stdin.on("finish", () => child.emit("close", 0, null));
	let launched;
	const mocked = t.mock.method(childProcess, "spawn", (...args) => {
		launched = args;
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => {
		mocked.mock.restore();
		syncBuiltinESMExports();
	});
	const pi = startPi("fixture", { cwd: "/workspace with spaces & café", env: {} });
	t.after(() => pi.stop());
	return { pi, child, launched };
}

test("RPC driver: launches Node directly and preserves UTF-8 split across pipe reads", async (t) => {
	const { pi, child, launched } = fixture(t);
	assert.equal(launched[0], process.execPath);
	assert.match(launched[1][0], /[\\/]cli\.js$/);
	assert.equal(launched[2].shell, undefined);
	assert.equal(launched[2].cwd, "/workspace with spaces & café");
	const expected = { type: "extension_ui_request", method: "notify", message: "📡 café — résumé" };
	const bytes = Buffer.from(`${JSON.stringify(expected)}\r\n`);
	const pending = pi.waitFor((record) => record.type === expected.type);
	for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
	assert.deepEqual(await pending, expected);
	await pi.stop();
	assert.equal(await pi.waitFor((record) => record.type === expected.type), pi.records[0], "completed records remain available after exit");
});

test("RPC driver: early exit rejects current and future waits with stderr", async (t) => {
	const { pi, child } = fixture(t);
	const pending = assert.rejects(pi.waitFor(() => false, 60_000), /pi exited \(3\).*missing fixture/s);
	child.stderr.write("missing fixture");
	child.emit("close", 3, null);
	await pending;
	await assert.rejects(pi.waitFor(() => false), /pi exited \(3\)/);
	assert.throws(() => pi.send({ type: "get_state" }), /pi exited/);
});

test("RPC driver: spawn failures are reported without an unhandled error", async (t) => {
	const { pi, child } = fixture(t);
	const pending = assert.rejects(pi.waitFor(() => false), /could not start pi: ENOENT/);
	child.emit("error", new Error("ENOENT"));
	child.emit("close", -1, null);
	await pending;
});

test("RPC driver: stop is idempotent and waits for the child's close", async (t) => {
	const { pi, child } = fixture(t);
	let closed = false;
	child.once("close", () => { closed = true; });
	const stopping = pi.stop();
	assert.equal(stopping, pi.stop());
	await stopping;
	assert.equal(closed, true);
});
