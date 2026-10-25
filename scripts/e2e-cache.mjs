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
 * Providers cache best-effort: one miss in seven requests moves a hit rate by 15 points. So each
 * side runs TELECOM_CACHE_RUNS times (default 3), alternating which goes first, and the summary
 * compares medians. It also separates a miss (the provider did not serve the previous prompt) from
 * what telecom controls: the tokens a request that DID hit was charged as new (input + cacheWrite),
 * which is the text appended since the last request.
 *
 *   TELECOM_LIVE_MODEL=<provider>/claude-opus-5-5 node scripts/e2e-cache.mjs
 *   (or gpt-6.1-sol — the models are listed in scripts/lab-models.mjs)
 *   (TELECOM_LIVE_EXTENSIONS=/path/to/provider.ts when the provider is an extension)
 *
 * Costs model calls. Exit 0 = pass, 1 = a check failed, 2 = no model configured.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const runs = Math.max(1, Math.floor(Number(process.env.TELECOM_CACHE_RUNS ?? 3)) || 3);

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-telecom-cache-")));
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

async function scenario({ withTelecom, run: n }) {
	const name = `${withTelecom ? "with" : "without"}-${n}`;
	const dir = project(name);
	const log = join(scratch, `${name}.jsonl`);
	// A switchboard per run: nothing a previous run left behind reaches this one.
	const env = { ...process.env, PI_TELECOM_DIR: join(scratch, `sb-${n}`), PI_TELECOM_TICK_MS: "100", CACHE_PROBE_LOG: log };
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
		await Promise.all([a, b].filter(Boolean).map((p) => p.stop()));
	}
}

/** Share of prompt tokens served from cache. */
function hitRate(usage) {
	const total = usage.reduce(
		(acc, u) => ({
			input: acc.input + (u.input ?? 0),
			cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
			cacheWrite: acc.cacheWrite + (u.cacheWrite ?? 0),
		}),
		{ input: 0, cacheRead: 0, cacheWrite: 0 },
	);
	const prompt = total.input + total.cacheRead + total.cacheWrite;
	return { hit: prompt ? total.cacheRead / prompt : 0, total };
}

/** Does request `i` miss the cache: is less of the previous request's prompt served from it? */
function missed(usage, i) {
	const prev = usage[i - 1];
	const u = usage[i];
	return (u.cacheRead ?? 0) < ((prev.input ?? 0) + (prev.cacheRead ?? 0) + (prev.cacheWrite ?? 0)) * 0.9 - 128;
}

/**
 * From the second request on: how many missed, and the tokens each request that hit was charged as
 * new (input + cacheWrite), on average. A hit's new tokens are the text appended since the request
 * before (telecom's messages among it); a miss's are the whole prompt, the provider's doing.
 */
function steadyStats(usage) {
	let misses = 0;
	let fresh = 0;
	let hits = 0;
	for (let i = 1; i < usage.length; i++) {
		if (missed(usage, i)) {
			misses++;
			continue;
		}
		hits++;
		fresh += (usage[i].input ?? 0) + (usage[i].cacheWrite ?? 0);
	}
	return { misses, requests: Math.max(0, usage.length - 1), freshPerHit: hits ? fresh / hits : 0 };
}

