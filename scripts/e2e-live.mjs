#!/usr/bin/env node
/**
 * e2e-live — two real pi agents, driven by a real model, cooperating in one project.
 *
 * This COSTS model calls (a handful of short turns). It proves the parts only a model run
 * reaches: real `read`/`edit`/`write` tool events flowing through the guard, a change notice
 * produced by a real edit, and a full ask → wake → reply round trip between two agents.
 *
 *   TELECOM_LIVE_MODEL=anthropic/claude-haiku-4-5 node scripts/e2e-live.mjs
 *
 * Only this extension is loaded. A model whose provider is itself an extension needs that
 * extension too: TELECOM_LIVE_EXTENSIONS=/path/to/provider/index.ts (comma-separated).
 *
 * Exit 0 = pass, 1 = a check failed, 2 = no model configured.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStatus, startPi } from "./rpc-driver.mjs";

const model = process.env.TELECOM_LIVE_MODEL;
if (!model) {
	console.error("set TELECOM_LIVE_MODEL=<provider/model> (this script spends model calls)");
	process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "pi-telecom-live-"));
const project = join(scratch, "proj");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(project, "shared.txt"), "line one: alpha\nline two: beta\n");
writeFileSync(join(project, "auth.txt"), "auth v1\n");
const env = { ...process.env, PI_TELECOM_DIR: join(scratch, "switchboard"), PI_TELECOM_TICK_MS: "100" };
const extra = (process.env.TELECOM_LIVE_EXTENSIONS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
const args = ["--model", model, "--tools", "read,edit,write,telecom", ...extra.flatMap((p) => ["-e", p])];

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✔" : "✖"} ${name}${ok || !detail ? "" : `\n    ${String(detail).slice(0, 1200)}`}`);
	if (!ok) failures++;
}

const textOf = (content) =>
	typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("\n");

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

/** What a run did, for a failure message: every tool call with its result, and the final reply. */
function describe(records) {
	const tools = records
		.filter((r) => r.type === "tool_execution_end")
		.map((r) => `${r.toolName}${r.isError ? "✗" : "✓"} ${JSON.stringify(r.args ?? {}).slice(0, 160)} → ${textOf(r.result?.content).slice(0, 240)}`);
	const reply = records
		.filter((r) => r.type === "message_end" && r.message?.role === "assistant")
		.map((r) => `${r.message.stopReason ?? ""} ${r.message.errorMessage ?? ""} ${textOf(r.message.content)}`.trim())
		.at(-1);
	return `tools: ${tools.join(" | ") || "none"}\n    final reply: ${reply ?? "none"}`;
}

const toolEnds = (records, name) => records.filter((r) => r.type === "tool_execution_end" && r.toolName === name);

