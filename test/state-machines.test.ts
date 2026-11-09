/** Cross-extension transitions at the run's settlement boundary must compose, not replace. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { eventually, makeProject, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

/** Drafts an earlier extension already proposed, including data that must not reach the model. */
function previousEntries(): SessionBoundaryDraft[] {
	return [
		{ type: "custom", customType: "other-extension-state", data: { saved: true } },
		{ type: "custom_message", customType: "other-extension-message", content: "Keep this instruction.", display: true },
	];
}

test("settlement: deferred messages append to earlier extensions' drafts, without mutating or repeating them", async () => {
	const project = makeProject("p-boundary-deferred-compose");
	const sender = await session(project);
	const recipient = await session(project);
	recipient.ctx.isIdle = () => false;
	await recipient.prompt("work on the schema migration");
	await sender.tool({ action: "send", to: recipient.id, message: "deferred report", interrupt: false });
	await sender.tool({ action: "send", to: recipient.id, message: "delivery fence" });
	await eventually(() => assert.ok(recipient.sentOf("telecom-message").some((m) => m.content.includes("delivery fence"))));

	const entries = previousEntries();
	Object.freeze(entries);
	const result = await recipient.fire("agent_before_settle", {
		entries, continue: false, outcome: "completed", context: { canContinue: true },
	});
	assert.equal(result.continue, true);
	assert.deepEqual(result.entries.slice(0, entries.length), entries);
	assert.equal(result.entries.length, entries.length + 1);
	assert.match(result.entries.at(-1).content, /deferred report/);
	assert.equal(result.entries.at(-1).customType, "telecom-message");
	assert.notEqual(result.entries, entries, "the earlier proposal is not mutated");
	assert.deepEqual(entries, previousEntries());
	assert.equal(await recipient.fire("agent_before_settle", {
		entries, continue: true, outcome: "completed", context: { canContinue: true },
	}), undefined, "nothing remains to append; the earlier continuation is left alone");
});

test("settlement: an owed-ask reminder preserves prior drafts and requests only one continuation", async () => {
	const project = makeProject("p-boundary-ask-compose");
	const sender = await session(project);
	const recipient = await session(project);
	await sender.tool({ action: "ask", to: recipient.id, message: "which schema?", wait: false });
	await eventually(() => assert.equal(recipient.sentOf("telecom-ask").length, 1));

	const entries = previousEntries();
	const result = await recipient.fire("agent_before_settle", {
		entries, continue: true, outcome: "completed", context: { canContinue: true },
	});
	assert.deepEqual(result.entries.slice(0, entries.length), entries);
	assert.equal(result.entries.length, entries.length + 1);
	assert.equal(result.entries.at(-1).customType, "telecom-reminder");
	assert.equal(result.continue, true);
	assert.equal(await recipient.fire("agent_before_settle", {
		entries, continue: true, outcome: "completed", context: { canContinue: true },
	}), undefined, "a still-unanswered ask is reminded only once");
});

test("settlement: new deferred messages and ask reminders make a completed assistant-ending preview continuable", async () => {
	const project = makeProject("p-boundary-new-context");
	const sender = await session(project);
	const recipient = await session(project);
	recipient.ctx.isIdle = () => false;
	await recipient.prompt("work on the schema migration");
	await sender.tool({ action: "ask", to: recipient.id, message: "which schema?", wait: false });
	await sender.tool({ action: "send", to: recipient.id, message: "deferred report", interrupt: false });
	await sender.tool({ action: "send", to: recipient.id, message: "delivery fence" });
	await eventually(() => assert.ok(recipient.sentOf("telecom-message").some((m) => m.content.includes("delivery fence"))));

	// pi reports false when the preview ends in an assistant response. Our custom messages
	// supply new user-role context, which the host validates after all boundary handlers.
	const entries = [previousEntries()[0]];
	const result = await recipient.fire("agent_before_settle", {
		entries, continue: false, outcome: "completed", context: { canContinue: false },
	});
	assert.ok(result, "new context is proposed even though the old preview cannot continue");
	assert.equal(result.continue, true);
	assert.deepEqual(result.entries.slice(0, entries.length), entries);
	assert.deepEqual(result.entries.slice(entries.length).map((e: { customType: string }) => e.customType), ["telecom-message", "telecom-reminder"]);
	assert.equal(await recipient.fire("agent_before_settle", {
		entries: [], continue: false, outcome: "completed", context: { canContinue: false },
	}), undefined, "consumed messages and reminded asks do not create a continuation loop");
	await recipient.fire("agent_settled", { aborted: false });
	assert.equal(recipient.sentOf("telecom-message").filter((m) => m.content.includes("deferred report")).length, 0, "the deferred draft is not delivered a second time at settlement");
});

test("settlement: no telecom work, hard exits, or disconnect leaves other extensions' decisions alone", async () => {
	const project = makeProject("p-boundary-no-op-compose");
	const recipient = await session(project);
	const entries = previousEntries();
	for (const [outcome, canContinue] of [["completed", true], ["aborted", true], ["error", false], ["completed", false]] as const) {
		assert.equal(await recipient.fire("agent_before_settle", {
			entries, continue: true, outcome, context: { canContinue },
		}), undefined);
		assert.deepEqual(entries, previousEntries());
	}
	await recipient.command("off");
	assert.equal(await recipient.fire("agent_before_settle", {
		entries, continue: true, outcome: "completed", context: { canContinue: true },
	}), undefined, "a disconnected runtime has no opinion either");
});
