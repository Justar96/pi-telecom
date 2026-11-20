#!/usr/bin/env node
/**
 * e2e-matrix — the live scenario (scripts/e2e-live.mjs) on the newest model of every lab.
 *
 * Telecom works through the model: whether an agent re-reads after a notice, answers an ask with
 * `reply`, or asks a claim's owner first depends on how well each model follows telecom's tool
 * text. This runs the same scenario on every lab's newest model (scripts/lab-models.mjs) and
 * prints one table.
 *
 *   TELECOM_LIVE_PROVIDER=<provider> npm run e2e:matrix
 *   TELECOM_MATRIX_LABS=Anthropic,Google   only these labs
 *   TELECOM_MATRIX_MODELS=p/a,p/b          explicit provider/model ids instead of the list
 *   TELECOM_MATRIX_CONCURRENCY=3           runs in parallel (default 3)
 *   TELECOM_LIVE_EXTENSIONS=...            passed through (provider extensions)
 *
 * Costs model calls (one live scenario per model). Exit 0 = every model passed every check,
 * 1 = something failed, 2 = no provider configured, or a model its provider could not serve
 * (quota, credentials) and nothing failed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_MODELS, UPDATED } from "./lab-models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const provider = process.env.TELECOM_LIVE_PROVIDER?.trim();
const explicit = (process.env.TELECOM_MATRIX_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
if (!provider && explicit.length === 0) {
	console.error("set TELECOM_LIVE_PROVIDER=<provider> (or TELECOM_MATRIX_MODELS=<provider/model,...>) — this spends model calls");
	process.exit(2);
}
const onlyLabs = (process.env.TELECOM_MATRIX_LABS ?? "").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
/** An explicit `provider/id`, named as the lab list names it, else by the lab its id suggests. */
function explicitTarget(model) {
	const id = model.slice(model.indexOf("/") + 1);
	const known = LAB_MODELS.find((m) => m.id === id);
	if (known) return { lab: known.lab, name: known.name, model };
	const lab = /^claude/i.test(id) ? "Anthropic" : /^(gpt|o\d)/i.test(id) ? "OpenAI" : /^gemini/i.test(id) ? "Google" : model.split("/")[0];
	return { lab, name: id, model };
}
const targets = explicit.length
	? explicit.map(explicitTarget)
	: LAB_MODELS.filter((m) => onlyLabs.length === 0 || onlyLabs.includes(m.lab.toLowerCase())).map((m) => ({
			lab: m.lab,
			name: m.name,
			model: `${provider}/${m.id}`,
		}));
const concurrency = Math.max(1, Number(process.env.TELECOM_MATRIX_CONCURRENCY) || 3);
const logDir = join(tmpdir(), `pi-telecom-matrix-${Date.now()}`);
mkdirSync(logDir, { recursive: true });

function runOne(target) {
	return new Promise((resolvePromise) => {
		const started = Date.now();
		const child = spawn(process.execPath, [resolve(here, "e2e-live.mjs")], {
			env: { ...process.env, TELECOM_LIVE_MODEL: target.model },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			const log = join(logDir, `${target.lab}-${target.model.replace(/\W+/g, "_")}.log`);
			writeFileSync(log, out);
			const passed = (out.match(/^✔ /gm) ?? []).length;
			const failed = out.split("\n").filter((l) => l.startsWith("✖ ")).map((l) => l.slice(2));
			const minutes = ((Date.now() - started) / 60_000).toFixed(1);
			console.log(`${code === 0 ? "✔" : code === 2 ? "⚠" : "✖"} ${target.lab.padEnd(10)} ${target.name.padEnd(18)} ${passed}/${passed + failed.length} in ${minutes} min`);
			resolvePromise({ ...target, code, passed, failed, log, minutes });
		});
	});
}

console.log(
	`live scenario on ${targets.length} model(s), ${explicit.length ? "as given" : `newest per lab as of ${UPDATED}`}, ${concurrency} at a time\n`,
);
const queue = [...targets];
const results = [];
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		for (let t = queue.shift(); t; t = queue.shift()) results.push(await runOne(t));
	}),
);

const order = new Map(targets.map((t, i) => [t.model, i]));
results.sort((a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0));
console.log("\n| Lab | Model | Checks | Failed |\n|---|---|---|---|");
for (const r of results) {
	const total = r.passed + r.failed.length;
	const verdict =
		r.code === 0 ? `${r.passed}/${total} ✔` : r.code === 2 ? "provider could not serve it ⚠" : total === 0 ? "did not run ✖" : `${r.passed}/${total} ✖`;
	const why = r.code === 2 ? (/could not be served, so the scenario stopped: (.*)/.exec(readFileSync(r.log, "utf8"))?.[1] ?? "") : r.failed.join("; ");
	console.log(`| ${r.lab} | ${r.name} | ${verdict} | ${why || "—"} |`);
}
console.log(`\nfull logs: ${logDir}`);
// A model its provider could not serve proves nothing either way: never a pass (exit 2).
process.exit(results.some((r) => r.code !== 0 && r.code !== 2) ? 1 : results.some((r) => r.code === 2) ? 2 : 0);