function summarize(label, { rows: rs, usage }) {
	const { hit, total } = hitRate(usage);
	// The first request is warm or cold depending on what ran before it (an identical system prompt
	// from an earlier run may still be cached), not on telecom. Compare from the second request on.
	const steady = hitRate(usage.slice(1)).hit;
	const stats = steadyStats(usage);
	console.log(`\n${label}: ${rs.length} requests`);
	console.log("  req  msgs  sys  tools  prefix   input  cacheRead  cacheWrite");
	rs.forEach((r, i) => {
		const u = usage[i] ?? {};
		const flag = (v) => (v === null ? " - " : v ? " = " : " ≠ ");
		const miss = i > 0 && usage[i] && usage[i - 1] && missed(usage, i) ? "  miss" : "";
		console.log(
			`  ${String(r.seq).padStart(3)}  ${String(r.messages).padStart(4)}  ${flag(r.systemSame)}  ${flag(r.toolsSame)}   ${r.prefixIntact === null ? "  -   " : r.prefixIntact ? "append" : "BROKEN"}  ${String(u.input ?? "?").padStart(6)}  ${String(u.cacheRead ?? "?").padStart(9)}  ${String(u.cacheWrite ?? "?").padStart(10)}${miss}`,
		);
	});
	console.log(`  cache hit rate: ${(steady * 100).toFixed(1)}% after the first request (${(hit * 100).toFixed(1)}% including it)`);
	console.log(`  misses: ${stats.misses} of ${stats.requests}; new tokens per request that hit: ${stats.freshPerHit.toFixed(0)}`);
	return { hit, steady, total, ...stats };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

try {
	const withRuns = [];
	const withoutRuns = [];
	for (let n = 1; n <= runs; n++) {
		// Alternate which side goes first: the first side of a run may find the other's system prompt
		// (or its own from the run before) still cached.
		const order = n % 2 === 1 ? [true, false] : [false, true];
		for (const withTelecom of order) {
			const result = await scenario({ withTelecom, run: n });
			const label = `run ${n}/${runs}, ${withTelecom ? "WITH telecom (B)" : "WITHOUT telecom (B, same prompts)"}`;
			(withTelecom ? withRuns : withoutRuns).push({ ...result, ...summarize(label, result) });
		}
	}

	const kinds = new Set(withRuns.flatMap((r) => r.kinds));
	console.log(`\ntelecom messages B received: ${[...kinds].join(", ") || "none"}`);
	const disturbed = withRuns.filter((r) => ["telecom-change", "telecom-broadcast", "telecom-brief", "telecom-message"].every((k) => r.kinds.includes(k)));
	check(`telecom actually disturbed B (notice, broadcast, brief, steered message) in every run`, disturbed.length === withRuns.length,
		withRuns.map((r) => r.kinds.join(", ")).join(" | "));
	const broken = withRuns.flatMap((r) => r.rows.filter((row) => row.prefixIntact === false || row.systemSame === false || row.toolsSame === false));
	check("every request with telecom is a pure append (system, tools and message prefix unchanged)", broken.length === 0,
		JSON.stringify(broken, null, 1));

	const sum = (rs, key) => rs.reduce((n, r) => n + r[key], 0);
	const missesWith = sum(withRuns, "misses");
	const missesWithout = sum(withoutRuns, "misses");
	const steadyWith = median(withRuns.map((r) => r.steady));
	const steadyWithout = median(withoutRuns.map((r) => r.steady));
	const freshWith = median(withRuns.map((r) => r.freshPerHit));
	const freshWithout = median(withoutRuns.map((r) => r.freshPerHit));
	console.log(`\nover ${runs} run(s), from the second request on:`);
	console.log("                      with telecom   without");
	console.log(`  median hit rate      ${`${(steadyWith * 100).toFixed(1)}%`.padStart(12)}   ${`${(steadyWithout * 100).toFixed(1)}%`.padStart(7)}`);
	console.log(`  cache misses         ${`${missesWith}/${sum(withRuns, "requests")}`.padStart(12)}   ${`${missesWithout}/${sum(withoutRuns, "requests")}`.padStart(7)}`);
	console.log(`  new tokens per hit   ${freshWith.toFixed(0).padStart(12)}   ${freshWithout.toFixed(0).padStart(7)}   (telecom's text: about ${Math.max(0, freshWith - freshWithout).toFixed(0)} per request)`);

	// Per-request reuse is only a fair test when the provider caches deterministically. Some
	// (OpenAI's automatic caching) are best-effort and miss pure-append requests even without
	// telecom; for those the baseline is the yardstick, and the request-side append check above is
	// the proof that telecom changed nothing.
	if (missesWithout === 0) {
		check("the provider served each request's previous prompt from cache", missesWith === 0,
			JSON.stringify(withRuns.map((r) => r.usage.map((u) => [u.input, u.cacheRead, u.cacheWrite]))));
	} else {
		console.log(`  (provider caching is best-effort: it missed ${missesWithout} requests without telecom and ${missesWith} with it — per-request reuse not judged)`);
	}
	check("median cache hit rate with telecom is in line with the baseline (after the first request)", steadyWith >= steadyWithout - 0.05,
		`with ${(steadyWith * 100).toFixed(1)}% vs without ${(steadyWithout * 100).toFixed(1)}%`);
} catch (error) {
	console.error(error);
	failures++;
} finally {
	clearInterval(keepAlive);
	rmSync(scratch, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall cache checks passed" : `\n${failures} cache check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
