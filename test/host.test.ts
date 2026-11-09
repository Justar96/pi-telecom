/**
 * host — telecom in oh-my-pi (omp). omp has no `agent_before_settle`/`agent_settled`, and a run a
 * wake-up starts skips `before_agent_start`, so `turns.ts` settles on `agent_end` and goes busy on
 * `agent_start` there. On pi, `agent_end` is not the end (retries and continuations follow it),
 * so these stay omp's alone. Rendering: omp calls the tool renderers with its own arguments.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { hostOf, renderContext } from "../src/host.ts";
import { TOOL_SPEC } from "../src/tool.ts";
import { openTransport, type Presence } from "../src/transport.ts";
import { eventually, makeProject, PLAIN_THEME, type Session, session, stopSessions } from "./harness.ts";

afterEach(stopSessions);

function published(s: Session): Presence | undefined {
	return openTransport(process.env.PI_TELECOM_DIR as string).readPeers().find((p) => p.id === s.id);
}

test("host: omp is told apart from pi by what its API has", () => {
	assert.equal(hostOf({ registerTranscriptPresenter: () => {} } as never), "omp");
	assert.equal(hostOf({ on: () => {} } as never), "pi");
});

test("host: on omp a run that skips before_agent_start is busy, and agent_end settles it", async () => {
	const proj = makeProject("p-host-omp");
	const a = await session(proj, { omp: true });
	await session(proj);
	await a.fire("agent_start");
	await eventually(() => assert.equal(published(a)?.state, "busy"));
	await a.fire("agent_end", { messages: [] });
	await eventually(() => assert.equal(published(a)?.state, "idle"));
	assert.equal(a.handlers.has("agent_before_settle"), false, "no settle hooks on omp");
});

test("host: on pi agent_end is not the end of a run", async () => {
	const proj = makeProject("p-host-pi");
	const a = await session(proj);
	await a.prompt("fix the upload test");
	await a.fire("agent_end", { messages: [] });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(published(a)?.state, "busy", "a retry or continuation may follow");
	await a.settle();
	await eventually(() => assert.equal(published(a)?.state, "idle"));
});

test("host: the tool renders the same call on pi and omp, framed by telecom only on pi", () => {
	const args = { action: "send", to: "bravo", message: "the parser is done" };
	const pi = (TOOL_SPEC as any).renderCall(args, PLAIN_THEME, { args, expanded: false, isError: false, outputPad: 1 });
	// omp's wrapper passes its options with the theme behind them (a proxy), then the theme.
	const ompOptions = Object.assign(Object.create(PLAIN_THEME), { expanded: false });
	const omp = (TOOL_SPEC as any).renderCall(args, ompOptions, PLAIN_THEME);
	const piText = pi.render(80).join("\n");
	const ompText = omp.render(80).join("\n");
	assert.match(piText, /send → bravo {2}the parser is done/);
	assert.match(ompText, /send → bravo {2}the parser is done/);
	assert.match(piText, /▎/, "pi: telecom's panel edge");
	assert.doesNotMatch(ompText, /▎/, "omp draws its own card");
	assert.equal(renderContext(args, { expanded: true }).host, "omp");
});
