/**
 * turns — what telecom does around each run of the agent: at the start, mark it busy, take the
 * task from the prompt and hand the model a team brief; while it runs, note the tool call it is
 * inside (the `step` peers see once a call runs long); before it settles, remind it of asks it
 * still owes an answer; once settled, mark it idle and deliver the change notices it was spared
 * mid-run.
 */
import type { Inbound } from "./inbound.ts";
import { adoptRepo } from "./lifecycle.ts";
import { LOG_HINT } from "./log.ts";
import { MESSAGE_TYPES, type TelecomMessageDetails } from "./render.ts";
import { type Runtime, taskLine } from "./runtime.ts";
import type { Presence } from "./transport.ts";
import { clip, plural } from "./util.ts";

/**
 * A task the agent or its human set on purpose (`status`, a team task) is not replaced by a
 * prompt shorter than this: "continue", "yes B is good" or "both enabled" answer the agent, they
 * don't reassign it, and each replacement reaches every teammate's brief as news.
 */
const NEW_DIRECTION_WORDS = 10;

export function registerTurns(rt: Runtime, inbound: Inbound): void {
	/** A prompt becomes the task unless it only answers or asks the agent something: one word
	 *  ("continue", "yes"), a short follow-up while a task set on purpose stands, or a short
	 *  question ("you tested ?") while any task stands. */
	function taskFromPrompt(me: Presence, prompt: string): void {
		const words = prompt.trim().split(/\s+/).length;
		if (words < 2 || (rt.taskExplicit && words < NEW_DIRECTION_WORDS)) return;
		const first = taskLine(prompt);
		if (me.task && words < NEW_DIRECTION_WORDS && first.trim().endsWith("?")) return;
		rt.setTask(me, first, false);
	}

	rt.on("before_agent_start", (event, ctx) => {
		rt.ctx = ctx;
		const me = rt.self;
		if (!me) return;
		rt.setState(me, "busy");
		if (event.messageType === "user" && event.prompt.trim()) taskFromPrompt(me, event.prompt);
		adoptRepo(me);
		rt.publish();
		const fullBefore = rt.briefState?.fullAt;
		const brief = rt.nextBrief(me);
		// Broadcasts held for this run ride along: one message per run start is all a hook gets.
		const held = rt.takeLater();
		if (!brief.text) {
			return held ? { message: { customType: MESSAGE_TYPES.broadcast, content: held, display: true, details: {} } } : undefined;
		}
		// A full brief (the first, or after a compaction) shows the team as it is now, not what was
		// decided before: point to the log when teammates have written to it.
		const full = rt.briefState?.fullAt !== fullBefore;
		const content = full && rt.teamLog(rt.peers).some((e) => e.session !== me.id) ? `${brief.text}\n${LOG_HINT}` : brief.text;
		return {
			message: {
				customType: MESSAGE_TYPES.brief,
				content: held ? `${content}\n\n${held}` : content,
				display: true,
				details: brief.details,
			},
		};
	});

	// The tool call a run is inside, for peers deciding whether a message reaches it soon. Noted
	// here and published from the tick only once it runs long (`STEP_PUBLISH_AFTER_MS`). A call
	// another tool made is part of that tool's step. pi reports no `tool_result` for a blocked or
	// aborted call, but always a `tool_execution_end`, so both end it.
	rt.on("tool_call", (event) => {
		if (rt.self && !event.parentToolCallId) rt.noteStepStart(event.toolCallId, event.toolName);
	});
	rt.on("tool_result", (event) => {
		rt.noteStepEnd(event.toolCallId);
	});
	rt.on("tool_execution_end", (event) => {
		rt.noteStepEnd(event.toolCallId);
	});

	// The model answered: a run started by a peer's message did reach it (`Runtime.checkWakes`).
	rt.on("message_end", (event) => {
		const message = event.message;
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") rt.noteModelTurn();
	});

	rt.on("agent_before_settle", (event) => {
		if (!rt.self || event.outcome === "aborted" || !event.context.canContinue) return;
		const due = rt.ledger.inbound().filter((a) => !a.reminded);
		if (due.length === 0) return;
		for (const ask of due) ask.reminded = true;
		const list = due.map((a) => `  ${a.id} from ${a.fromCallsign}${a.async ? " (not blocked)" : ""}: ${clip(a.text, 120)}`).join("\n");
		// An ask made with `wait: false` blocks nobody, but its asker still counts on the reply.
		const blocked = due.some((a) => !a.async);
		const heading = blocked ? `${plural(due.length, "peer")} still blocked on your reply` : `${plural(due.length, "ask")} still waiting for your reply`;
		const why = blocked ? `even "I can't help with that" unblocks them` : `even "I can't help with that" tells them where they stand`;
		return {
			entries: [
				{
					type: "custom_message",
					customType: MESSAGE_TYPES.reminder,
					content: `**📡 ${heading}**\n${list}\nAnswer each with telecom({ action: "reply", askId: "…", message: "…" }) before you stop — ${why}.`,
					display: true,
					details: { tone: "warning" } satisfies TelecomMessageDetails,
				},
			],
			continue: true,
		};
	});

	rt.on("agent_settled", () => {
		if (!rt.self) return;
		rt.setState(rt.self, "idle");
		inbound.flushNotices(true);
		rt.publish();
		rt.updateStatus();
	});
}
