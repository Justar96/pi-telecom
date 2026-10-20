/**
 * pi-telecom — parallel pi agents in one project, working as a team.
 *
 * Every pi session that loads this extension joins a machine-local switchboard (see
 * `transport.ts`). Sessions whose working directory resolves to the same project root form a
 * team, and each member gets:
 *
 *   - a CALLSIGN (alpha, bravo, …) peers and humans can address it by;
 *   - a live PRESENCE record: busy/idle, current task (taken from the prompt, or set by the
 *     agent), branch, claims, and the files it changed recently;
 *   - a TEAM BRIEF at the start of a prompt whenever the team changed since the last one;
 *   - CHANGE NOTICES: when a peer edits a file this agent read or edited, or one inside this
 *     agent's claim, a coalesced notice arrives — mid-run (steered in before the next model call)
 *     or, when idle, appended for the next prompt. Notices never wake an idle agent;
 *   - an EDIT GUARD: a whole-file `write` over a peer's unseen change is stopped with the reason,
 *     a stale `edit` gets a warning, and a path inside a peer's claim is held back once (the
 *     owner is told) — `PI_TELECOM_GUARD=strict|standard|off`;
 *   - the `telecom` TOOL: board, send, ask (blocks for the reply), reply, broadcast, status,
 *     claim and release;
 *   - the `/telecom` COMMAND for the human: the board, renaming, messaging an agent directly,
 *     and a live board widget.
 *
 * Messaging is derived from @tinoy/pi-ipc (MIT, github.com/tinoy1336/pi-extensions); the team
 * layer — projects, callsigns, briefs, change notices, claims and the guard — is new.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Awareness, type PeerChange, type Verdict } from "./awareness.ts";
import { renderBoard, renderBrief } from "./board.ts";
import { CALLSIGN_PATTERN, mustYield, NATO, pickCallsign } from "./callsign.ts";
import { MAX_ASK_TIMEOUT_MS, readConfig, type TelecomConfig } from "./config.ts";
import { absolutePattern, claimsOverlap, matchesClaim } from "./glob.ts";
import { type AskOutcome, createAskLedger, type InboundAsk } from "./ledger.ts";
import { canonicalPath, displayPath, findProjectRoot, readBranch } from "./project.ts";
import { MESSAGE_TYPES, registerRenderers, type TelecomMessageDetails } from "./render.ts";
import {
	type Envelope,
	openTransport,
	type Presence,
	processStartTicks,
	type Transport,
	transportRoot,
	WIRE_VERSION,
} from "./transport.ts";
import { ago, clip, messageOf, newId, plural } from "./util.ts";

const TOOL = "telecom";
const CALLSIGN_ENTRY = "telecom-callsign";
const RECENT_CAP = 12;
const TICK_MS_DEFAULT = 500;
const NOTICE_COALESCE_MS = 1_200;
const HEARTBEAT_MS = 15_000;
const MIN_ID_PREFIX = 4;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text: `telecom: ${text}` }], details: { ok: false, ...details }, isError: true };
}

interface FileChangedData {
	path: string;
	op: "edit" | "write";
	summary?: string;
	excerpt?: string[];
	created?: boolean;
}

interface PendingNotice {
	change: PeerChange;
	count: number;
	relation: "read" | "edited" | "claimed";
	claim?: string;
	excerpt?: string[];
}

export default function telecom(pi: ExtensionAPI): void {
	// ------------------------------------------------------------------ state (per session runtime)
	let cfg: TelecomConfig = readConfig();
	let transport: Transport | null = null;
	let self: Presence | null = null;
	let ctxRef: ExtensionContext | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let tickCount = 0;
	let lastHeartbeat = 0;
	let peersCache: Presence[] = [];
	let teamIds = new Set<string>();
	let lastBriefSignature = "";
	let widgetOn = false;
	let unavailable: string | null = null;

	const awareness = new Awareness();
	const ledger = createAskLedger();
	const wakeTimes: number[] = [];
	const notices = new Map<string, PendingNotice>();
	let noticeSince = 0;
	/** Warnings computed at tool_call, appended to the matching tool_result. */
	const callNotes = new Map<string, string>();
	/** Whether a written path existed before the write, by tool call id. */
	const existedBefore = new Map<string, boolean>();
	/** Who was held back by each of our claims, so a release can tell them. */
	const contesters = new Map<string, Map<string, string>>();

	registerRenderers(pi);

	// ------------------------------------------------------------------ helpers

	function root(): string {
		return self?.projectRoot ?? "";
	}

	const reported = new Set<string>();
	function report(where: string, error: unknown): void {
		// Diagnostics never reach the model; they surface in the UI once per distinct problem.
		const text = `telecom ${where}: ${messageOf(error)}`;
		if (reported.has(text)) return;
		reported.add(text);
		try {
			ctxRef?.ui.notify(text, "warning");
		} catch {
			/* no UI */
		}
	}

	function publish(): void {
		if (!transport || !self) return;
		self.heartbeatAt = Date.now();
		self.name = pi.getSessionName() || undefined;
		if (!self.name) delete self.name;
		const written = transport.writePresence(self);
		if (!written.ok) report("presence", written.reason);
		lastHeartbeat = Date.now();
	}

	function readPeers(): Presence[] {
		if (!transport) return [];
		try {
			peersCache = transport.readPeers();
		} catch (error) {
			report("peers", error);
		}
		return peersCache;
	}

	function team(peers: readonly Presence[] = peersCache): Presence[] {
		return peers.filter((p) => self && p.id !== self.id && p.projectRoot === self.projectRoot);
	}

	function allowWake(): boolean {
		const now = Date.now();
		while (wakeTimes.length > 0 && now - (wakeTimes[0] as number) > 60_000) wakeTimes.shift();
		if (wakeTimes.length >= cfg.maxWakesPerMinute) return false;
		wakeTimes.push(now);
		return true;
	}

	/**
	 * Put a telecom message in front of the model. `wake` starts a turn when idle (steers it in
	 * when busy); `passive` steers it in when busy and appends it silently when idle.
	 */
	function inject(
		customType: string,
		content: string,
		details: TelecomMessageDetails & Record<string, unknown>,
		mode: "wake" | "passive" | "wake-always",
	): void {
		const wake = mode === "wake-always" || (mode === "wake" && allowWake());
		const note =
			mode === "wake" && !wake
				? `\n\n(telecom: more than ${cfg.maxWakesPerMinute} peer messages woke you in the last minute, so this one arrived without starting a turn.)`
				: "";
		try {
			pi.sendMessage(
				{ customType, content: content + note, display: true, details },
				wake ? { triggerTurn: true } : undefined,
			);
		} catch (error) {
			report("deliver", error);
		}
	}

	function envelope(to: string, kind: Envelope["kind"], text: string, extra: Partial<Envelope> = {}): Envelope {
		return {
			v: WIRE_VERSION,
			id: newId(kind === "ask" ? "ask" : kind.slice(0, 3)),
			ts: Date.now(),
			from: self?.id ?? "unknown",
			fromCallsign: self?.callsign ?? "unknown",
			to,
			kind,
			text,
			...extra,
		};
	}

	function sendEvent(to: Presence, topic: string, text: string, data: unknown): void {
		if (!transport) return;
		const sent = transport.deliver(envelope(to.id, "event", text, { topic, data }));
		if (!sent.ok) report("event", sent.reason);
	}

	function updateStatus(): void {
		const ui = ctxRef?.ui;
		if (!ui || !self) return;
		try {
			const mates = team();
			const asks = ledger.inbound().length;
			const busy = mates.filter((p) => p.state === "busy").length;
			const parts = [`📡 ${self.callsign}`];
			parts.push(mates.length === 0 ? "solo" : `${plural(mates.length, "peer")}${busy ? ` (${busy} busy)` : ""}`);
			if (self.claims.length > 0) parts.push(plural(self.claims.length, "claim"));
			if (asks > 0) parts.push(`${plural(asks, "ask")} waiting`);
			ui.setStatus("telecom", parts.join(" · "));
			if (widgetOn) ui.setWidget("telecom", boardText("project").split("\n"));
		} catch {
			/* UI not available in this mode */
		}
	}

	function boardText(scope: "project" | "machine"): string {
		if (!self) return "telecom is not connected in this session.";
		return renderBoard({ self, peers: readPeers(), scope, inboundAsks: ledger.inbound() });
	}

	// ------------------------------------------------------------------ addressing

	type Target = { ok: true; peer: Presence } | { ok: false; reason: string };

	function resolveTarget(raw: string, peers: readonly Presence[]): Target {
		const to = raw.trim().replace(/^@/, "");
		const lower = to.toLowerCase();
		const others = peers.filter((p) => p.id !== self?.id);
		const sameProject = others.filter((p) => p.projectRoot === root());
		const pick = (list: Presence[], what: string): Target | null => {
			if (list.length === 1) return { ok: true, peer: list[0] as Presence };
			if (list.length > 1) {
				return {
					ok: false,
					reason: `"${to}" is the ${what} of ${list.length} sessions — use an id prefix: ${list.map((p) => `${p.id.slice(0, 8)} (${p.callsign} in ${p.projectRoot})`).join(", ")}`,
				};
			}
			return null;
		};
		if (self && (lower === self.callsign || to === self.id)) {
			return { ok: false, reason: "that is you — a message to yourself would arrive as your own turn" };
		}
		return (
			pick(sameProject.filter((p) => p.callsign === lower), "callsign") ??
			pick(others.filter((p) => p.callsign === lower), "callsign") ??
			pick(others.filter((p) => p.name === to), "name") ??
			pick(others.filter((p) => p.id === to), "id") ??
			(to.length >= MIN_ID_PREFIX ? pick(others.filter((p) => p.id.startsWith(to)), "id prefix") : null) ?? {
				ok: false,
				reason: `no live agent answers to "${to}". ${
					sameProject.length > 0
						? `In this project: ${sameProject.map((p) => p.callsign).join(", ")}.`
						: "No other agent is live in this project."
				} telecom({ action: "board" }) shows everyone.`,
			}
		);
	}

	function stateHint(peer: Presence): string {
		return peer.state === "busy" ? "busy — it reaches them before their next step" : "idle — this wakes them";
	}

	// ------------------------------------------------------------------ inbound

	function handleEnvelope(env: Envelope): void {
		const from = env.fromCallsign;
		const human = env.human ? " (from their human)" : "";
		const base: TelecomMessageDetails & Record<string, unknown> = { from: env.from, fromCallsign: from, id: env.id };
		switch (env.kind) {
			case "message":
				inject(
					MESSAGE_TYPES.message,
					`**📡 Message from ${from}${human}**\n\n${env.text}\n\n(Reply only if it needs one: telecom({ action: "send", to: "${from}", message: "…" }).)`,
					{ ...base, tone: "accent" },
					"wake",
				);
				return;
			case "broadcast":
				inject(MESSAGE_TYPES.broadcast, `**📡 Broadcast from ${from}${human}**\n\n${env.text}`, base, "passive");
				return;
			case "ask": {
				const ask: Omit<InboundAsk, "reminded"> = {
					id: env.id,
					from: env.from,
					fromCallsign: from,
					text: env.text,
					at: env.ts,
				};
				ledger.noteInbound(ask);
				ledger.interruptAll({ ...ask, reminded: false });
				inject(
					MESSAGE_TYPES.ask,
					`**📡 Ask from ${from}${human}** — they are blocked until you reply\n\n${env.text}\n\nReply with telecom({ action: "reply", askId: "${env.id}", message: "<your answer>" }).`,
					{ ...base, tone: "warning", askId: env.id },
					"wake-always",
				);
				updateStatus();
				return;
			}
			case "answer": {
				const answerTo = env.answerTo ?? "";
				if (ledger.settle(answerTo, env.text, from)) return;
				const late = ledger.wasAbandoned(answerTo);
				inject(
					MESSAGE_TYPES.reply,
					late
						? `**📡 Late reply from ${from}** to your ask "${clip(late.text, 80)}"\n\n${env.text}`
						: `**📡 Reply from ${from}**\n\n${env.text}`,
					{ ...base, tone: "accent" },
					late ? "wake" : "passive",
				);
				return;
			}
			case "event":
				handleEvent(env);
				return;
		}
	}

	function handleEvent(env: Envelope): void {
		if (!self) return;
		if (env.topic === "file.changed") {
			const data = env.data as Partial<FileChangedData> | undefined;
			if (!data || typeof data.path !== "string" || (data.op !== "edit" && data.op !== "write")) return;
			const change: PeerChange = {
				peerId: env.from,
				callsign: env.fromCallsign,
				path: data.path,
				op: data.op,
				at: env.ts,
				...(data.summary ? { summary: data.summary } : {}),
			};
			const { relation, firstNotice } = awareness.notePeerChange(change);
			const claim = self.claims.find((c) => matchesClaim(data.path as string, c.pattern, root()));
			if (!claim && !(relation && firstNotice)) return;
			const key = `${env.from}\u0000${data.path}`;
			const prior = notices.get(key);
			if (notices.size === 0) noticeSince = Date.now();
			notices.set(key, {
				change,
				count: (prior?.count ?? 0) + 1,
				relation: claim ? "claimed" : (relation ?? "read"),
				...(claim ? { claim: claim.pattern } : {}),
				...(Array.isArray(data.excerpt) ? { excerpt: data.excerpt.slice(0, 4).map(String) } : {}),
			});
			return;
		}
		if (env.topic === "claim.contested") {
			const data = env.data as { path?: string; pattern?: string } | undefined;
			if (!data?.path || !data.pattern) return;
			const set = contesters.get(data.pattern) ?? new Map<string, string>();
			set.set(env.from, env.fromCallsign);
			contesters.set(data.pattern, set);
			inject(
				MESSAGE_TYPES.claim,
				`**📡 ${env.fromCallsign} needs a path you claimed**\n\n${env.fromCallsign} tried to change ${displayPath(data.path, root())}, inside your claim "${data.pattern}". They were asked to check with you first. If you no longer need the whole area, narrow or release it: telecom({ action: "release", paths: ["${data.pattern}"] }).`,
				{ from: env.from, fromCallsign: env.fromCallsign, tone: "warning" },
				"passive",
			);
			return;
		}
		if (env.topic === "ask.withdrawn") {
			const askId = (env.data as { askId?: unknown } | undefined)?.askId;
			if (typeof askId === "string" && ledger.resolveInbound(askId)) {
				inject(
					MESSAGE_TYPES.reply,
					`**📡 ${env.fromCallsign} withdrew their ask** (${askId})\n\nNo reply is needed any more.`,
					{ from: env.from, fromCallsign: env.fromCallsign },
					"passive",
				);
				updateStatus();
			}
			return;
		}
		if (env.topic === "claim.released") {
			const data = env.data as { patterns?: string[] } | undefined;
			const patterns = (data?.patterns ?? []).join(", ");
			inject(
				MESSAGE_TYPES.claim,
				`**📡 ${env.fromCallsign} released ${patterns || "their claim"}**\n\nYou can work there now.`,
				{ from: env.from, fromCallsign: env.fromCallsign },
				"passive",
			);
		}
	}

	function flushNotices(force = false): void {
		if (notices.size === 0 || !self) return;
		if (!force && Date.now() - noticeSince < NOTICE_COALESCE_MS) return;
		const byPeer = new Map<string, PendingNotice[]>();
		for (const notice of notices.values()) {
			const list = byPeer.get(notice.change.callsign) ?? [];
			list.push(notice);
			byPeer.set(notice.change.callsign, list);
		}
		notices.clear();
		for (const [callsign, list] of byPeer) {
			const lines = list.map((n) => {
				const verb = n.change.op === "write" ? (n.count > 1 ? `rewrote (${n.count}×)` : "rewrote") : n.count > 1 ? `edited (${n.count}×)` : "edited";
				const why =
					n.relation === "claimed"
						? `inside your claim "${n.claim}"`
						: n.relation === "edited"
							? "you edited this file earlier"
							: "you read this file earlier";
				const summary = n.change.summary ? `, ${n.change.summary}` : "";
				const excerpt = n.excerpt?.length ? `\n${n.excerpt.map((l) => `      ${l}`).join("\n")}` : "";
				return `  • ${displayPath(n.change.path, root())} — ${verb}${summary} · ${why}${excerpt}`;
			});
			const files = list.length === 1 ? "a file" : plural(list.length, "file");
			inject(
				MESSAGE_TYPES.change,
				`**📡 ${callsign} changed ${files} you are working with**\n${lines.join("\n")}\nRe-read before you edit ${list.length === 1 ? "it" : "them"}; your earlier view is stale.`,
				{ fromCallsign: callsign, tone: "warning", summary: `${callsign} changed ${list.map((n) => displayPath(n.change.path, root())).join(", ")}` },
				"passive",
			);
		}
	}

	// ------------------------------------------------------------------ the loop

	function tick(): void {
		if (!transport || !self) return;
		tickCount++;
		try {
			const drained = transport.drain(self.id);
			for (const env of drained.envelopes) {
				try {
					handleEnvelope(env);
				} catch (error) {
					report("inbound", error);
				}
			}
		} catch (error) {
			report("drain", error);
		}
		if (tickCount % 2 === 0) refreshTeam();
		flushNotices();
		ledger.expire(Date.now());
		if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) heartbeat();
	}

	function refreshTeam(): void {
		if (!self) return;
		const peers = readPeers();
		const live = new Set(peers.map((p) => p.id));
		ledger.failPeerGone((id) => !live.has(id));
		const gone = new Set([...teamIds].filter((id) => !live.has(id)));
		if (gone.size > 0) ledger.dropInboundFrom(gone);
		// Converge on unique callsigns: the younger of two sessions with the same word moves.
		if (mustYield(self, peers)) {
			const taken = new Set(team(peers).map((p) => p.callsign));
			const old = self.callsign;
			self.callsign = pickCallsign(taken);
			persistCallsign();
			publish();
			ctxRef?.ui.notify(`📡 callsign ${old} was taken; you are now ${self.callsign}`, "info");
		}
		const mates = team(peers);
		const ids = new Set(mates.map((p) => p.id));
		const joined = mates.filter((p) => !teamIds.has(p.id));
		const left = [...teamIds].filter((id) => !ids.has(id));
		if (tickCount > 2 && (joined.length > 0 || left.length > 0)) {
			const parts: string[] = [];
			if (joined.length) parts.push(`${joined.map((p) => p.callsign).join(", ")} joined`);
			if (left.length) parts.push(`${plural(left.length, "agent")} left`);
			try {
				ctxRef?.ui.notify(`📡 ${parts.join("; ")}`, "info");
			} catch {
				/* no UI */
			}
		}
		teamIds = ids;
		updateStatus();
	}

	function heartbeat(): void {
		if (!self || !transport) return;
		const now = Date.now();
		const before = self.claims.length;
		self.claims = self.claims.filter((c) => c.expiresAt > now);
		if (self.claims.length < before) {
			inject(
				MESSAGE_TYPES.claim,
				`**📡 ${plural(before - self.claims.length, "claim")} expired**\n\nNo activity inside ${before - self.claims.length === 1 ? "it" : "them"} for ${Math.round(cfg.claimTtlMs / 60_000)} minutes, so peers may work there now. Claim again if you still need it.`,
				{},
				"passive",
			);
		}
		self.branch = readBranch(self.projectRoot);
		if (!self.branch) delete self.branch;
		publish();
		try {
			transport.sweep();
		} catch (error) {
			report("sweep", error);
		}
	}

	function persistCallsign(): void {
		if (!self) return;
		try {
			pi.appendEntry(CALLSIGN_ENTRY, { callsign: self.callsign });
		} catch {
			/* not persisted; a resume will just pick a fresh word */
		}
	}

	// ------------------------------------------------------------------ session lifecycle

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = null;
		if (transport && self) {
			try {
				transport.removePresence(self.id);
				transport.removeInbox(self.id);
			} catch {
				/* the sweep of whoever is left will clean up */
			}
		}
		self = null;
		try {
			ctxRef?.ui.setStatus("telecom", undefined);
			ctxRef?.ui.setWidget("telecom", undefined);
		} catch {
			/* no UI */
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		cfg = readConfig();
		if (cfg.disabled) return;
		try {
			const id = ctx.sessionManager.getSessionId();
			if (!id) return;
			if (self && self.id !== id) stop();
			const rootResult = transportRoot();
			if (!rootResult.ok) {
				unavailable = rootResult.reason;
				report("transport", rootResult.reason);
				return;
			}
			unavailable = null;
			transport = openTransport(rootResult.path);
			transport.sweep();
			const projectRoot = findProjectRoot(ctx.cwd);
			const peers = transport.readPeers().filter((p) => p.id !== id);
			const taken = new Set(peers.filter((p) => p.projectRoot === projectRoot).map((p) => p.callsign));
			let remembered: string | undefined;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === CALLSIGN_ENTRY) {
					const cs = (entry.data as { callsign?: unknown } | undefined)?.callsign;
					if (typeof cs === "string" && CALLSIGN_PATTERN.test(cs)) remembered = cs;
				}
			}
			const callsign = pickCallsign(taken, cfg.callsign ?? remembered);
			const now = Date.now();
			const branch = readBranch(projectRoot);
			self = {
				v: WIRE_VERSION,
				id,
				callsign,
				pid: process.pid,
				ticks: processStartTicks(process.pid),
				cwd: ctx.cwd,
				projectRoot,
				role: process.env.PI_SUBAGENT_CHILD === "1" ? "child" : "main",
				state: "idle",
				claims: [],
				recent: [],
				startedAt: now,
				heartbeatAt: now,
				...(branch ? { branch } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
			};
			if (callsign !== remembered) persistCallsign();
			publish();
			peersCache = transport.readPeers();
			teamIds = new Set(team().map((p) => p.id));
			tickCount = 0;
			const tickMs = Number(process.env.PI_TELECOM_TICK_MS) > 0 ? Number(process.env.PI_TELECOM_TICK_MS) : TICK_MS_DEFAULT;
			timer ??= setInterval(tick, tickMs);
			timer.unref?.();
			updateStatus();
		} catch (error) {
			report("start", error);
		}
	});

	pi.on("session_shutdown", () => {
		stop();
	});

	pi.on("session_info_changed", () => {
		if (self) publish();
	});

	pi.on("model_select", (event) => {
		if (!self) return;
		self.model = event.model.id;
		publish();
	});

	// ------------------------------------------------------------------ turns

	pi.on("before_agent_start", (event, ctx) => {
		ctxRef = ctx;
		if (!self) return;
		self.state = "busy";
		if (event.messageType === "user" && event.prompt.trim()) {
			self.task = clip(event.prompt.split("\n").find((l) => l.trim()) ?? event.prompt, 160);
			self.taskAt = Date.now();
		}
		publish();
		const brief = renderBrief(self, readPeers());
		if (!brief || brief.signature === lastBriefSignature) return;
		lastBriefSignature = brief.signature;
		const mates = team();
		return {
			message: {
				customType: MESSAGE_TYPES.brief,
				content: brief.text,
				display: true,
				details: {
					summary: mates.map((p) => `${p.callsign} (${p.state}${p.task ? `: ${clip(p.task, 40)}` : ""})`).join(" · "),
				} satisfies TelecomMessageDetails,
			},
		};
	});

	pi.on("agent_before_settle", (event) => {
		if (!self || event.outcome === "aborted" || !event.context.canContinue) return;
		const due = ledger.inbound().filter((a) => !a.reminded);
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

	pi.on("agent_settled", () => {
		if (!self) return;
		self.state = "idle";
		flushNotices(true);
		publish();
		updateStatus();
	});

	// ------------------------------------------------------------------ the guard

	function verdictToResult(verdict: Verdict, toolCallId: string): ToolCallEventResult | undefined {
		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "warn") {
			const prior = callNotes.get(toolCallId);
			callNotes.set(toolCallId, prior ? `${prior}\n${verdict.note}` : verdict.note);
		}
		return undefined;
	}

	pi.on("tool_call", (event, ctx) => {
		if (!self || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw.trim()) return;
		const path = canonicalPath(raw, ctx.cwd);
		const peers = readPeers();
		if (event.toolName === "write") existedBefore.set(event.toolCallId, awareness.hasView(path) || fileExists(path));
		if (team(peers).length === 0 && !peers.some((p) => p.id !== self?.id && p.recent.some((r) => r.path === path))) {
			return;
		}
		const claim = awareness.checkClaims(path, cfg.guard, peers, self.id, root());
		if (claim.action === "block") {
			if (claim.contested) {
				sendEvent(
					claim.contested.owner,
					"claim.contested",
					`${self.callsign} tried to change ${displayPath(path, root())}`,
					{ path, pattern: claim.contested.claim.pattern },
				);
			}
			return { block: true, reason: claim.reason };
		}
		verdictToResult(claim, event.toolCallId);
		const stale = awareness.checkStale(path, event.toolName, cfg.guard, peers, self.id, root());
		return verdictToResult(stale, event.toolCallId);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!self) return;
		const toolName = event.toolName;
		if (toolName !== "read" && toolName !== "edit" && toolName !== "write") return;
		const raw = (event.input as { path?: unknown }).path;
		const note = callNotes.get(event.toolCallId);
		callNotes.delete(event.toolCallId);
		const created = toolName === "write" ? existedBefore.get(event.toolCallId) === false : false;
		existedBefore.delete(event.toolCallId);
		if (typeof raw !== "string" || event.isError) return;
		const path = canonicalPath(raw, ctx.cwd);
		if (toolName === "read") {
			awareness.noteRead(path);
			return;
		}
		awareness.noteOwnWrite(path, toolName);
		announceChange(path, toolName, event, created);
		if (!note) return;
		return {
			content: [...event.content, { type: "text", text: `\n${note}` }],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});

	function announceChange(path: string, op: "edit" | "write", event: ToolResultEvent, created: boolean): void {
		if (!self || !transport) return;
		const now = Date.now();
		self.recent = [{ path, op, at: now }, ...self.recent.filter((r) => r.path !== path)].slice(0, RECENT_CAP);
		for (const claim of self.claims) {
			if (matchesClaim(path, claim.pattern, root())) claim.expiresAt = now + cfg.claimTtlMs;
		}
		publish();
		const data: FileChangedData = { path, op, ...summarize(op, event, created) };
		const text = `${self.callsign} ${op === "write" ? "wrote" : "edited"} ${displayPath(path, root())}`;
		for (const peer of team()) sendEvent(peer, "file.changed", text, data);
	}

	// ------------------------------------------------------------------ the tool

	pi.registerTool({
		name: TOOL,
		label: "Telecom",
		description: [
			"Coordinate with the other pi agents working in parallel on this machine — by default those in this project. Each agent has a callsign (alpha, bravo, …).",
			'"board": who is working here, on what, their claims and recently changed files. scope "machine" lists agents in every project.',
			'"send": message one agent (`to` = callsign, name or id prefix). It reaches them at their next step, or wakes them when idle.',
			'"ask": send a question and wait for the answer (blocks up to `timeoutSec`, default 300).',
			'"reply": answer an inbound ask by its `askId` — the asker is blocked until you do.',
			'"broadcast": tell every agent in the project something that affects them all (does not wake idle agents).',
			'"status": set the one-line task peers see for you (`message`).',
			'"claim": reserve `paths` (project-relative paths or globs; `message` = why) so peers stay out; peers editing there are held back once and you are told.',
			'"release": give back `paths`, or every claim when omitted.',
		].join("\n"),
		promptSnippet: "Coordinate with parallel pi agents: team board, message/ask/reply, broadcast, claim paths",
		promptGuidelines: [
			"Other pi agents may work in this project at the same time. When they do, a 📡 Telecom brief names them, their tasks, claims and recent changes.",
			"Before a large or multi-file change while peers are active, claim the area with telecom claim (and a reason); release it when done.",
			"When a 📡 notice says a peer changed a file you are working with, re-read that file before editing it.",
			"Answer a 📡 Ask promptly with telecom reply — the asker is blocked until you do.",
			"Message peers for real coordination only (handoffs, requests, shared-interface changes); skip acknowledgements and small talk — each message costs the recipient a turn.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("board"),
					Type.Literal("send"),
					Type.Literal("ask"),
					Type.Literal("reply"),
					Type.Literal("broadcast"),
					Type.Literal("status"),
					Type.Literal("claim"),
					Type.Literal("release"),
				],
				{ description: "What to do." },
			),
			to: Type.Optional(Type.String({ description: "send/ask: the agent's callsign, session name, or an id prefix (4+ chars)." })),
			message: Type.Optional(
				Type.String({ description: "send/ask/reply/broadcast: the text. status: your task. claim: why you need the paths." }),
			),
			askId: Type.Optional(Type.String({ description: "reply: the handle printed on the inbound ask." })),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "claim/release: project-relative paths or globs (src/auth, src/**/*.test.ts)." }),
			),
			timeoutSec: Type.Optional(Type.Number({ description: "ask: how long to wait for the answer, in seconds (default 300)." })),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("machine")], {
					description: 'board/broadcast: "project" (default) or every agent on the "machine".',
				}),
			),
		}),

		renderCall(args, theme) {
			const a = args as { action?: string; to?: string; message?: string; askId?: string; paths?: string[] };
			let text = theme.fg("toolTitle", theme.bold("telecom ")) + theme.fg("accent", a.action ?? "");
			if (a.to) text += theme.fg("muted", " → ") + theme.fg("accent", a.to);
			if (a.askId) text += theme.fg("dim", ` ${a.askId}`);
			if (a.paths?.length) text += theme.fg("muted", ` ${a.paths.join(", ")}`);
			if (a.message) text += theme.fg("dim", ` — ${clip(a.message, 70)}`);
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate) {
			if (!self || !transport) {
				return fail(
					unavailable
						? `the switchboard is unavailable: ${unavailable}`
						: "this session is not connected yet (it connects at session start)",
				);
			}
			const me = self;
			const net = transport;
			const message = params.message?.trim() ?? "";
			switch (params.action) {
				case "board": {
					const scope = params.scope ?? "project";
					return ok(boardText(scope), { callsign: me.callsign, peers: team().map((p) => p.callsign) });
				}

				case "status": {
					if (!message) return ok(`your task as peers see it: ${me.task ?? "(none)"}`);
					me.task = clip(message, 160);
					me.taskAt = Date.now();
					publish();
					return ok(`status set — peers now see ${me.callsign}: ${me.task}`);
				}

				case "send":
				case "ask": {
					if (!params.to?.trim()) return fail(`"${params.action}" needs \`to\`: a callsign from the board`);
					if (!message) return fail(`"${params.action}" needs a \`message\``);
					const target = resolveTarget(params.to, readPeers());
					if (!target.ok) return fail(target.reason);
					const peer = target.peer;
					if (params.action === "send") {
						const sent = net.deliver(envelope(peer.id, "message", message));
						if (!sent.ok) return fail(sent.reason);
						return ok(`sent to ${peer.callsign} (${stateHint(peer)})`, { to: peer.callsign });
					}
					const timeoutMs = Math.min(
						params.timeoutSec && params.timeoutSec > 0 ? params.timeoutSec * 1000 : cfg.askTimeoutMs,
						MAX_ASK_TIMEOUT_MS,
					);
					const env = envelope(peer.id, "ask", message);
					const waiting = ledger.awaitAnswer(env.id, { to: peer.id, toCallsign: peer.callsign, text: message }, timeoutMs, signal);
					const sent = net.deliver(env);
					if (!sent.ok) {
						ledger.abandon(env.id, sent.reason);
						await waiting;
						return fail(sent.reason);
					}
					onUpdate?.({
						content: [{ type: "text", text: `waiting for ${peer.callsign} (${stateHint(peer)})…` }],
						details: { waiting: peer.callsign },
					});
					const answer: AskOutcome = await waiting;
					if (answer.ok) {
						return ok(`${answer.fromCallsign} answered:\n\n${answer.text}`, { from: answer.fromCallsign, askId: env.id });
					}
					if (answer.interruptedBy) {
						const by = answer.interruptedBy;
						return ok(
							`${answer.reason}\n\n${by.fromCallsign} asks: ${by.text}\n\nReply with telecom({ action: "reply", askId: "${by.id}", message: "…" }).`,
							{ interrupted: true, askId: env.id, inboundAskId: by.id },
						);
					}
					if (answer.aborted) {
						// Nobody is waiting any more: take the question off the peer's to-do list.
						const live = readPeers().find((p) => p.id === peer.id);
						if (live) sendEvent(live, "ask.withdrawn", `${me.callsign} withdrew an ask`, { askId: env.id });
					}
					return fail(answer.reason, { askId: env.id });
				}

				case "reply": {
					if (!message) return fail('"reply" needs a `message`');
					const outstanding = ledger.inbound();
					let askId = params.askId?.trim() ?? "";
					if (!askId && outstanding.length === 1) askId = (outstanding[0] as InboundAsk).id;
					if (!askId) {
						return fail(
							outstanding.length === 0
								? "no inbound ask is waiting — use send for an ordinary message"
								: `which ask? Pass askId: ${outstanding.map((a) => `${a.id} (${a.fromCallsign})`).join(", ")}`,
						);
					}
					const ask = ledger.resolveInbound(askId);
					let to: Presence | undefined;
					if (ask) {
						to = readPeers().find((p) => p.id === ask.from);
						if (!to) return fail(`${ask.fromCallsign} is gone — their session ended before your reply`);
					} else if (params.to) {
						const target = resolveTarget(params.to, readPeers());
						if (!target.ok) return fail(target.reason);
						to = target.peer;
					} else {
						return fail(
							`no inbound ask has the handle "${askId}". ${
								outstanding.length ? `Waiting: ${outstanding.map((a) => `${a.id} (${a.fromCallsign})`).join(", ")}.` : "None is waiting."
							}`,
						);
					}
					const sent = net.deliver(envelope(to.id, "answer", message, { answerTo: askId }));
					if (!sent.ok) return fail(sent.reason);
					updateStatus();
					return ok(`replied to ${to.callsign}`, { to: to.callsign, askId });
				}

				case "broadcast": {
					if (!message) return fail('"broadcast" needs a `message`');
					const scope = params.scope ?? "project";
					const peers = readPeers().filter((p) => p.id !== me.id && (scope === "machine" || p.projectRoot === me.projectRoot));
					if (peers.length === 0) return fail(`no other agent is live ${scope === "machine" ? "on this machine" : "in this project"}`);
					const reached: string[] = [];
					const failed: string[] = [];
					for (const peer of peers) {
						const sent = net.deliver(envelope(peer.id, "broadcast", message));
						(sent.ok ? reached : failed).push(peer.callsign);
					}
					return ok(
						`broadcast to ${reached.join(", ") || "nobody"}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`,
						{ reached, failed },
					);
				}

				case "claim": {
					const patterns = (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
					if (patterns.length === 0) return fail('"claim" needs `paths` — project-relative paths or globs');
					const now = Date.now();
					const conflicts: string[] = [];
					for (const peer of team(readPeers())) {
						for (const theirs of peer.claims) {
							if (theirs.expiresAt <= now) continue;
							for (const mine of patterns) {
								if (claimsOverlap(mine, theirs.pattern, me.projectRoot)) {
									conflicts.push(`"${mine}" overlaps ${peer.callsign}'s claim "${theirs.pattern}"${theirs.note ? ` (${theirs.note})` : ""}`);
								}
							}
						}
					}
					if (conflicts.length > 0) {
						return fail(`${conflicts.join("; ")}. Agree on a split first: telecom({ action: "ask", to: "…", message: "…" }).`);
					}
					const outside = patterns.filter((p) => !absolutePattern(p, me.projectRoot).startsWith(me.projectRoot));
					if (outside.length > 0) return fail(`claims must be inside the project (${me.projectRoot}): ${outside.join(", ")}`);
					for (const pattern of patterns) {
						me.claims = me.claims.filter((c) => c.pattern !== pattern);
						me.claims.push({
							pattern,
							since: now,
							expiresAt: now + cfg.claimTtlMs,
							...(message ? { note: clip(message, 120) } : {}),
						});
					}
					publish();
					updateStatus();
					return ok(
						`claimed ${patterns.join(", ")}${message ? ` — ${clip(message, 120)}` : ""}. Peers editing there are held back and you are told. Release with telecom({ action: "release" }) when done; idle claims expire after ${Math.round(cfg.claimTtlMs / 60_000)} min.`,
						{ claims: me.claims.map((c) => c.pattern) },
					);
				}

				case "release": {
					const wanted = (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
					const releasing = wanted.length === 0 ? me.claims : me.claims.filter((c) => wanted.includes(c.pattern));
					if (releasing.length === 0) {
						return fail(
							me.claims.length === 0
								? "you hold no claims"
								: `none of those match your claims: ${me.claims.map((c) => c.pattern).join(", ")}`,
						);
					}
					const names = releasing.map((c) => c.pattern);
					me.claims = me.claims.filter((c) => !names.includes(c.pattern));
					publish();
					const notify = new Map<string, string>();
					for (const pattern of names) {
						for (const [id, callsign] of contesters.get(pattern) ?? []) notify.set(id, callsign);
						contesters.delete(pattern);
					}
					const live = readPeers();
					for (const [id] of notify) {
						const peer = live.find((p) => p.id === id);
						if (peer) sendEvent(peer, "claim.released", `${me.callsign} released ${names.join(", ")}`, { patterns: names });
					}
					updateStatus();
					return ok(
						`released ${names.join(", ")}${notify.size ? ` — told ${[...notify.values()].join(", ")}, who had been waiting` : ""}`,
						{ released: names },
					);
				}
			}
			return fail(`unknown action "${String(params.action)}"`);
		},
	});

	// ------------------------------------------------------------------ the command

	const SUBCOMMANDS = ["board", "all", "msg", "broadcast", "name", "widget", "release", "help"];

	pi.registerCommand("telecom", {
		description: "Team board for parallel pi agents · /telecom [all|msg <agent> <text>|broadcast <text>|name <callsign>|widget|release|help]",
		getArgumentCompletions(prefix) {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
			}
			if (parts[0] === "msg" && parts.length === 2) {
				return team()
					.map((p) => p.callsign)
					.filter((c) => c.startsWith(parts[1] ?? ""))
					.map((c) => ({ value: `msg ${c} `, label: c }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [sub = "board", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const say = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
			if (!self || !transport) {
				say(cfg.disabled ? "telecom is disabled (PI_TELECOM_DISABLE)" : `telecom is not connected${unavailable ? `: ${unavailable}` : ""}`, "warning");
				return;
			}
			const me = self;
			const net = transport;
			switch (sub) {
				case "board":
				case "all":
					say(boardText(sub === "all" ? "machine" : "project"));
					return;
				case "widget":
					widgetOn = !widgetOn;
					if (!widgetOn) ctx.ui.setWidget("telecom", undefined);
					updateStatus();
					say(`live board ${widgetOn ? "on" : "off"}`);
					return;
				case "name": {
					const wanted = rest[0]?.toLowerCase();
					if (!wanted || !CALLSIGN_PATTERN.test(wanted)) {
						say(`usage: /telecom name <callsign> — lowercase letters, digits, - or _ (e.g. ${NATO.slice(0, 3).join(", ")})`, "warning");
						return;
					}
					if (team(readPeers()).some((p) => p.callsign === wanted)) {
						say(`${wanted} is taken in this project`, "warning");
						return;
					}
					me.callsign = wanted;
					persistCallsign();
					publish();
					lastBriefSignature = "";
					updateStatus();
					say(`you are now ${wanted}`);
					return;
				}
				case "msg":
				case "say": {
					const [to, ...words] = rest;
					const text = words.join(" ").trim();
					if (!to || !text) {
						say("usage: /telecom msg <agent> <text>", "warning");
						return;
					}
					const target = resolveTarget(to, readPeers());
					if (!target.ok) {
						say(target.reason, "warning");
						return;
					}
					const sent = net.deliver(envelope(target.peer.id, "message", text, { human: true }));
					say(sent.ok ? `sent to ${target.peer.callsign} (${stateHint(target.peer)})` : sent.reason, sent.ok ? "info" : "error");
					return;
				}
				case "broadcast": {
					const text = rest.join(" ").trim();
					const peers = team(readPeers());
					if (!text || peers.length === 0) {
						say(!text ? "usage: /telecom broadcast <text>" : "no other agent is live in this project", "warning");
						return;
					}
					for (const peer of peers) net.deliver(envelope(peer.id, "broadcast", text, { human: true }));
					say(`broadcast to ${peers.map((p) => p.callsign).join(", ")}`);
					return;
				}
				case "release": {
					const count = me.claims.length;
					me.claims = [];
					publish();
					updateStatus();
					say(count ? `released ${plural(count, "claim")}` : "no claims to release");
					return;
				}
				default:
					say(
						[
							"/telecom                    team board for this project",
							"/telecom all                every agent on this machine",
							"/telecom msg <agent> <text> message an agent as its human (wakes it when idle)",
							"/telecom broadcast <text>   tell every agent in this project",
							"/telecom name <callsign>    rename this agent",
							"/telecom widget             toggle a live board above the editor",
							"/telecom release            drop every claim this agent holds",
							`guard: ${cfg.guard} (PI_TELECOM_GUARD) · last heartbeat ${ago(lastHeartbeat)}`,
						].join("\n"),
					);
			}
		},
	});
}

function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Summarize an own change for peers: what kind, where, and a few changed lines. */
function summarize(
	op: "edit" | "write",
	event: ToolResultEvent,
	created: boolean,
): Pick<FileChangedData, "summary" | "excerpt" | "created"> {
	const input = event.input as { edits?: unknown; oldText?: unknown; content?: unknown };
	if (op === "write") {
		const lines = typeof input.content === "string" ? input.content.split("\n").length : 0;
		return { summary: `${created ? "created" : "rewrote"} it${lines ? ` (${plural(lines, "line")})` : ""}`, created };
	}
	const count = Array.isArray(input.edits) ? input.edits.length : typeof input.oldText === "string" ? 1 : 0;
	const details = event.details as { patch?: unknown; firstChangedLine?: unknown } | undefined;
	const line = typeof details?.firstChangedLine === "number" ? ` from line ${details.firstChangedLine}` : "";
	const excerpt: string[] = [];
	if (typeof details?.patch === "string") {
		for (const l of details.patch.split("\n")) {
			if ((l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---") && l.trim().length > 1) {
				excerpt.push(clip(l, 100));
				if (excerpt.length >= 4) break;
			}
		}
	}
	return { summary: `${plural(Math.max(count, 1), "edit")}${line}`, ...(excerpt.length ? { excerpt } : {}) };
}
