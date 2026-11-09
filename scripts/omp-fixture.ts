/**
 * omp-fixture — a local test provider that loads in both pi and omp (oh-my-pi), for checks that
 * need real runs without a model: a prompt `tool {"action":"board"}` makes the model call
 * `telecom` with those arguments, then finish; any other prompt is answered with one line.
 *
 * Its API name is its own: omp reserves built-in API names (`openai-completions`), which is why
 * `rpc-fixture.ts` does not load there.
 */
import { appendFileSync } from "node:fs";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** omp wraps the prompt with reminders in one user message, so the line is found anywhere in it. */
const TOOL_PROMPT = /^tool\s+(\{.*\})\s*$/m;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("");
}

/** The tools a request offers, when the host lists them on the context (omp does; pi puts them in
 *  system messages, so `undefined` there means "unknown", not "none"). */
function toolsOf(context: unknown): string[] | undefined {
	const tools = (context as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return undefined;
	return tools.map((t) => (t && typeof t === "object" && "name" in t ? String(t.name) : ""));
}

export default function ompFixture(pi: ExtensionAPI): void {
	let calls = 0;
	pi.registerProvider("telecom-fixture", {
		api: "telecom-fixture-api",
		apiKey: "local-test-only",
		baseUrl: "http://localhost/unused",
		models: [{
			id: "fixture", name: "Telecom fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 128,
		}],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const response: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			const messages = context.messages;
			// The prompt that asked for a call: the last user message holding one. Hosts add their own
			// user-role text around it (telecom's brief, omp's reminders), so it need not be the last.
			const promptOf = (m: (typeof messages)[number]) =>
				m.role === "user"
					? TOOL_PROMPT.exec(
							textOf(m.content)
								.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "\n")
								.replace(/<\/?user>/g, "")
								.trim(),
						)
					: null;
			const at = messages.findLastIndex((m) => promptOf(m) !== null);
			const after = at >= 0 ? messages.slice(at + 1) : [];
			// Answered already (a reply after it), or the call made (its result is in): no new call.
			const answered = after.some((m) => m.role === "assistant" && textOf(m.content).trim() !== "");
			const wanted = at >= 0 && !answered ? promptOf(messages[at] as (typeof messages)[number]) : null;
			const called = after.some((m) => m.role === "toolResult");
			if (process.env.TELECOM_FIXTURE_DEBUG) {
				appendFileSync(process.env.TELECOM_FIXTURE_DEBUG, `${JSON.stringify(messages.map((m) => [m.role, textOf((m as { content?: unknown }).content).slice(0, 2000)]))} tools=${(toolsOf(context) ?? []).join(",")}\n`);
			}
			// Side requests (omp's title generation) carry no tools: they only ever get text.
			const tools = toolsOf(context);
			const canCall = tools === undefined || tools.includes("telecom");
			stream.push({ type: "start", partial: response });
			// Streamed block by block, as a provider does: omp builds the message from these events,
			// and takes a bare `done` for an empty reply.
			queueMicrotask(() => {
				if (wanted && canCall && !called) {
					const toolCall = { type: "toolCall" as const, id: `fixture-${++calls}`, name: "telecom", arguments: JSON.parse(wanted[1] ?? "{}") };
					response.stopReason = "toolUse";
					response.content = [toolCall];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: response });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: response });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: response });
					stream.push({ type: "done", reason: "toolUse", message: response });
				} else {
					const text = wanted ? "Done." : "Fixture reply.";
					response.content = [{ type: "text", text }];
					stream.push({ type: "text_start", contentIndex: 0, partial: response });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: response });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				}
				stream.end();
			});
			return stream;
		},
	});
}
