/**
 * ansi-html — turn a captured terminal screen (`tmux capture-pane -e`) into HTML, cell for cell.
 *
 * Handles the SGR codes tmux emits: reset, bold, dim, italic, underline, inverse, the 16 base
 * colors, the 256-color palette and 24-bit color. Wide characters (emoji, CJK) get two cells so the
 * grid stays aligned the way the terminal drew it.
 */

const BASE16 = [
	"#1d1f24", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
	"#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
];

function palette256(n) {
	if (n < 16) return BASE16[n];
	if (n < 232) {
		const i = n - 16;
		const level = (v) => (v === 0 ? 0 : 55 + v * 40);
		return rgb(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
	}
	const g = 8 + (n - 232) * 10;
	return rgb(g, g, g);
}

function rgb(r, g, b) {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const WIDE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function applySgr(state, params) {
	const p = params.length ? params : [0];
	for (let i = 0; i < p.length; i++) {
		const code = p[i];
		if (code === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.inverse = true;
		else if (code === 22) state.bold = state.dim = false;
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code === 27) state.inverse = false;
		else if (code >= 30 && code <= 37) state.fg = BASE16[code - 30];
		else if (code >= 90 && code <= 97) state.fg = BASE16[code - 90 + 8];
		else if (code >= 40 && code <= 47) state.bg = BASE16[code - 40];
		else if (code >= 100 && code <= 107) state.bg = BASE16[code - 100 + 8];
		else if (code === 39) state.fg = null;
		else if (code === 49) state.bg = null;
		else if (code === 38 || code === 48) {
			let color = null;
			if (p[i + 1] === 5) {
				color = palette256(p[i + 2] ?? 0);
				i += 2;
			} else if (p[i + 1] === 2) {
				color = rgb(p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0);
				i += 4;
			}
			if (code === 38) state.fg = color;
			else state.bg = color;
		}
	}
}

function styleOf(state, theme) {
	let fg = state.fg ?? theme.fg;
	let bg = state.bg;
	if (state.inverse) [fg, bg] = [bg ?? theme.bg, fg];
	const css = [`color:${fg}`];
	if (bg) css.push(`background:${bg}`);
	if (state.bold) css.push("font-weight:700");
	if (state.dim) css.push("opacity:.62");
	if (state.italic) css.push("font-style:italic");
	if (state.underline) css.push("text-decoration:underline");
	return css.join(";");
}

const freshState = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

/**
 * A captured screen → HTML lines. The style state carries across lines: tmux doesn't repeat an
 * unchanged color at the start of the next line. Capture with `-N` so trailing cells (and their
 * backgrounds) are kept; short lines are padded to `cols`.
 */
export function screenToHtml(lines, cols, theme) {
	const state = freshState();
	return lines.map((line) => lineToHtml(line, cols, theme, state));
}

/** One captured line → HTML, continuing from `state`. */
export function lineToHtml(line, cols, theme, state = freshState()) {
	let html = "";
	let col = 0;
	let run = "";
	let runStyle = styleOf(state, theme);
	const flush = () => {
		if (run) html += `<span style="${runStyle}">${run}</span>`;
		run = "";
	};
	const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([\s\S])/gu;
	for (const m of line.matchAll(re)) {
		if (m[1] !== undefined) {
			flush();
			applySgr(state, m[1].split(/[;:]/).filter((s) => s !== "").map(Number));
			runStyle = styleOf(state, theme);
		} else if (m[2] !== undefined) {
			const ch = m[2];
			if (/\p{M}|\u200d|\ufe0f/u.test(ch)) {
				run += ch;
				continue;
			}
			if (WIDE.test(ch)) {
				flush();
				html += `<span class="w" style="${runStyle}">${escapeHtml(ch)}</span>`;
				col += 2;
			} else {
				run += escapeHtml(ch);
				col += 1;
			}
		}
	}
	flush();
	if (col < cols) html += `<span style="color:${theme.fg}">${" ".repeat(cols - col)}</span>`;
	return html;
}
