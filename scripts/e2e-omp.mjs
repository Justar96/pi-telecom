/**
 * e2e-omp — telecom in oh-my-pi (omp): two real `omp --mode rpc` sessions and one pi session in
 * one repository, with `omp-fixture.ts` as the model (no network). Checks what differs between the
 * hosts: the extension loads through omp's legacy pi shim, the tool is listed, a message wakes an
 * idle omp session and it goes idle again after the run (omp has no `agent_settled`: telecom
 * settles on `agent_end`, `turns.ts`), and pi and omp sessions see each other.
 *
 * omp is found as `TELECOM_OMP` (its CLI entry) or `omp` on PATH; it runs on bun. Exit codes as in
 * every script here: 0 pass, 1 a check failed, 2 omp is missing (never a pass).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNotify, isStatus, startPi } from "./rpc-driver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "omp-fixture.ts");
const MODEL = ["--model", "telecom-fixture/fixture"];

function onPath(name) {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		for (const ext of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
			const file = join(dir, `${name}${ext}`);
			if (dir && existsSync(file)) return file;
		}
	}
	return null;
}

const omp = process.env.TELECOM_OMP ?? onPath("omp");
const bun = onPath("bun") ?? (process.env.HOME && existsSync(join(process.env.HOME, ".bun", "bin", "bun")) ? join(process.env.HOME, ".bun", "bin", "bun") : null);
if (!omp || !bun) {
	console.error(`e2e-omp: needs omp and bun (omp: ${omp ?? "not found; set TELECOM_OMP"}, bun: ${bun ?? "not found"}).`);
	process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "telecom-omp-"));
const project = join(scratch, "project");
mkdirSync(project);
execFileSync("git", ["init", "-q"], { cwd: project });
writeFileSync(join(project, "README.md"), "omp smoke\n");
const env = (name) => ({
	...process.env,
	PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ""}`,
	PI_TELECOM_DIR: join(scratch, "switchboard"),
	PI_TELECOM_CALLSIGN: name,
	PI_CODING_AGENT_DIR: join(scratch, `agent-${name}`),
	PI_TELECOM_TICK_MS: "100",
});
const ompHost = { command: [bun, omp], flags: ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title", "--no-lsp"] };
const start = (name, host) => startPi(name, { cwd: project, env: env(name), host, args: ["-e", fixture, ...MODEL] });

function presence(name) {
	const dir = join(scratch, "switchboard", "presence");
	for (const file of existsSync(dir) ? readdirSync(dir) : []) {
		if (!file.endsWith(".json")) continue;
		try {
			const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
			if (record.callsign === name) return record;
		} catch {}
	}
	return null;
}

async function until(what, check, timeoutMs = 20_000) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

const sessions = [];
let failed = false;
async function check(name, fn) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed = true;
		console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : error}`);
	}
}

try {
	console.log(`e2e-omp: ${omp}`);
	const alpha = start("alpha", ompHost);
	const bravo = start("bravo", ompHost);
	const charlie = start("charlie");
	sessions.push(alpha, bravo, charlie);

	await check("the extension loads in omp: the footer shows the callsign", async () => {
		await alpha.waitFor(isStatus(/📡 alpha/), 60_000);
		await bravo.waitFor(isStatus(/📡 bravo/), 60_000);
		await charlie.waitFor(isStatus(/📡 charlie/), 60_000);
	});

	await check("omp and pi sessions see each other on the board", async () => {
		await until("alpha's footer counts 2 peers", () => alpha.records.some(isStatus(/2 peers/)));
		const since = alpha.records.length;
		await alpha.command("/telecom board");
		const board = await alpha.waitFor(isNotify(/bravo/), 10_000, since);
		if (!/charlie/.test(board.message)) throw new Error(`the pi session is missing:\n${board.message}`);
	});

	await check("the tool runs in omp: a send from the model reaches the pi session", async () => {
		alpha.send({ type: "prompt", message: 'tool {"action":"send","to":"charlie","message":"omp smoke: hello from alpha"}' });
		await charlie.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-message" && /hello from alpha/.test(JSON.stringify(r.message.content)), 20_000);
	});

	await check("an omp session goes idle again after a run (agent_end settles it)", async () => {
		await until("alpha idle", () => presence("alpha")?.state === "idle");
	});

	await check("a message wakes an idle omp session, which settles again", async () => {
		const since = bravo.records.length;
		const idleSince = presence("bravo")?.stateSince ?? 0;
		charlie.send({ type: "prompt", message: 'tool {"action":"send","to":"bravo","message":"omp smoke: wake up"}' });
		await bravo.waitFor((r) => r.type === "agent_start", 20_000, since);
		await bravo.waitFor((r) => r.type === "agent_end", 20_000, since);
		// Idle again, and since after the wake-up: it went busy for the run and settled after it.
		await until("bravo idle again after the run", () => {
			const record = presence("bravo");
			return record?.state === "idle" && (record.stateSince ?? 0) > idleSince;
		});
	});
} catch (error) {
	failed = true;
	console.log(`  ✗ ${error instanceof Error ? error.message : error}`);
} finally {
	await Promise.all(sessions.map((s) => s.stop()));
	rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? "e2e-omp: FAILED" : "e2e-omp: passed");
process.exit(failed ? 1 : 0);
