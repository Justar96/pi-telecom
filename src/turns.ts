/**
 * turns — what telecom does around each run of the agent: at the start, mark it busy, take the
 * task from the prompt and hand the model a team brief; while it runs, note the tool call it is
 * inside (the `step` peers see once a call runs long); before it settles, remind it of asks it
 * still owes an answer, and read the messages that could wait for the end of the run; once settled,
 * mark it idle and deliver the change notices it was spared mid-run.
 */
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { hostOf } from "./host.ts";
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
/**
 * How a short prompt that carries on the standing task starts: an acknowledgement ("go ahead",
 * "yes B is good", "lgtm") or a wrap-up step of the same work ("commit and merge", "push it").
 * Teammates read "commit and merge" as the task otherwise. Only these: "fix parser bug" is short
 * and a new task, and must replace the old one.
 */
const CARRY_ON = /^(?:ok(?:ay)?|k|yes|yeah|yep|yup|ya|sure|go|continue|proceed|carry|keep|do it|please|sounds|lgtm|looks good|thanks?|thx|ty|great|good|nice|cool|perfect|agreed?|approved?|right|fine|alright|correct|exactly|commit|push|merge|ship|retry|try again|again)\b/i;

export function registerTurns(rt: Runtime, inbound: Inbound): void {
	/** A prompt becomes the task unless it only answers or asks the agent something: one word
	 *  ("continue", "yes"), a short follow-up while a task set on purpose stands, or, while any
	 *  task stands, a short question ("you tested ?") or a short go-ahead (`CARRY_ON`). */
	function taskFromPrompt(me: Presence, prompt: string): void {
		const words = prompt.trim().split(/\s+/).length;
		if (words < 2 || (rt.taskExplicit && words < NEW_DIRECTION_WORDS)) return;
		const first = taskLine(prompt).trim();
		if (me.task && words < NEW_DIRECTION_WORDS && (first.endsWith("?") || CARRY_ON.test(first))) return;
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

	/** Asks still owed an answer that were not pointed out yet, as one reminder (and mark them told). */
	function owedReminder(): string | null {
		const due = rt.ledger.inbound().filter((a) => !a.reminded);
		if (due.length === 0) return null;
		for (const ask of due) ask.reminded = true;
		const list = due.map((a) => `  ${a.id} from ${a.fromCallsign}${a.async ? " (not blocked)" : ""}: ${clip(a.text, 120)}`).join("\n");
		// An ask made with `wait: false` blocks nobody, but its asker still counts on the reply.
		const blocked = due.some((a) => !a.async);
		const heading = blocked ? `${plural(due.length, "peer")} still blocked on your reply` : `${plural(due.length, "ask")} still waiting for your reply`;
		const why = blocked ? `even "I can't help with that" unblocks them` : `even "I can't help with that" tells them where they stand`;
		return `**📡 ${heading}**\n${list}\nAnswer each with telecom({ action: "reply", askId: "…", message: "…" }) before you stop — ${why}.`;
	}

	/** The run is over: idle, and what waited for its end is delivered. */
	function settled(): void {
		if (!rt.self) return;
		rt.setState(rt.self, "idle");
		// Held messages the run could not continue with (it was aborted, or could not go on; on omp,
		// always: it has no boundary to add them at, so they arrive as a wake-up).
		rt.deliverDeferred();
		inbound.flushNotices(true);
		rt.publish();
		rt.updateStatus();
	}

	if (hostOf(rt.pi) === "omp") {
		// omp has no `agent_before_settle`/`agent_settled` (host.ts). Its `session_stop` can continue
		// the run with model-only context, which is enough for a reminder; its `agent_end` comes from
		// the settled path, after any continuation, so there it ends the run.
		(rt.on as (event: string, handler: (event: unknown) => unknown) => void)("session_stop", () => {
			if (!rt.self) return;
			const reminder = owedReminder();
			return reminder ? { continue: true, additionalContext: reminder } : undefined;
		});
		// A run an extension message starts (a telecom wake-up) skips `before_agent_start` on omp:
		// without this, peers saw the woken agent idle for its whole run.
		rt.on("agent_start", () => {
			const me = rt.self;
			if (!me || me.state === "busy") return;
			rt.setState(me, "busy");
			rt.publish();
			rt.updateStatus();
		});
		rt.on("agent_end", settled);
		return;
	}

	rt.on("agent_before_settle", (event) => {
		if (!rt.self || event.outcome !== "completed") return;
		// canContinue describes the current preview, which normally ends in an assistant
		// response. Our custom messages add runnable context; pi validates the final proposal.
		// Checking that preview first would skip exactly the reminders that must continue it.
		// Messages that could wait for the end of the run (`interrupt: false`) are read now, in the
		// order they came, and the run goes on with them. Without a continuation they wait for
		// `agent_settled`.
		const entries: SessionBoundaryDraft[] = rt.deferredEntries();
		const reminder = owedReminder();
		if (reminder) {
			entries.push({
				type: "custom_message",
				customType: MESSAGE_TYPES.reminder,
				content: reminder,
				display: true,
				details: { tone: "warning" } satisfies TelecomMessageDetails,
			});
		}
		// Boundary results replace the proposal, rather than append to it. Preserve earlier
		// extensions' drafts (including context edits and state) before adding our own. With
		// nothing to add, leave both their entries and their continuation decision untouched.
		return entries.length > 0 ? { entries: [...event.entries, ...entries], continue: true } : undefined;
	});

	rt.on("agent_settled", settled);
}