const keepAlive = setInterval(() => {}, 1_000);
const a = startPi("agent-a", { cwd: project, env, args });
const b = startPi("agent-b", { cwd: project, env, args });
for (const p of [a, b]) {
	p.child.once("exit", (code) => {
		if (code) console.error(`${p.name} exited with ${code}: ${p.stderr().slice(-600)}`);
	});
}
try {
	await a.waitFor(isStatus(/1 peer/), 30_000);
	await b.waitFor(isStatus(/1 peer/), 30_000);
	// Two sessions starting in the same instant may pick the same word; the younger one moves on
	// its next tick. Let that settle, then read the latest footer of each.
	await new Promise((r) => setTimeout(r, 1_500));
	const callsignOf = (agent) =>
		agent.records.filter(isStatus(/📡/)).at(-1).statusText.match(/📡 (\w+)/)[1];
	const csA = callsignOf(a);
	const csB = callsignOf(b);
	check("the two agents settled on distinct callsigns", csA !== csB, `${csA} / ${csB}`);
	console.log(`agents: A=${csA}, B=${csB}, model=${model}\n`);

	const only = process.env.TELECOM_LIVE_ONLY;
	if (!only || only === "core") {
	// 1. B reads the file: its view is recorded.
	const r1 = await run(b, "Use the read tool to read shared.txt, then reply with just its first line.");
	check("B read shared.txt with the real read tool", toolEnds(r1, "read").length > 0);

	// 2. A edits the file. B is idle, so the notice is appended without starting a turn.
	const r2 = await run(a, 'Use the edit tool to change "alpha" to "ALPHA" in shared.txt. Do nothing else.');
	check("A edited shared.txt", toolEnds(r2, "edit").some((r) => !r.isError), JSON.stringify(toolEnds(r2, "edit")));
	const notice = await b
		.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-change", 15_000)
		.catch(() => null);
	check(
		`B got a change notice naming ${csA} and shared.txt`,
		Boolean(notice) && new RegExp(`${csA} changed a file`).test(textOf(notice.message.content)) && /shared\.txt/.test(textOf(notice.message.content)),
		notice ? textOf(notice.message.content) : "no notice",
	);
	check("the notice did not wake B", !b.records.slice(b.records.indexOf(notice)).some((r) => r.type === "agent_start"));

	// 3. B tries a whole-file overwrite from its stale view: the guard must stop the first attempt.
	const r3 = await run(
		b,
		'Without reading the file again, use the write tool to overwrite shared.txt so that it holds its two existing lines followed by a third line "line three: gamma". If a tool call is refused, follow the instructions in the refusal.',
	);
	// Two correct outcomes: B heeded the change notice and re-read before writing, or B wrote from
	// its stale view and the guard stopped it. The failure is a stale write that went through.
	const seq = r3.filter((r) => r.type === "tool_execution_end").map((r) => `${r.toolName}${r.isError ? "✗" : "✓"}`);
	console.log(`    B's tool sequence: ${seq.join(" → ")}`);
	const ends = r3.filter((r) => r.type === "tool_execution_end");
	const firstWrite = ends.findIndex((r) => r.toolName === "write");
	const readFirst = ends.slice(0, Math.max(firstWrite, 0)).some((r) => r.toolName === "read");
	const blocked = ends.find((w) => w.toolName === "write" && w.isError && /telecom:/.test(textOf(w.result?.content)));
	check(
		"B never wrote from its stale view (re-read after the notice, or was stopped by the guard)",
		readFirst || Boolean(blocked),
		JSON.stringify(ends.map((w) => `${w.toolName}: ${textOf(w.result?.content).slice(0, 200)}`)),
	);
	if (blocked) console.log(`    guard said: ${textOf(blocked.result.content).slice(0, 300)}`);
	const finalText = readFileSync(join(project, "shared.txt"), "utf8");
	check("B re-read and built on A's change: ALPHA kept, gamma added", /ALPHA/.test(finalText) && /gamma/.test(finalText), finalText);

	// 4. A asks B a question; B is woken by the ask, answers with telecom reply; A's call returns it.
	const r4 = await run(
		a,
		`Use the telecom tool: action "ask", to "${csB}", message "Quick check: what is 6 times 7? Reply with only the number." Then tell me the answer you received.`,
		180_000,
	);
	const asks = toolEnds(r4, "telecom");
	const answered = asks.find((t) => !t.isError && /answered:/.test(textOf(t.result?.content)));
	check(`A's ask returned ${csB}'s answer`, Boolean(answered) && /42/.test(textOf(answered.result.content)), JSON.stringify(asks.map((t) => textOf(t.result?.content))));
	const replied = toolEnds(b.records, "telecom").some((t) => !t.isError && /replied to/.test(textOf(t.result?.content)));
	check(`${csB} was woken by the ask and replied with the telecom tool`, replied);

	}

	if (!only || only === "claims") {
	// 5. A claims a file; B is asked to change it. B must be held back, A must be told, and the
	//    two should sort it out between themselves (B asks, A answers) — or B retries knowingly.
	const r5a = await run(a, 'Use the telecom tool to claim ["auth.txt"] with message "rewriting auth". Do nothing else.');
	const claimCall = toolEnds(r5a, "telecom").find((t) => !t.isError && /claimed auth\.txt/.test(textOf(t.result?.content)));
	check(`${csA} claimed auth.txt with the telecom tool`, Boolean(claimCall), describe(r5a));
	const r5 = await run(
		b,
		'Append a line "b was here" to auth.txt using the edit tool. If a tool call is refused, follow the advice in the refusal.',
		240_000,
	);
	const seq5 = r5.filter((r) => r.type === "tool_execution_end").map((r) => `${r.toolName}${r.isError ? "✗" : "✓"}`);
	console.log(`    B's tool sequence: ${seq5.join(" → ")}`);
	const claimBlock = toolEnds(r5, "edit").find((e) => e.isError && new RegExp(`inside ${csA}'s claim`).test(textOf(e.result?.content)));
	check(`B's edit inside ${csA}'s claim was held back`, Boolean(claimBlock), describe(r5));
	const told = await a
		.waitFor((r) => r.type === "message_end" && r.message?.customType === "telecom-claim", 10_000)
		.catch(() => null);
	check(`${csA} was told that ${csB} needs its claimed file`, Boolean(told) && new RegExp(`${csB} needs a path you claimed`).test(textOf(told.message.content)));
	const askedOwner = toolEnds(r5, "telecom").some((t) => /answered:|interrupted/.test(textOf(t.result?.content)));
	console.log(`    ${csB} ${askedOwner ? `asked ${csA} and got an answer` : "did not ask (retried or stopped)"}; auth.txt is now: ${JSON.stringify(readFileSync(join(project, "auth.txt"), "utf8"))}`);
	await new Promise((r) => setTimeout(r, 1_000));
	}
	check("both agents end the scenario settled (no runaway ping-pong)", ![a, b].some((p) => {
		const last = p.records.filter((r) => r.type === "agent_start" || r.type === "agent_settled").at(-1);
		return last?.type === "agent_start";
	}));
} catch (error) {
	console.error(error);
	failures++;
} finally {
	for (const p of [a, b]) {
		try {
			p.child.stdin.end();
			p.child.kill("SIGTERM");
		} catch {}
	}
	rmSync(scratch, { recursive: true, force: true });
	clearInterval(keepAlive);
}
console.log(failures === 0 ? "\nall live checks passed" : `\n${failures} live check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
