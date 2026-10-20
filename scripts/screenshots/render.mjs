/**
 * render — draw captured terminal screens as terminal windows and screenshot them to PNG with
 * headless Chrome. The pixels come straight from the capture: no text is retyped or edited.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { screenToHtml } from "./ansi-html.mjs";

/** Terminal colors around pi's built-in dark theme (its own colors arrive as 24-bit codes). */
export const THEME = { fg: "#dcdee3", bg: "#16171d", chrome: "#23252d", border: "#30333d", title: "#9aa0ad" };

const FONT_PX = 13;
const CHAR_PX = FONT_PX * 0.6; // JetBrains Mono advance width
const LINE_PX = 18;
const PAD = 14;
const BAR = 34;
const GAP = 22;
const MARGIN = 28;

export function findChrome() {
	const candidates = [process.env.CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
	const found = candidates.find((c) => c && existsSync(c));
	if (!found) throw new Error("no Chrome/Chromium found; set CHROME=/path/to/chrome");
	return found;
}

/**
 * windows: [{ title, lines: string[] (ANSI), cols }] laid out side by side and aligned at the top.
 * Writes `out` (PNG, 2x scale).
 */
export function renderWindows(windows, out, { chrome = findChrome(), scale = 2 } = {}) {
	const rows = Math.max(...windows.map((w) => w.lines.length));
	const winW = windows.map((w) => Math.ceil(w.cols * CHAR_PX) + PAD * 2);
	const winH = BAR + rows * LINE_PX + PAD * 2;
	const pageW = winW.reduce((a, b) => a + b, 0) + GAP * (windows.length - 1) + MARGIN * 2;
	const pageH = winH + MARGIN * 2;
	const body = windows
		.map((w, i) => {
			const lines = screenToHtml(w.lines, w.cols, THEME).map((l) => `<div class="l">${l}</div>`).join("");
			return `<div class="win" style="width:${winW[i]}px;height:${winH}px">
	<div class="bar"><i></i><i></i><i></i><span>${w.title}</span></div>
	<pre>${lines}</pre>
</div>`;
		})
		.join("\n");
	const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Term; src: local("JetBrains Mono"), local("JetBrainsMono-Regular"); font-weight: 400; }
@font-face { font-family: Term; src: local("JetBrains Mono Bold"), local("JetBrainsMono-Bold"); font-weight: 700; }
html, body { margin: 0; background: transparent; }
body { width: ${pageW}px; height: ${pageH}px; display: flex; gap: ${GAP}px; padding: ${MARGIN}px; box-sizing: border-box; }
.win { background: ${THEME.bg}; border: 1px solid ${THEME.border}; border-radius: 10px; overflow: hidden; box-sizing: border-box;
	box-shadow: 0 10px 28px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.25); }
.bar { height: ${BAR}px; background: ${THEME.chrome}; display: flex; align-items: center; gap: 8px; padding: 0 14px;
	border-bottom: 1px solid ${THEME.border}; font: 600 12px/1 -apple-system, "Segoe UI", "Noto Sans", sans-serif; color: ${THEME.title}; }
.bar i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; display: block; }
.bar i:nth-child(2) { background: #febc2e; } .bar i:nth-child(3) { background: #28c840; }
.bar span { margin-left: 10px; }
pre { margin: 0; padding: ${PAD}px; font: ${FONT_PX}px/${LINE_PX}px Term, "JetBrains Mono", monospace; color: ${THEME.fg};
	font-variant-ligatures: none; white-space: pre; }
/* Each row is exactly one cell tall, and every run fills it, so backgrounds meet without seams. */
.l { height: ${LINE_PX}px; display: flex; }
.l > span { display: block; height: ${LINE_PX}px; flex: none; }
.w { display: inline-block; width: ${CHAR_PX * 2}px; text-align: center; line-height: ${LINE_PX}px;
	font-family: "Noto Color Emoji", "Apple Color Emoji", sans-serif; font-size: ${FONT_PX - 1}px; }
</style><body>${body}</body>`;
	const dir = mkdtempSync(join(tmpdir(), "telecom-shot-"));
	const file = join(dir, "page.html");
	writeFileSync(file, html);
	execFileSync(
		chrome,
		[
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--default-background-color=00000000",
			`--force-device-scale-factor=${scale}`,
			`--window-size=${pageW},${pageH}`,
			`--screenshot=${out}`,
			`file://${file}`,
		],
		{ stdio: "ignore", timeout: 60_000 },
	);
	return { width: pageW * scale, height: pageH * scale, html: file };
}

// Re-render saved screens (the `moment.json` capture.mjs keeps): node render.mjs <screens.json> <out.png>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [screens, out] = process.argv.slice(2);
	if (!screens || !out) {
		console.error("usage: node scripts/screenshots/render.mjs <screens.json> <out.png>");
		process.exit(2);
	}
	const size = renderWindows(JSON.parse(readFileSync(screens, "utf8")), out);
	console.log(`✔ ${out} (${size.width}×${size.height})`);
}
