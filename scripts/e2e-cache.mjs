#!/usr/bin/env node
/**
 * e2e-cache — does telecom break prompt caching? Measured, with a real model.
 *
 * Agent B works through a few prompts while agent A disturbs it in every way telecom can: a
 * change notice appended while B is idle, a broadcast, a team brief at the next prompt, and a
 * message steered into the MIDDLE of a B run. A probe extension in B records every provider
 * request; the check is that each request only APPENDS to the previous one (same system prompt,
 * same tools, unchanged message prefix), and the provider's own cacheRead/cacheWrite numbers are
 * compared with a baseline run of the same prompts without telecom.
 *
 *   TELECOM_LIVE_MODEL=anthropic/claude-sonnet-4-5 node scripts/e2e-cache.mjs
 *   (TELECOM_LIVE_EXTENSIONS=/path/to/provider.ts when the provider is an extension)
 *
 * Costs model calls. Exit 0 = pass, 1 = a check failed, 2 = no model configured.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isStatus, startPi } from "./rpc-driver.mjs";

const model = process.env.TELECOM_LIVE_MODEL;
if (!model) {
	console.error("set TELECOM_LIVE_MODEL=<provider/model> (this script spends model calls)");
	process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const probe = resolve(here, "cache-probe.ts");
const extra = (process.env.TELECOM_LIVE_EXTENSIONS ?? "").split(",").map((p) => p.trim()).filter(Boolean);

const scratch = mkdtempSync(join(tmpdir(), "pi-telecom-cache-"));
const keepAlive = setInterval(() => {}, 1_000);
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : `\n    ${String(detail).slice(0, 1500)}`}`);
	if (!ok) failures++;
}

function project(name) {
	const dir = join(scratch, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(dir, "shared.txt"), "line one: alpha\nline two: beta\n");
	writeFileSync(join(dir, "notes.txt"), "remember the milk\n");
	return dir;
}

/** Is the agent mid-run? (A peer's ask can wake it at any time.) */
function busy(agent) {
	const last = agent.records.filter((r) => r.type === "agent_start" || r.type === "agent_settled").at(-1);
	return last?.type === "agent_start";
}

/**
 * Prompt an agent and wait for THAT run to settle. A peer may have woken the agent (an ask), and
 * a prompt sent mid-run is queued rather than started — so wait for idle first, then for the run
 * this prompt starts, then for its own end. Returns the records of exactly that run.
 */
async function run(agent, prompt, timeoutMs = 180_000) {
	if (busy(agent)) {
		const at = agent.records.length;
		await agent.waitFor((r) => r.type === "agent_settled" && agent.records.indexOf(r) >= at, timeoutMs);
	}
	const from = agent.records.length;
	const id = agent.send({ type: "prompt", message: prompt });
	await agent.waitFor((r) => r.type === "response" && r.id === id);
	const start = await agent.waitFor((r) => r.type === "agent_start" && agent.records.indexOf(r) >= from, timeoutMs);
	const startAt = agent.records.indexOf(start);
	await agent.waitFor((r) => r.type === "agent_settled" && agent.records.indexOf(r) > startAt, timeoutMs);
	return agent.records.slice(from);
}

function usageOf(agent) {
	return agent.records
		.filter((r) => r.type === "message_end" && r.message?.role === "assistant" && r.message.usage)
		.map((r) => r.message.usage);
}

