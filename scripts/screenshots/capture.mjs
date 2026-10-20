#!/usr/bin/env node
/**
 * capture — the README's screenshots, taken from real pi sessions.
 *
 * Two interactive pi sessions (alpha on Claude Opus 5.5, bravo on GPT-6.1 Sol: see
 * scripts/lab-models.mjs) run in tmux on a small demo repository. A short scenario is typed into
 * them: bravo reads a test, alpha claims the auth module and makes `login()` async, then bravo
 * asks alpha before fixing the test. Both screens are captured several times a second, and the
 * image shows the two screens at the same instant: alpha answering, bravo receiving the answer.
 * Nothing is retyped: the HTML is generated from the captured terminal cells.
 *
 *   TELECOM_LIVE_PROVIDER=<provider> node scripts/screenshots/capture.mjs
 *   TELECOM_LIVE_EXTENSIONS=...   provider extensions to load (comma-separated)
 *   SHOTS_OUT=docs/images         where the PNGs go
 *   SHOTS_KEEP=1                  leave the tmux sessions running afterwards
 *
 * Needs tmux and Chrome/Chromium. Costs a few short model turns. Exit 0 = images written,
 * 1 = the scenario didn't produce the moment to capture, 2 = a precondition is missing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_MODELS } from "../lab-models.mjs";
import { renderWindows } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const provider = process.env.TELECOM_LIVE_PROVIDER?.trim();
if (!provider) {
	console.error("set TELECOM_LIVE_PROVIDER=<provider> — this spends a few model turns");
	process.exit(2);
}
if (spawnSync("tmux", ["-V"]).status !== 0) {
	console.error("tmux is required");
	process.exit(2);
}
const outDir = resolve(repo, process.env.SHOTS_OUT ?? "docs/images");
const providerExtensions = (process.env.TELECOM_LIVE_EXTENSIONS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
const COLS = 84;
const ROWS = 48;
const model = (lab) => LAB_MODELS.find((m) => m.lab === lab);
const AGENTS = [
	{ callsign: "alpha", ...model("Anthropic") },
	{ callsign: "bravo", ...model("OpenAI") },
];

// ---- the demo repository
const work = mkdtempSync(join(tmpdir(), "pi-telecom-shots-"));
// A stable, readable path: it shows in pi's footer. Recreated on every run.
const project = join(tmpdir(), "pi-telecom-demo", "shop");
rmSync(dirname(project), { recursive: true, force: true });
const switchboard = join(work, "switchboard");
const sessions = join(work, "sessions");
for (const d of [join(project, "src/auth"), join(project, "test"), join(project, ".pi"), switchboard, sessions]) mkdirSync(d, { recursive: true });
chmodSync(switchboard, 0o700);
const files = {
	"src/auth/session.ts": `const sessions = new Map<string, string>();

export function login(user: string): string {
\tconst token = \`tok_\${user}_\${Date.now()}\`;
\tsessions.set(token, user);
\treturn token;
}

export function logout(token: string): void {
\tsessions.delete(token);
}
`,
	"src/upload.ts": `export function upload(token: string, file: string) {
\treturn { owner: token.split("_")[1], file };
}
`,
	"test/upload.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { login } from "../src/auth/session.ts";
import { upload } from "../src/upload.ts";

test("upload stores the file for the logged-in user", () => {
\tconst token = login("ana");
\tconst result = upload(token, "report.pdf");
\tassert.equal(result.owner, "ana");
});
`,
	// Keep pi's header (version, keys) but not the list of loaded resources.
	".pi/settings.json": `{ "quietStartup": "header" }\n`,
	".gitignore": ".pi/\n",
};
for (const [path, text] of Object.entries(files)) writeFileSync(join(project, path), text);
const git = (...args) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd: project, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "init");

// ---- tmux and the two pi sessions
const SOCKET = `pi-telecom-shots-${process.pid}`;
const tmux = (...args) => execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
const conf = join(work, "tmux.conf");
writeFileSync(
	conf,
	[
		"set -g extended-keys on",
		"set -g extended-keys-format csi-u",
		'set -g default-terminal "tmux-256color"',
		'set -ga terminal-overrides ",*:RGB"',
		"set -g status off",
	].join("\n"),
);
function launch({ callsign, id }) {
	const args = [
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
		...providerExtensions.flatMap((e) => ["-e", e]),
		"-e", repo,
		"--approve", "--session-dir", sessions,
		"--model", `${provider}/${id}`, "--thinking", "low",
		"--tui-mode", "regular", "--use-theme", "dark",
	];
	const env = [
		`PI_TELECOM_DIR=${switchboard}`, `PI_TELECOM_CALLSIGN=${callsign}`, "PI_OFFLINE=1", "COLORTERM=truecolor",
	];
	const cmd = `cd ${JSON.stringify(project)} && exec env ${env.map((e) => JSON.stringify(e)).join(" ")} pi ${args.map((a) => JSON.stringify(a)).join(" ")}`;
	const first = callsign === AGENTS[0].callsign;
	tmux(...(first ? ["-f", conf] : []), "new-session", "-d", "-s", callsign, "-x", String(COLS), "-y", String(ROWS), cmd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const states = () =>
	Object.fromEntries(
		readdirSync(join(switchboard, "presence")).flatMap((f) => {
			try {
				const p = JSON.parse(readFileSync(join(switchboard, "presence", f), "utf8"));
				return [[p.callsign, p.state]];
			} catch {
				return [];
			}
		}),
	);

// ---- frames: both screens, captured together
const frames = [];
let capturing = true;
async function captureLoop() {
	while (capturing) {
		try {
			const frame = { t: Date.now() };
			for (const { callsign } of AGENTS) {
				frame[callsign] = tmux("capture-pane", "-p", "-e", "-N", "-t", callsign).replace(/\n$/, "").split("\n");
			}
			frames.push(frame);
		} catch {
			// a session not up yet
		}
		await sleep(300);
	}
}
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;:]*m/g, "");

/** Type a prompt into a session, then wait until both agents are idle for 4 s. */
async function prompt(callsign, text) {
	tmux("send-keys", "-t", callsign, "-l", text);
	await sleep(400);
	tmux("send-keys", "-t", callsign, "Enter");
	for (let i = 0; i < 80 && states()[callsign] !== "busy"; i++) await sleep(250);
	let quietSince = 0;
	const deadline = Date.now() + 8 * 60_000;
	while (Date.now() < deadline) {
		const busy = Object.values(states()).includes("busy");
		if (busy) quietSince = 0;
		else if (!quietSince) quietSince = Date.now();
		else if (Date.now() - quietSince > 4_000) return;
		await sleep(300);
	}
	throw new Error(`${callsign} did not settle in 8 minutes`);
}

