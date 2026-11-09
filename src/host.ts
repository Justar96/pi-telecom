/**
 * host — which coding agent loaded telecom, and the few places where the hosts differ. Telecom is
 * written against pi's extension API; omp (oh-my-pi, `@oh-my-pi/pi-coding-agent`) loads pi
 * extensions through its legacy shim, with these differences that matter here:
 *
 * - omp emits neither `agent_before_settle` nor `agent_settled`. Its `agent_end` fires from the
 *   settled path, after its own `session_stop` continuations, so there it means "the run is over".
 *   On pi, `agent_end` is NOT final (a retry or a continuation follows), so it is used only on omp.
 * - omp offers extension tools to the model only on discovery unless they say `loadMode:
 *   "essential"`, and asks for approval of tools without an `approval` tier. Telecom is how
 *   agents coordinate, so it is always offered; it edits no project file and runs nothing.
 * - omp calls a tool's renderers as `renderCall(args, optionsAndTheme, theme)` (its options with
 *   the theme behind them, a proxy: `extensions/wrapper.ts`) and `renderResult(result, options,
 *   theme, args)`, where pi passes a render context last. `renderContext` gives every renderer
 *   pi's shape.
 * - omp's message renderers get no `outputPad`.
 *
 * Pure: it reads the API object it is given, at registration, and keeps nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Host = "pi" | "omp";

/**
 * omp's extension API, told apart by methods pi does not have. Read off the API object (not the
 * runtime, nor an environment variable): it is what decides which events will ever fire.
 */
export function hostOf(pi: ExtensionAPI): Host {
	const api = pi as unknown as Record<string, unknown>;
	return typeof api.registerFileWriteFallback === "function" || typeof api.registerTranscriptPresenter === "function" ? "omp" : "pi";
}

/** Tool fields only omp reads; pi ignores unknown fields of a tool definition. */
export const OMP_TOOL_FIELDS = { loadMode: "essential", approval: "read" } as const;

/** What telecom's tool renderers read from a render context: pi's `ToolRenderContext`, in part. */
export interface RenderContext<TArgs> {
	/** omp draws a tinted, padded card around a tool's rendering; pi leaves the frame to telecom. */
	host: Host;
	args: TArgs | undefined;
	expanded: boolean;
	isError: boolean;
	outputPad: number | undefined;
}

/**
 * pi's render context, from whatever the host passed. pi passes it last (`context.args`); omp
 * passes the arguments themselves last to `renderResult` and its theme last to `renderCall`, with
 * `expanded` in the options. A theme is told apart by `fg`, which arguments never have.
 */
export function renderContext<TArgs>(last: unknown, options?: { expanded?: unknown; isError?: unknown }): RenderContext<TArgs> {
	const record = last && typeof last === "object" ? (last as Record<string, unknown>) : undefined;
	// telecom's own parameters have no `args`, so a record with one is pi's context.
	const isPi = record !== undefined && "args" in record;
	const isTheme = record !== undefined && typeof record.fg === "function";
	if (isPi) {
		return {
			host: "pi",
			args: record.args as TArgs,
			expanded: record.expanded === true,
			isError: record.isError === true,
			outputPad: typeof record.outputPad === "number" ? record.outputPad : undefined,
		};
	}
	return {
		host: "omp",
		args: isTheme ? undefined : (record as TArgs | undefined),
		expanded: options?.expanded === true,
		isError: options?.isError === true,
		outputPad: undefined,
	};
}
