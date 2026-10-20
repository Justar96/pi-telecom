/**
 * render — how telecom messages look in the interactive transcript.
 *
 * The model reads each message's `content` verbatim; these renderers only change what the
 * human sees: a coloured header naming the peer, the body, and long bodies folded until the
 * message is expanded. The team brief folds to a single line.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

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
			const box = new Box(outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
			box.addChild(new Text(body.trim() ? `${header}\n${body.replace(/^\n+/, "")}` : header, 0, 0));
			return box;
		});
	}
}