function rows(path) {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

const B_PROMPTS = [
	"Use the read tool to read shared.txt, then reply with just OK.",
	"Reply with just: two",
	"Use the read tool on shared.txt, then on notes.txt, one call at a time, then reply with just DONE.",
	"Reply with just: three",
];

async function scenario({ withTelecom }) {
	const dir = project(withTelecom ? "with" : "without");
	const log = join(scratch, `${withTelecom ? "with" : "without"}.jsonl`);
	const env = { ...process.env, PI_TELECOM_DIR: join(scratch, "sb"), PI_TELECOM_TICK_MS: "100", CACHE_PROBE_LOG: log };
	const common = ["--model", model, "--thinking", "off", "--tools", "read,edit,write,telecom", ...extra.flatMap((p) => ["-e", p])];
	// Without telecom, B loads only the probe (the -e entry the driver adds is replaced).
	const bArgs = ["-e", probe, ...common];
	const b = withTelecom
		? startPi("agent-b", { cwd: dir, env, args: bArgs })
		: startPi("agent-b", { cwd: dir, env, args: bArgs, noTelecom: true });
	const a = withTelecom ? startPi("agent-a", { cwd: dir, env, args: common }) : null;
	try {
		if (a) {
			await a.waitFor(isStatus(/1 peer/), 30_000);
			await b.waitFor(isStatus(/1 peer/), 30_000);
			await new Promise((r) => setTimeout(r, 1_200));
		} else {
			await new Promise((r) => setTimeout(r, 2_000));
		}
		const csB = a ? b.records.filter(isStatus(/📡/)).at(-1).statusText.match(/📡 (\w+)/)[1] : null;

		await run(b, B_PROMPTS[0]);
		if (a) {
			await run(a, 'Use the edit tool to change "alpha" to "ALPHA" in shared.txt. Do nothing else.');
			await b.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-change", 15_000).catch(() => null);
			await a.command("/telecom broadcast heads-up: the config format is changing");
			await b.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-broadcast", 15_000).catch(() => null);
		}
		await run(b, B_PROMPTS[1]);
		// Steer a message into the middle of B's next run.
		const steered = run(b, B_PROMPTS[2]);
		if (a) {
			await b.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "read" && b.records.indexOf(r) > 0, 60_000).catch(() => null);
			await a.command(`/telecom msg ${csB} small note: no reply needed`);
		}
		await steered;
		await run(b, B_PROMPTS[3]);
		const kinds = b.records.filter((r) => r.type === "message_end" && r.message?.customType?.startsWith("telecom-")).map((r) => r.message.customType);
		return { rows: rows(log), usage: usageOf(b), kinds };
	} finally {
		for (const p of [a, b]) {
			if (!p) continue;
			try {
				p.child.stdin.end();
				p.child.kill("SIGTERM");
			} catch {}
		}
	}
}

function summarize(label, { rows: rs, usage }) {
	const total = usage.reduce(
		(acc, u) => ({
			input: acc.input + (u.input ?? 0),
			cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
			cacheWrite: acc.cacheWrite + (u.cacheWrite ?? 0),
		}),
		{ input: 0, cacheRead: 0, cacheWrite: 0 },
	);
	const prompt = total.input + total.cacheRead + total.cacheWrite;
	const hit = prompt ? total.cacheRead / prompt : 0;
	console.log(`\n${label}: ${rs.length} requests`);
	console.log("  req  msgs  sys  tools  prefix   input  cacheRead  cacheWrite");
	rs.forEach((r, i) => {
		const u = usage[i] ?? {};
		const flag = (v) => (v === null ? " - " : v ? " = " : " ≠ ");
		console.log(
			`  ${String(r.seq).padStart(3)}  ${String(r.messages).padStart(4)}  ${flag(r.systemSame)}  ${flag(r.toolsSame)}   ${r.prefixIntact === null ? "  -   " : r.prefixIntact ? "append" : "BROKEN"}  ${String(u.input ?? "?").padStart(6)}  ${String(u.cacheRead ?? "?").padStart(9)}  ${String(u.cacheWrite ?? "?").padStart(10)}`,
		);
	});
	console.log(`  cache hit rate over all prompt tokens: ${(hit * 100).toFixed(1)}%`);
	return { hit, total };
}

try {
	const withT = await scenario({ withTelecom: true });
	const without = await scenario({ withTelecom: false });
	const sw = summarize("WITH telecom (B)", withT);
	const so = summarize("WITHOUT telecom (B, same prompts)", without);

	console.log(`\ntelecom messages B received: ${withT.kinds.join(", ") || "none"}`);
	check("telecom actually disturbed B (notice, broadcast, brief, steered message)",
		["telecom-change", "telecom-broadcast", "telecom-brief", "telecom-message"].every((k) => withT.kinds.includes(k)), withT.kinds.join(", "));
	const broken = withT.rows.filter((r) => r.prefixIntact === false || r.systemSame === false || r.toolsSame === false);
	check("every request with telecom is a pure append (system, tools and message prefix unchanged)", broken.length === 0,
		JSON.stringify(broken, null, 1));
	const readsOk = withT.usage.slice(1).every((u, i) => {
		const prev = withT.usage[i];
		const prevPrompt = (prev.cacheRead ?? 0) + (prev.cacheWrite ?? 0);
		return (u.cacheRead ?? 0) >= prevPrompt * 0.9;
	});
	check("the provider served each request's previous prompt from cache", readsOk,
		JSON.stringify(withT.usage.map((u) => [u.input, u.cacheRead, u.cacheWrite])));
	check("cache hit rate with telecom is in line with the baseline", sw.hit >= so.hit - 0.05,
		`with ${(sw.hit * 100).toFixed(1)}% vs without ${(so.hit * 100).toFixed(1)}%`);
} catch (error) {
	console.error(error);
	failures++;
} finally {
	clearInterval(keepAlive);
	rmSync(scratch, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall cache checks passed" : `\n${failures} cache check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
