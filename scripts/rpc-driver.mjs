/**
 * rpc-driver — start a real pi process in RPC mode with only this extension loaded, and read its
 * JSONL stream. Shared by the e2e scripts.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const entry = resolve(here, "..", "src", "index.ts");

export function startPi(name, { cwd, env, args = [] }) {
	const child = spawn(
		"pi",
		["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "-e", entry, "--name", name, ...args],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const records = [];
	const waiters = [];
	let buffer = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
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
			for (const w of [...waiters]) {
				if (w.match(record)) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(record);
				}
			}
		}
	});
	child.stderr.on("data", (c) => {
		stderr += c.toString("utf8");
	});
	let seq = 0;
	return {
		name,
		child,
		records,
		stderr: () => stderr,
		send(command) {
			const id = `${name}-${++seq}`;
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return id;
		},
		waitFor(match, timeoutMs = 15_000) {
			const found = records.find(match);
			if (found) return Promise.resolve(found);
			return new Promise((resolvePromise, reject) => {
				const w = { match, resolve: resolvePromise };
				waiters.push(w);
				setTimeout(() => {
					const i = waiters.indexOf(w);
					if (i !== -1) {
						waiters.splice(i, 1);
						reject(new Error(`${name}: timed out waiting`));
					}
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
	};
}

export const isNotify = (re) => (r) => r.type === "extension_ui_request" && r.method === "notify" && re.test(r.message ?? "");
export const isStatus = (re) => (r) =>
	r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "telecom" && re.test(r.statusText ?? "");
