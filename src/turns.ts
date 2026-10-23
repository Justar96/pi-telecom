/**
 * turns — what telecom does around each run of the agent: at the start, mark it busy, take the
 * task from the prompt and hand the model a team brief; before it settles, remind it of asks it
 * still owes an answer; once settled, mark it idle and deliver the change notices it was spared
 * mid-run.
 */
import { renderBrief } from "./board.ts";
import type { Inbound } from "./inbound.ts";
import { adoptRepo } from "./lifecycle.ts";
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
		me.state = "busy";
		if (event.messageType === "user" && event.prompt.trim()) taskFromPrompt(me, event.prompt);
		adoptRepo(me);
		rt.publish();
		const brief = renderBrief(me, rt.readPeers(), rt.briefState, {
			paths: rt.awareness.focusPaths(),
			contacts: new Set(rt.contacts.keys()),
		});
		rt.briefState = brief.state;
		if (!brief.text) return;
		return {
			message: {
				customType: MESSAGE_TYPES.brief,
				content: brief.text,
				display: true,
				details: {
					summary: brief.summary,
					// Display only: the renderer paints these names in each agent's colour.
					callsigns: [me.callsign, ...rt.team().map((p) => p.callsign)],
				} satisfies TelecomMessageDetails,
			},
		};
	});

	rt.on("agent_before_settle", (event) => {
		if (!rt.self || event.outcome === "aborted" || !event.context.canContinue) return;
		const due = rt.ledger.inbound().filter((a) => !a.reminded);
		if (due.length === 0) return;
		for (const ask of due) ask.reminded = true;
		const list = due.map((a) => `  ${a.id} from ${a.fromCallsign}: ${clip(a.text, 120)}`).join("\n");
		return {
			entries: [
				{
					type: "custom_message",
					customType: MESSAGE_TYPES.reminder,
					content: `**📡 ${plural(due.length, "peer")} still blocked on your reply**\n${list}\nAnswer each with telecom({ action: "reply", askId: "…", message: "…" }) before you stop — even "I can't help with that" unblocks them.`,
					display: true,
					details: { tone: "warning" } satisfies TelecomMessageDetails,
				},
			],
			continue: true,
		};
	});

	rt.on("agent_settled", () => {
		if (!rt.self) return;
		rt.self.state = "idle";
		inbound.flushNotices(true);
		rt.publish();
		rt.updateStatus();
	});
}
