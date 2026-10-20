/**
 * render — how telecom messages look in the interactive transcript.
 *
 * The model reads each message's `content` verbatim; these renderers only change what the
 * human sees: a coloured header naming the peer, the body, and long bodies folded until the
 * message is expanded. The team brief folds to a single line. Wrapped lines keep their indent
 * (hanging under a bullet), and a change notice's diff excerpt is coloured like pi's own diffs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const MESSAGE_TYPES = {
	message: "telecom-message",
	broadcast: "telecom-broadcast",
	ask: "telecom-ask",
	reply: "telecom-reply",
	change: "telecom-change",
	claim: "telecom-claim",
	brief: "telecom-brief",
	reminder: "telecom-reminder",
} as const;

export interface TelecomMessageDetails {
	/** The one-line form shown when the message is folded. */
	summary?: string;
	from?: string;
	fromCallsign?: string;
	tone?: "info" | "warning" | "accent";
}

const FOLD_LINES = 12;
/** A change notice's excerpt line: deep indent, then the diff sign. */
const DIFF_LINE = /^(\s{4,})([-+])/;

/**
 * Text that wraps each line on its own and indents the continuation: under the text after a
 * leading bullet ("• ", "- "), otherwise under the line's own indent. pi-tui's `Text` would
 * restart wrapped lines at column 0, which breaks indented lists in narrow terminals.
 */
export class HangingText implements Component {
	private readonly text: string;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines: string[] = [];
		for (const line of this.text.replace(/\t/g, "   ").split("\n")) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			const hang = Math.min(/^\s*(?:[•\-*] )?/.exec(plain)?.[0].length ?? 0, Math.floor(width / 2));
			const [first = "", ...rest] = wrapTextWithAnsi(line, Math.max(1, width));
			lines.push(first);
			if (rest.length === 0) continue;
			// Re-wrap the remainder at the narrower width so nothing overflows once indented.
			const remainder = rest.map((part) => part.trimStart()).join(" ");
			for (const part of wrapTextWithAnsi(remainder, Math.max(1, width - hang))) lines.push(" ".repeat(hang) + part);
		}
		const bounded = lines.map((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, width)[0] ?? "" : line));
		this.cache = { width, lines: bounded };
		return bounded;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function registerRenderers(pi: ExtensionAPI): void {
	for (const customType of Object.values(MESSAGE_TYPES)) {
		pi.registerMessageRenderer<TelecomMessageDetails>(customType, (message, { expanded, outputPad }, theme) => {
			const details = message.details ?? {};
			const raw = textOf(message.content).trim();
			const [first = "", ...rest] = raw.split("\n");
			const color = details.tone === "warning" ? "warning" : details.tone === "accent" ? "accent" : "customMessageLabel";
			const header = theme.fg(color, theme.bold(first.replace(/\*\*/g, "")));
			let body: string;
			if (customType === MESSAGE_TYPES.brief && !expanded) {
				body = theme.fg("dim", details.summary ?? "");
			} else if (!expanded && rest.length > FOLD_LINES) {
				body = `${rest.slice(0, FOLD_LINES).join("\n")}\n${theme.fg("dim", `… ${rest.length - FOLD_LINES} more lines (expand to read)`)}`;
			} else {
				body = rest.join("\n");
			}
			if (customType === MESSAGE_TYPES.change) {
				body = body
					.split("\n")
					.map((line) => {
						const diff = DIFF_LINE.exec(line);
						if (!diff) return line;
						return diff[1] + theme.fg(diff[2] === "+" ? "toolDiffAdded" : "toolDiffRemoved", line.slice(diff[1].length));
					})
					.join("\n");
			}
			const box = new Box(outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
			box.addChild(new HangingText(body.trim() ? `${header}\n${body.replace(/^\n+/, "")}` : header));
			return box;
		});
	}
}