let exit = 0;
try {
	for (const agent of AGENTS) {
		launch(agent);
		await sleep(1_000);
	}
	await sleep(6_000);
	const loop = captureLoop();
	console.log(`demo repo: ${project}`);
	await prompt("bravo", "Read test/upload.test.ts and the files it imports, then tell me in one sentence what the test checks.");
	await prompt(
		"alpha",
		"Claim src/auth/** for an auth refactor, then make login() in src/auth/session.ts async — it will look users up in a database soon. Keep the change minimal.",
	);
	await prompt("bravo", "Fix the upload test for the new login(). Ask alpha first whether that signature is final.");
	await sleep(1_000);
	capturing = false;
	await loop;

	// The moment: alpha has replied, bravo has the answer. Prefer frames where bravo's screen still
	// shows the change notice too; among those, the latest (alpha's summary is complete).
	const has = (frame, who, ...needles) => needles.every((n) => plain(frame[who] ?? []).includes(n));
	const answered = frames.filter((f) => has(f, "alpha", "Ask from bravo", "replied to bravo") && has(f, "bravo", "answered:"));
	const withNotice = answered.filter((f) => has(f, "bravo", "changed a file you are working with"));
	const moment = withNotice.at(-1) ?? answered[0];
	if (!moment) {
		console.error(`✖ the ask/reply moment never appeared on screen (${frames.length} frames captured in ${work})`);
		writeFileSync(join(work, "frames.json"), JSON.stringify(frames));
		exit = 1;
	} else {
		mkdirSync(outDir, { recursive: true });
		const out = join(outDir, "team.png");
		const windows = AGENTS.map((a) => ({ title: `${a.callsign} · ${a.name}`, cols: COLS, lines: moment[a.callsign] }));
		const size = renderWindows(windows, out);
		console.log(`✔ ${out} (${size.width}×${size.height}${withNotice.length ? "" : ", without the change notice in view"})`);
		const kept = join(work, "moment.json");
		writeFileSync(kept, JSON.stringify(windows));
		console.log(`  screens kept: re-render with node scripts/screenshots/render.mjs ${kept} ${out}`);
	}
	console.log(`changes the agents made:\n${execFileSync("git", ["diff", "--stat"], { cwd: project, encoding: "utf8" })}`);
} catch (error) {
	console.error(error);
	exit = 1;
} finally {
	capturing = false;
	if (process.env.SHOTS_KEEP !== "1") spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
	else console.log(`sessions left running: tmux -L ${SOCKET} attach -t alpha`);
}
process.exit(exit);
