/**
 * rpc-driver — start a real pi process in RPC mode with only this extension loaded, and read its
 * JSONL stream. Shared by the e2e scripts.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const entry = resolve(here, "..", "src", "index.ts");

let cli;
function piCli() {
	// Invoke the installed JS entry with Node. Windows cannot spawn npm's pi.cmd shim without
	// cmd.exe, whose quoting breaks extension/session paths containing spaces or shell syntax.
	if (cli) return cli;
	const root = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	cli = resolve(root, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
	return cli;
}

export function startPi(name, { cwd, env, args = [], session = ["--no-session"], noTelecom = false }) {
	const telecom = noTelecom ? [] : ["-e", entry];
	const child = spawn(
		process.execPath,
		[piCli(), "--mode", "rpc", ...session, "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", ...telecom, "--name", name, ...args],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const records = [];
	const waiters = new Set();
	let buffer = "";
	let stderr = "";
	let failure = null;
	let closed = false;
	let stopping = null;
	const stderrTail = () => (stderr.trim() ? `\n${stderr.trim().slice(-2000)}` : "");
	const fail = (error) => {
		failure ??= error;
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(failure);
		}
		waiters.clear();
	};
	// Decode across chunks: a pipe read can end in the middle of a callsign/path's UTF-8 bytes.
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			records.push(record);
			for (const w of waiters) {
				if (w.match(record)) {
					waiters.delete(w);
					clearTimeout(w.timer);
					w.resolve(record);
				}
			}
		}
	});
	child.stderr.on("data", (c) => {
		stderr += c;
	});
	child.on("error", (error) => fail(new Error(`${name}: could not start pi: ${error.message}`)));
	child.stdin.on("error", (error) => fail(new Error(`${name}: RPC input failed: ${error.message}`)));
	const finished = new Promise((resolvePromise) => {
		child.once("close", (code, signal) => {
			closed = true;
			fail(new Error(`${name}: pi exited (${signal ?? code})${stderrTail()}`));
			resolvePromise();
		});
	});
	let seq = 0;
	return {
		name,
		child,
		records,
		stderr: () => stderr,
		send(command) {
			if (failure) throw failure;
			const id = `${name}-${++seq}`;
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return id;
		},
		/** The first record matching `match`, from index `since` on (earlier records are history). */
		waitFor(match, timeoutMs = 15_000, since = 0) {
			const found = records.slice(since).find(match);
			if (found) return Promise.resolve(found);
			if (failure) return Promise.reject(failure);
			return new Promise((resolvePromise, reject) => {
				const w = { match, resolve: resolvePromise, reject, timer: null };
				waiters.add(w);
				w.timer = setTimeout(() => {
					waiters.delete(w);
					reject(new Error(`${name}: timed out waiting${stderrTail()}`));
				}, timeoutMs).unref();
			});
		},
		async command(text) {
			const id = this.send({ type: "prompt", message: text });
			return this.waitFor((r) => r.type === "response" && r.id === id);
		},
		notifies() {
			return records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message);
		},
		stop() {
			if (stopping) return stopping;
			stopping = (async () => {
				if (closed) return;
				child.stdin.end();
				const terminate = setTimeout(() => child.kill("SIGTERM"), 2_000);
				const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
				try {
					// Windows holds session files open until the process and its stdio have closed.
					await finished;
				} finally {
					clearTimeout(terminate);
					clearTimeout(force);
				}
			})();
			return stopping;
		},
	};
}

export const isNotify = (re) => (r) => r.type === "extension_ui_request" && r.method === "notify" && re.test(r.message ?? "");
export const isStatus = (re) => (r) =>
	r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "telecom" && re.test(r.statusText ?? "");
