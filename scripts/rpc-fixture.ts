/** Test-only provider: completes turns locally, with an explicit barrier for testing busy delivery. */
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rpcFixture(pi: ExtensionAPI): void {
	let holdNext = false;
	let release: (() => void) | undefined;
	pi.registerProvider("telecom-rpc-test", {
		api: "openai-completions",
		apiKey: "local-test-only",
		baseUrl: "http://localhost/unused",
		models: [{
			id: "fixture", name: "Telecom RPC fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 128,
		}],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const response: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				release = undefined;
				options?.signal?.removeEventListener("abort", finish);
				if (options?.signal?.aborted) {
					response.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: response });
				} else {
					response.content = [{ type: "text", text: "RPC fixture completed." }];
					stream.push({ type: "done", reason: "stop", message: response });
				}
				stream.end();
			};
			stream.push({ type: "start", partial: response });
			if (holdNext && !options?.signal?.aborted) {
				holdNext = false;
				release = finish;
				options?.signal?.addEventListener("abort", finish, { once: true });
			} else {
				queueMicrotask(finish);
			}
			return stream;
		},
	});
	pi.registerCommand("telecom-test", {
		description: "Control the local RPC fixture",
		handler: async (args) => {
			if (args.trim() === "hold") holdNext = true;
			if (args.trim() === "release") release?.();
		},
	});
}
