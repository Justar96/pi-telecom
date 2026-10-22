/**
 * pi-telecom — parallel pi agents in one project, working as a team.
 *
 * Every pi session that loads this extension joins a machine-local switchboard (see
 * `transport.ts`). Sessions working in one repository form a team — in the same checkout, or in
 * sibling git worktrees (each checkout is a LANE; see `project.ts`) — and each member gets:
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
 * pi-subagents children join as FAMILY (see `family.ts`): named after their parent (`alpha-1`),
 * listed under it, folded into it in briefs, and never held back by their parent's claims.
 *
 * Messaging is derived from @tinoy/pi-ipc (MIT, github.com/tinoy1336/pi-extensions); the team
 * layer — projects, callsigns, briefs, change notices, claims and the guard — is new.
 */
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Awareness, type Contest, type PeerChange, UNRESPONSIVE_MS, type Verdict } from "./awareness.ts";
import { type BriefState, renderBoard, renderBrief } from "./board.ts";
import { CALLSIGN_PATTERN, childCallsign, mustYield, NATO, pickCallsign } from "./callsign.ts";
import { MAX_ASK_TIMEOUT_MS, readConfig, type TelecomConfig } from "./config.ts";
import { blockedOnMe, detectLineage, isForegroundChild, lineOf, parentOf } from "./family.ts";
import { absolutePattern, claimMatcher, claimsOverlap, laneRelativePattern, matchesClaim } from "./glob.ts";
import { type AskOutcome, closesCycle, createAskLedger, type InboundAsk, WAITS_CAP, waitedOn } from "./ledger.ts";
import { type PendingNotice, renderNotice, summarizeOwnChange } from "./notices.ts";
import { canonicalPath, displayPath, findProjectRoot, findRepo, inCheckout, isWithin, laneName, readBranch, sameRepo } from "./project.ts";
import { MESSAGE_TYPES, registerRenderers, type TelecomMessageDetails } from "./render.ts";
import { fail, ok, TOOL_SPEC, type ToolAction, type ToolParams, type ToolResult } from "./tool.ts";
import {
	type Claim,
	type Envelope,
	type FileChangedData,
	openTransport,
	parseEvent,
	type Presence,
	processStartTicks,
	type TelecomEvent,
	type Transport,
	transportRoot,
	WIRE_VERSION,
} from "./transport.ts";
import { ago, clip, fileExists, idMatches, messageOf, newId, plural, setBounded, shortId } from "./util.ts";

const CALLSIGN_ENTRY = "telecom-callsign";
/** Own recent changes published in the presence record. */
const RECENT_CAP = 12;
/** Peer changes arriving within this window are folded into one notice. */
const NOTICE_COALESCE_MS = 1_200;
const HEARTBEAT_MS = 15_000;
/** The team is re-read every this many ticks; the inbox is drained on every tick. */
const TEAM_REFRESH_TICKS = 2;
/** Joins and leaves seen in the first ticks are the team as it was at startup, not news. */
const STARTUP_TICKS = 2;
/** A partial id shorter than this is too likely to match by accident. */
const MIN_ID_PREFIX = 4;
/** `PI_TELECOM_MAX_WAKES` counts wake-ups over this rolling window. */
const WAKE_WINDOW_MS = 60_000;
/** Own task and claim notes as peers see them. */
const TASK_CAP = 160;
const CLAIM_NOTE_CAP = 120;
/** Per-call bookkeeping kept between tool_call and tool_result; bounded in case a result never comes. */
const CALL_MAP_CAP = 256;
/** Envelope ids already handled, so an at-least-once redelivery is not handled twice. */
const SEEN_CAP = 2_048;
/** Sessions this agent has talked with directly; they stay relevant in its briefs. */
const CONTACTS_CAP = 256;
/** A reload handoff older than this belongs to a runtime that did not come back. */
const HANDOFF_MAX_AGE_MS = 5 * 60_000;

/** What a runtime parks for its replacement on `/reload`. */
interface Handoff {
	pid: number;
	at: number;
	callsign: string;
	startedAt: number;
	claims: Claim[];
	task?: string;
	taskAt?: number;
	inboundAsks: Array<{ id: string; from: string; fromCallsign: string; text: string; at: number }>;
	contesters: Array<[string, Array<[string, string]>]>;
	/** Asks whose answer now arrives late: it must still wake the replacement runtime. */
	abandonedAsks?: Array<[string, { toCallsign: string; text: string }]>;
}

/** What the guard learns at `tool_call` and needs again at the matching `tool_result`. */
interface CallState {
	/** Warnings to append to the tool's result. */
	note?: string;
	/** For `write`: whether the file existed before, so peers hear "created" vs "rewrote". */
	existedBefore?: boolean;
	/** The peer change a warned (stale) edit was applied over. */
	staleOver?: PeerChange;
	/** Lane notes shown with this call: spent only if it succeeds. */
	laneNotes?: string[];
	/** A claim in another checkout this call edits inside: its owner is told only if it succeeds. */
	laneContest?: Contest;
}

type InjectMode = "wake" | "passive" | "wake-always" | "later";
type MessageDetails = TelecomMessageDetails & Record<string, unknown>;
/** `via`: how a target found by path was picked ("claims …", "changed … ago"), for the result. */
type Target = { ok: true; peer: Presence; via?: string } | { ok: false; reason: string };

/** One `telecom` tool call, with the session state it acts on already checked present. */
interface ActionCall {
	me: Presence;
	net: Transport;
	params: ToolParams;
	/** `params.message`, trimmed. */
	message: string;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback | undefined;
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
	/** The team as of the last refresh, with each member's role (subagents come and go quietly). */
	let teamIds = new Map<string, Presence["role"]>();
	let briefState: BriefState | null = null;
	let widgetOn = false;
	let unavailable: string | null = null;

	const awareness = new Awareness();
	const ledger = createAskLedger();
	const wakeTimes: number[] = [];
	const notices = new Map<string, PendingNotice>();
	let noticeSince = 0;
	const calls = new Map<string, CallState>();
	/** Who was held back by each of our claims (pattern → peer id → callsign), so a release can tell them. */
	const contesters = new Map<string, Map<string, string>>();
	const seen = new Map<string, true>();
	const contacts = new Map<string, true>();
	const reported = new Set<string>();

	registerRenderers(pi);

	/**
	 * Every hook is registered through this. pi treats a throwing `tool_call` handler as a veto —
	 * it blocks the tool — so a telecom bug must never escape as an exception: it is reported once
	 * and the hook gives no opinion. The guard therefore fails OPEN: telecom is a teammate, not a
	 * security boundary, and a bug in it must not stop anyone's work.
	 */
	const on = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
		pi.on(event as never, ((ev: unknown, ctx: ExtensionContext) => {
			try {
				const out = handler(ev, ctx);
				return out instanceof Promise
					? out.catch((error: unknown) => {
							report(event, error);
							return undefined;
						})
					: out;
			} catch (error) {
				report(event, error);
				return undefined;
			}
		}) as never)) as ExtensionAPI["on"];

	// ------------------------------------------------------------------ helpers

	/** The UI, when this mode has one (the TUI or an RPC client); print and JSON modes get null. */
	function ui(): ExtensionUIContext | null {
		return ctxRef?.hasUI ? ctxRef.ui : null;
	}

	/** Tell the human. Best effort: a UI that throws must not take telecom down with it. */
	function notifyUser(text: string, level: "info" | "warning" = "info"): void {
		try {
			ui()?.notify(text, level);
		} catch {
			/* no UI */
		}
	}

	function root(): string {
		return self?.projectRoot ?? "";
	}

	/** Diagnostics never reach the model; they surface in the UI once per distinct problem. */
	function report(where: string, error: unknown): void {
		const text = `telecom ${where}: ${messageOf(error)}`;
		if (reported.has(text)) return;
		reported.add(text);
		notifyUser(text, "warning");
	}

	function publish(): void {
		if (!transport || !self) return;
		self.heartbeatAt = Date.now();
		const name = pi.getSessionName();
		if (name) self.name = name;
		else delete self.name;
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

	/** Live peers in this repository (this checkout or a sibling worktree), this session excluded. */
	function team(peers: readonly Presence[] = peersCache): Presence[] {
		return peers.filter((p) => self && p.id !== self.id && sameRepo(p, self));
	}

	/** A fresh callsign: the parent's, numbered, for a subagent whose parent is live; else a word. */
	function freshCallsign(peers: readonly Presence[], taken: ReadonlySet<string>): string {
		const parent = self ? parentOf(self, peers) : undefined;
		return parent ? childCallsign(parent.callsign, taken) : pickCallsign(taken);
	}

	/** Remember a peer this agent talked with: its work stays relevant in this agent's briefs. */
	function noteContact(id: string): void {
		setBounded(contacts, id, true, CONTACTS_CAP);
	}

	/** Publish whom this agent is blocked on, so peers can tell a wait cycle from a mere queue. */
	function publishWaits(): void {
		if (!self) return;
		const waits = ledger.waits();
		self.waitingOn = waits.on.slice(0, WAITS_CAP);
		if (waits.since !== undefined) self.waitingSince = waits.since;
		else delete self.waitingSince;
		publish();
	}

	function allowWake(): boolean {
		const now = Date.now();
		while (wakeTimes.length > 0 && now - (wakeTimes[0] as number) > WAKE_WINDOW_MS) wakeTimes.shift();
		if (wakeTimes.length >= cfg.maxWakesPerMinute) return false;
		wakeTimes.push(now);
		return true;
	}

	/**
	 * Put a telecom message in front of the model. `wake` starts a turn when idle (steers it in
	 * when busy) within the wake limit; `wake-always` ignores the limit (a peer is blocked);
	 * `passive` steers it in when busy and appends it silently when idle.
	 */
	function inject(customType: string, content: string, details: MessageDetails, mode: InjectMode): void {
		const wake = mode === "wake-always" || (mode === "wake" && allowWake());
		const note = mode === "wake" && !wake ? `\n\n${wakeLimitNote()}` : "";
		try {
			pi.sendMessage(
				{ customType, content: content + note, display: true, details },
				// `later`: held until this agent's next run starts, never steered into the current one.
				wake ? { triggerTurn: true } : mode === "later" ? { deliverAs: "nextTurn" } : undefined,
			);
		} catch (error) {
			report("deliver", error);
		}
	}

	function wakeLimitNote(): string {
		return cfg.maxWakesPerMinute === 0
			? "(telecom: peer wake-ups are off in this session (PI_TELECOM_MAX_WAKES=0), so this arrived without starting a turn.)"
			: `(telecom: more than ${cfg.maxWakesPerMinute} peer messages woke you in the last minute, so this one arrived without starting a turn.)`;
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

	function sendEvent(to: Presence, event: TelecomEvent, text: string): void {
		if (!transport) return;
		const sent = transport.deliver(envelope(to.id, "event", text, { topic: event.topic, data: event.data }));
		if (!sent.ok) report("event", sent.reason);
	}

	function updateStatus(): void {
		const u = ui();
		if (!u || !self) return;
		try {
			// Rebuilt on every refresh, so a theme change shows up within a second.
			const fg = (color: "accent" | "dim" | "warning", text: string) => (u.theme ? u.theme.fg(color, text) : text);
			const mates = team();
			const asks = ledger.inbound().length;
			const peers = mates.filter((p) => p.role !== "child");
			const subagents = mates.length - peers.length;
			const busy = peers.filter((p) => p.state === "busy").length;
			const parts = [fg("accent", `📡 ${self.callsign}`)];
			const who = peers.length === 0 ? "solo" : `${plural(peers.length, "peer")}${busy ? ` (${busy} busy)` : ""}`;
			parts.push(fg("dim", subagents > 0 ? `${who} + ${plural(subagents, "subagent")}` : who));
			if (self.claims.length > 0) parts.push(fg("dim", plural(self.claims.length, "claim")));
			if (asks > 0) parts.push(fg("warning", `${plural(asks, "ask")} waiting`));
			u.setStatus("telecom", parts.join(fg("dim", " · ")));
			if (widgetOn) u.setWidget("telecom", boardText("project").split("\n"));
		} catch {
			/* UI not available in this mode */
		}
	}

	function boardText(scope: "project" | "machine"): string {
		if (!self) return "telecom is not connected in this session.";
		return renderBoard({ self, peers: readPeers(), scope, inboundAsks: ledger.inbound() });
	}

	function claimTtlMinutes(): number {
		return Math.round(cfg.claimTtlMs / 60_000);
	}

	// ------------------------------------------------------------------ addressing

	/**
	 * Is anything at `patterns` (written in the sender's checkout) part of this agent's work: a file
	 * it is working with or changed, or one of its claims?
	 */
	function concernsMe(patterns: readonly string[], senderId: string): boolean {
		if (!self) return false;
		const sender = peersCache.find((p) => p.id === senderId);
		const lane = sender !== undefined && sender.projectRoot !== self.projectRoot;
		const work = [...awareness.focusPaths(), ...self.recent.map((r) => r.path)];
		for (const raw of patterns) {
			const pattern = lane ? laneRelativePattern(raw, sender.projectRoot) : raw;
			if (pattern === null) continue;
			if (self.claims.some((c) => claimsOverlap(c.pattern, pattern, self?.projectRoot ?? ""))) return true;
			const inside = claimMatcher(pattern, self.projectRoot);
			if (work.some(inside)) return true;
		}
		return false;
	}

	/**
	 * The agent to reach about `patterns`: whoever claims them (in this checkout first), else
	 * whoever changed a file there most recently. Refused, with the choices, when several claim.
	 */
	function ownerOf(patterns: readonly string[], action: string, peers: readonly Presence[]): Target {
		if (!self) return { ok: false, reason: "telecom is not running" };
		const me = self;
		const now = Date.now();
		const claimants: Array<{ peer: Presence; pattern: string; lane: boolean }> = [];
		for (const peer of team(peers)) {
			const lane = peer.projectRoot !== me.projectRoot;
			const claim = peer.claims.find((c) => {
				if (c.expiresAt <= now) return false;
				const pattern = lane ? laneRelativePattern(c.pattern, peer.projectRoot) : c.pattern;
				return pattern !== null && patterns.some((p) => claimsOverlap(p, pattern, me.projectRoot));
			});
			if (claim) claimants.push({ peer, pattern: claim.pattern, lane });
		}
		const local = claimants.filter((c) => !c.lane);
		const pool = local.length > 0 ? local : claimants;
		const only = pool[0];
		if (pool.length === 1 && only) {
			return { ok: true, peer: only.peer, via: `claims "${only.pattern}"${only.lane ? ` in ${laneName(only.peer)}` : ""}` };
		}
		if (pool.length > 1) {
			return {
				ok: false,
				reason: `${patterns.join(", ")} spans the claims of ${pool.map((c) => `${c.peer.callsign} ("${c.pattern}")`).join(", ")}. Pick one: telecom({ action: "${action}", to: "${pool[0]?.peer.callsign}", message: "…" }).`,
			};
		}
		const inside = patterns.map((p) => claimMatcher(p, me.projectRoot));
		let latest: { peer: Presence; path: string; at: number } | null = null;
		for (const peer of team(peers)) {
			for (const r of peer.recent) {
				const mine = inCheckout(r.path, peer.projectRoot, me.projectRoot);
				if (mine && inside.some((match) => match(mine)) && (!latest || r.at > latest.at)) latest = { peer, path: mine, at: r.at };
			}
		}
		if (latest) {
			return { ok: true, peer: latest.peer, via: `changed ${displayPath(latest.path, me.projectRoot)} ${ago(latest.at)}` };
		}
		return {
			ok: false,
			reason: `no other agent claims or recently changed ${patterns.join(", ")}. telecom({ action: "board" }) shows who works on what; telecom({ action: "broadcast", paths: [${patterns.map((p) => JSON.stringify(p)).join(", ")}], message: "…" }) reaches whoever works there.`,
		};
	}

	/**
	 * Who `raw` names, most specific match first: a callsign in this project, a callsign anywhere,
	 * a session name, a full id, then part of an id (its start, or the short form the board shows).
	 * An ambiguous match is refused with the choices.
	 */
	function resolveTarget(raw: string, peers: readonly Presence[]): Target {
		const to = raw.trim().replace(/^@/, "");
		const lower = to.toLowerCase();
		const others = peers.filter((p) => p.id !== self?.id);
		const sameProject = others.filter((p) => self !== null && sameRepo(p, self));
		const pick = (list: Presence[], what: string): Target | null => {
			if (list.length === 1) return { ok: true, peer: list[0] as Presence };
			if (list.length > 1) {
				return {
					ok: false,
					reason: `"${to}" is the ${what} of ${list.length} sessions — use an id: ${list.map((p) => `${shortId(p.id)} (${p.callsign} in ${p.projectRoot})`).join(", ")}`,
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
			pick(others.filter((p) => idMatches(p.id, to, MIN_ID_PREFIX)), "id") ?? {
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
		if (Date.now() - peer.heartbeatAt > UNRESPONSIVE_MS) {
			return `unresponsive since ${ago(peer.heartbeatAt)} — it waits in their inbox until they are back`;
		}
		if (peer.state === "busy") {
			if (peer.waitingOn?.length) {
				const on = peer.waitingOn.map((id) => (id === self?.id ? "you" : (peersCache.find((p) => p.id === id)?.callsign ?? shortId(id))));
				if (on.includes("you")) return `busy waiting on your answer — an ask from you reaches it now (a wait cycle), anything else after you answer`;
				return `busy waiting on ${on.join(", ")}${peer.waitingSince ? ` (asked ${ago(peer.waitingSince)})` : ""} — it reads this when that wait ends`;
			}
			// A session waiting on a foreground subagent is inside one long tool call: nothing
			// reaches its model until that subagent's run ends.
			if (self && blockedOnMe(self, peer, peersCache)) return "busy waiting for your run to end — it reads this after you finish";
			const child = peersCache.find((c) => c.state === "busy" && isForegroundChild(c, peer));
			if (child) return `busy waiting on its subagent ${child.callsign} — it reads this when that run ends`;
			return "busy — it reaches them before their next step";
		}
		return "idle — this wakes them";
	}

	// ------------------------------------------------------------------ inbound

	function handleEnvelope(env: Envelope): void {
		const from = env.fromCallsign;
		const human = env.human ? " (from their human)" : "";
		const base: MessageDetails = { from: env.from, fromCallsign: from, id: env.id };
		if (env.kind === "message" || env.kind === "ask" || env.kind === "answer") noteContact(env.from);
		switch (env.kind) {
			case "message":
				inject(
					MESSAGE_TYPES.message,
					`**📡 Message from ${from}${human}**\n\n${env.text}\n\n(Reply only if it needs one: telecom({ action: "send", to: "${from}", message: "…" }).)`,
					{ ...base, tone: "accent" },
					"wake",
				);
				return;
			case "broadcast": {
				// A broadcast about paths away from this agent's work waits for its next run instead
				// of breaking into the current one.
				const about = env.paths?.length ? ` — about ${env.paths.map((p) => clip(p, 80)).join(", ")}` : "";
				const near = !env.paths?.length || concernsMe(env.paths, env.from);
				inject(MESSAGE_TYPES.broadcast, `**📡 Broadcast from ${from}${human}${about}**\n\n${env.text}`, base, near ? "passive" : "later");
				return;
			}
			case "ask": {
				const ask: Omit<InboundAsk, "reminded"> = {
					id: env.id,
					from: env.from,
					fromCallsign: from,
					text: env.text,
					at: env.ts,
				};
				ledger.noteInbound(ask);
				// Stop waiting only when this ask closes a cycle (we, directly or through others,
				// wait on the asker): then nobody on it could ever answer. Any other ask waits
				// until our own wait ends. Unknown graph (an older peer on the way): interrupt.
				if (self && ledger.outboundCount() > 0 && closesCycle(env.from, { ...self, waitingOn: ledger.waits().on }, readPeers()) !== false) {
					ledger.interruptAll({ ...ask, reminded: false });
				}
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
		const event = parseEvent(env);
		if (!event) return;
		const peer = { from: env.from, fromCallsign: env.fromCallsign };
		switch (event.topic) {
			case "file.changed":
				queueNotice(env, event.data);
				return;
			case "claim.contested": {
				const { path, pattern } = event.data;
				if (event.data.lane) {
					// Nothing was held back (their checkout is separate), so there is no one to tell
					// on release: this is news about the merge ahead.
					const sender = peersCache.find((p) => p.id === env.from);
					inject(
						MESSAGE_TYPES.claim,
						`**📡 ${env.fromCallsign} changed a path you claimed, in another checkout**\n\n${env.fromCallsign} edited ${displayPath(path, sender?.projectRoot ?? root())} in ${sender ? laneName(sender) : "another checkout of this repository"}, inside your claim "${pattern}". Nothing was held back, since your checkouts are separate, but the two changes meet when the branches merge. If they may conflict, agree on one owner: telecom({ action: "send", to: "${env.fromCallsign}", message: "…" }).`,
						{ ...peer, tone: "warning" },
						"passive",
					);
					return;
				}
				const waiting = contesters.get(pattern) ?? new Map<string, string>();
				waiting.set(env.from, env.fromCallsign);
				contesters.set(pattern, waiting);
				inject(
					MESSAGE_TYPES.claim,
					`**📡 ${env.fromCallsign} needs a path you claimed**\n\n${env.fromCallsign} tried to change ${displayPath(path, root())}, inside your claim "${pattern}". They were asked to check with you first. If you no longer need the whole area, narrow or release it: telecom({ action: "release", paths: ["${pattern}"] }).`,
					{ ...peer, tone: "warning" },
					"passive",
				);
				return;
			}
			case "ask.withdrawn": {
				const { askId } = event.data;
				if (!ledger.resolveInbound(askId)) return;
				inject(
					MESSAGE_TYPES.reply,
					`**📡 ${env.fromCallsign} withdrew their ask** (${askId})\n\nNo reply is needed any more.`,
					peer,
					"passive",
				);
				updateStatus();
				return;
			}
			case "claim.released": {
				const patterns = event.data.patterns.join(", ");
				inject(
					MESSAGE_TYPES.claim,
					`**📡 ${env.fromCallsign} released ${patterns || "their claim"}**\n\nYou can work there now.`,
					peer,
					"passive",
				);
				return;
			}
		}
	}

	/** Note a peer's change, and queue a notice when this agent works with the file. */
	function queueNotice(env: Envelope, data: FileChangedData): void {
		if (!self) return;
		const change: PeerChange = {
			peerId: env.from,
			callsign: env.fromCallsign,
			path: data.path,
			op: data.op,
			at: env.ts,
			...(data.summary ? { summary: data.summary } : {}),
		};
		// A sender that joined since the last team refresh is not cached yet: look again before
		// telling its own copy of a file from this agent's. Gone already: go by where the path lies.
		const sender = peersCache.find((p) => p.id === env.from) ?? readPeers().find((p) => p.id === env.from);
		const mine = !sender
			? isWithin(data.path, self.projectRoot)
				? data.path
				: null
			: sender.projectRoot !== self.projectRoot && sameRepo(sender, self)
				? inCheckout(data.path, sender.projectRoot, self.projectRoot)
				: data.path;
		// `mine === data.path` from another lane: the peer reached into this checkout (nested in
		// its own) and changed this agent's very file, so it is an ordinary peer change below.
		if (mine !== data.path) {
			// A peer in another worktree changed ITS copy: this agent's file did not move, so it is
			// not a peer change here (the guard must not see one), only news about the merge.
			if (!sender || !mine || !awareness.noteLaneChange(env.from, mine)) return;
			if (notices.size === 0) noticeSince = Date.now();
			notices.set(`${env.from}\u0000${mine}`, {
				change: { ...change, path: mine },
				count: 1,
				relation: "lane",
				lane: laneName(sender),
				...(data.excerpt ? { excerpt: data.excerpt } : {}),
			});
			return;
		}
		const { relation, firstNotice } = awareness.notePeerChange(change);
		const claim = self.claims.find((c) => matchesClaim(data.path, c.pattern, root()));
		if (!claim && !(relation && firstNotice)) return;
		const key = `${env.from}\u0000${data.path}`;
		if (notices.size === 0) noticeSince = Date.now();
		notices.set(key, {
			change,
			count: (notices.get(key)?.count ?? 0) + 1,
			relation: claim ? "claimed" : (relation ?? "read"),
			...(claim ? { claim: claim.pattern } : {}),
			...(data.excerpt ? { excerpt: data.excerpt } : {}),
		});
	}

	/** Send the queued notices, one message per peer, once the coalescing window has passed. */
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
			const { content, summary } = renderNotice(callsign, list, root());
			inject(MESSAGE_TYPES.change, content, { fromCallsign: callsign, tone: "warning", summary }, "passive");
		}
	}

	// ------------------------------------------------------------------ the loop

	/**
	 * pi invalidates an extension's API when it disposes the session (every `pi.*` call throws
	 * from then on). A host that disposes without `session_shutdown` — or stops waiting for it, as
	 * pi-subagents does with a finished child after a timeout — would otherwise leave this timer
	 * heartbeating a dead session for as long as the process lives.
	 */
	function runtimeDisposed(): boolean {
		try {
			pi.getSessionName();
			return false;
		} catch {
			return true;
		}
	}

	function tick(): void {
		if (!transport || !self) return;
		if (runtimeDisposed()) {
			stop();
			return;
		}
		tickCount++;
		// A throw from a timer is an uncaught exception, and the process it would take down may be
		// the parent's pi or a runner hosting other subagents. Each step is caught on its own: a
		// step that keeps failing (an unreadable inbox) must not stop the heartbeat, without which
		// peers stop honoring this agent's claims, or the ask timeouts, without which an ask hangs.
		step("inbound", () => {
			const drained = transport?.drain(self?.id ?? "", (env) => {
				if (seen.has(env.id)) return;
				setBounded(seen, env.id, true, SEEN_CAP);
				handleEnvelope(env);
			});
			for (const failure of drained?.failed ?? []) report("inbound", failure);
		});
		if (!self) return; // handling may have backed this session off
		if (tickCount % TEAM_REFRESH_TICKS === 0) step("team", refreshTeam);
		step("notices", () => flushNotices());
		step("asks", () => ledger.expire(Date.now()));
		if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) step("heartbeat", heartbeat);
	}

	function step(where: string, run: () => void): void {
		try {
			run();
		} catch (error) {
			report(where, error);
		}
	}

	function refreshTeam(): void {
		if (!self) return;
		const peers = readPeers();
		const mine = peers.find((p) => p.id === self?.id);
		if (mine && mine.pid !== process.pid) {
			// This same session is open in another live pi process (`pi -c` in two terminals). Two
			// writers of one record and two readers of one inbox would garble both, so the younger
			// process steps back and the older keeps the line.
			const theirsOlder = mine.startedAt < self.startedAt || (mine.startedAt === self.startedAt && mine.pid < process.pid);
			if (theirsOlder) {
				backOff(`this session is also open in pi process ${mine.pid}, which keeps the telecom line`);
				return;
			}
			publish();
		} else if (!mine) {
			// Our record vanished (a sweep raced a rewrite, or the runtime dir was cleaned): restore it.
			publish();
		}
		const live = new Set(peers.map((p) => p.id));
		ledger.failPeerGone((id) => !live.has(id));
		const gone = new Set([...teamIds.keys()].filter((id) => !live.has(id)));
		if (gone.size > 0) ledger.dropInboundFrom(gone);
		if (mustYield(self, peers)) {
			const old = self.callsign;
			yieldCallsign(peers);
			notifyUser(`📡 callsign ${old} was taken; you are now ${self.callsign}`);
		}
		const mates = team(peers);
		const ids = new Map(mates.map((p) => [p.id, p.role]));
		// Subagents come and go with every delegation; their arrivals are not news for the human.
		const joined = mates.filter((p) => !teamIds.has(p.id) && p.role !== "child");
		const left = [...teamIds].filter(([id, role]) => !ids.has(id) && role !== "child");
		if (tickCount > STARTUP_TICKS && (joined.length > 0 || left.length > 0)) {
			const parts: string[] = [];
			if (joined.length) parts.push(`${joined.map((p) => p.callsign).join(", ")} joined`);
			if (left.length) parts.push(`${plural(left.length, "agent")} left`);
			notifyUser(`📡 ${parts.join("; ")}`);
		}
		teamIds = ids;
		updateStatus();
	}

	/** Converge on unique callsigns: the younger of two sessions with the same word moves. */
	function yieldCallsign(peers: readonly Presence[]): void {
		if (!self) return;
		self.callsign = freshCallsign(peers, new Set(team(peers).map((p) => p.callsign)));
		persistCallsign();
		publish();
	}

	function heartbeat(): void {
		if (!self || !transport) return;
		const now = Date.now();
		const before = self.claims.length;
		self.claims = self.claims.filter((c) => c.expiresAt > now);
		const expired = before - self.claims.length;
		if (expired > 0) {
			inject(
				MESSAGE_TYPES.claim,
				`**📡 ${plural(expired, "claim")} expired**\n\nNo activity inside ${expired === 1 ? "it" : "them"} for ${claimTtlMinutes()} minutes, so peers may work there now. Claim again if you still need it.`,
				{},
				"passive",
			);
		}
		const branch = readBranch(self.projectRoot);
		if (branch) self.branch = branch;
		else delete self.branch;
		publish();
		try {
			transport.sweep();
		} catch (error) {
			report("sweep", error);
		}
	}

	/** Leave the switchboard without touching the records, which belong to someone else now. */
	function backOff(reason: string): void {
		if (timer) clearInterval(timer);
		timer = null;
		self = null;
		unavailable = reason;
		try {
			ui()?.setStatus("telecom", "📡 off (session open elsewhere)");
		} catch {
			/* no UI */
		}
		notifyUser(`📡 telecom: ${reason}`, "warning");
	}

	function parkForReload(): void {
		if (!transport || !self) return;
		const state: Handoff = {
			pid: process.pid,
			at: Date.now(),
			callsign: self.callsign,
			startedAt: self.startedAt,
			claims: self.claims,
			...(self.task ? { task: self.task } : {}),
			...(self.taskAt ? { taskAt: self.taskAt } : {}),
			inboundAsks: ledger.inbound().map(({ id, from, fromCallsign, text, at }) => ({ id, from, fromCallsign, text, at })),
			contesters: [...contesters].map(([pattern, who]) => [pattern, [...who]]),
			abandonedAsks: ledger.lateCandidates(),
		};
		transport.writeHandoff(self.id, state);
	}

	/** The state a previous runtime of this session parked — only from this process, and only if fresh. */
	function takeReloadHandoff(id: string): Handoff | null {
		if (!transport) return null;
		const raw = transport.takeHandoff(id) as Partial<Handoff> | null;
		if (!raw || raw.pid !== process.pid || typeof raw.at !== "number" || Date.now() - raw.at > HANDOFF_MAX_AGE_MS) {
			return null;
		}
		return raw as Handoff;
	}

	function persistCallsign(): void {
		if (!self) return;
		try {
			pi.appendEntry(CALLSIGN_ENTRY, { callsign: self.callsign });
		} catch {
			/* not persisted; a resume will just pick a fresh word */
		}
	}

	/** The callsign this session last used on its active branch, if any. */
	function rememberedCallsign(ctx: ExtensionContext): string | undefined {
		let remembered: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CALLSIGN_ENTRY) continue;
			const cs = (entry.data as { callsign?: unknown } | undefined)?.callsign;
			if (typeof cs === "string" && CALLSIGN_PATTERN.test(cs)) remembered = cs;
		}
		return remembered;
	}

	// ------------------------------------------------------------------ session lifecycle

	function stop(keepLine = false): void {
		if (timer) clearInterval(timer);
		timer = null;
		if (keepLine) {
			// A reload: the replacement runtime takes over this record and inbox within moments, so
			// peers never see this agent leave and nothing sent meanwhile is lost.
			parkForReload();
			self = null;
			return;
		}
		if (transport && self) {
			try {
				// Leaving frees every claim; whoever was held back by one should not wait for a
				// release that will never come. Subagents leave all the time, so this matters.
				tellReleased(self, self.claims.map((c) => c.pattern));
				transport.removePresence(self.id);
				transport.removeInbox(self.id);
			} catch {
				/* the sweep of whoever is left will clean up */
			}
		}
		self = null;
		try {
			ui()?.setStatus("telecom", undefined);
			ui()?.setWidget("telecom", undefined);
		} catch {
			/* no UI */
		}
	}

	on("session_start", (_event, ctx) => {
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
			const repo = findRepo(projectRoot);
			const peers = transport.readPeers().filter((p) => p.id !== id);
			const lineage = detectLineage({
				env: process.env,
				// Optional call: a host without session headers simply has no foreground children.
				parentSessionFile: ctx.sessionManager.getHeader?.()?.parentSession,
				peers,
				pid: process.pid,
				selfId: id,
			});
			const taken = new Set(peers.filter((p) => sameRepo(p, { projectRoot, repo })).map((p) => p.callsign));
			const remembered = rememberedCallsign(ctx);
			const handoff = takeReloadHandoff(id);
			const parent = lineage.parent ? peers.find((p) => p.id === lineage.parent) : undefined;
			// A subagent inherits its parent's environment, PI_TELECOM_CALLSIGN included: that name
			// is the parent's, so a child is named after its parent instead.
			// A child forked from its parent's context also inherits the parent's remembered callsign,
			// which the parent holds: then it is named after the parent too, not given a free word.
			const wanted =
				lineage.role === "child"
					? ((remembered && !taken.has(remembered) ? remembered : undefined) ??
						(parent ? childCallsign(parent.callsign, taken) : undefined))
					: (cfg.callsign ?? remembered);
			const callsign = pickCallsign(taken, handoff?.callsign ?? wanted);
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
				repo,
				role: lineage.role,
				...(lineage.parent ? { parent: lineage.parent } : {}),
				waitingOn: [],
				state: "idle",
				claims: handoff?.claims ?? [],
				recent: [],
				// A reloaded runtime keeps its seniority, so it never loses its callsign to a newcomer.
				startedAt: handoff?.startedAt ?? now,
				heartbeatAt: now,
				...(branch ? { branch } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				...(handoff?.task ? { task: handoff.task } : {}),
				...(handoff?.taskAt ? { taskAt: handoff.taskAt } : {}),
			};
			for (const ask of handoff?.inboundAsks ?? []) ledger.noteInbound(ask);
			if (Array.isArray(handoff?.abandonedAsks)) ledger.restoreAbandoned(handoff.abandonedAsks);
			for (const [pattern, who] of handoff?.contesters ?? []) contesters.set(pattern, new Map(who));
			if (callsign !== remembered) persistCallsign();
			publish();
			peersCache = transport.readPeers();
			// Two sessions starting in the same instant can both pick the same free word. Settle it
			// now, before the first prompt, rather than on the first tick.
			if (mustYield(self, peersCache)) yieldCallsign(peersCache);
			teamIds = new Map(team().map((p) => [p.id, p.role]));
			tickCount = 0;
			timer ??= setInterval(tick, cfg.tickMs);
			timer.unref?.();
			updateStatus();
		} catch (error) {
			report("start", error);
		}
	});

	on("session_shutdown", (event) => {
		stop(event?.reason === "reload");
	});

	on("session_compact", () => {
		awareness.markCompacted();
		// The summary may have dropped the team picture: the next prompt gets a full brief.
		if (briefState) briefState = { ...briefState, fullAt: 0 };
	});

	on("session_info_changed", () => {
		if (self) publish();
	});

	on("model_select", (event) => {
		if (!self) return;
		self.model = event.model.id;
		publish();
	});

	// ------------------------------------------------------------------ turns

	on("before_agent_start", (event, ctx) => {
		ctxRef = ctx;
		if (!self) return;
		self.state = "busy";
		if (event.messageType === "user" && event.prompt.trim()) {
			self.task = clip(event.prompt.split("\n").find((l) => l.trim()) ?? event.prompt, TASK_CAP);
			self.taskAt = Date.now();
		}
		publish();
		const brief = renderBrief(self, readPeers(), briefState, {
			paths: awareness.focusPaths(),
			contacts: new Set(contacts.keys()),
		});
		briefState = brief.state;
		if (!brief.text) return;
		return {
			message: {
				customType: MESSAGE_TYPES.brief,
				content: brief.text,
				display: true,
				details: { summary: brief.summary } satisfies TelecomMessageDetails,
			},
		};
	});

	on("agent_before_settle", (event) => {
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

	on("agent_settled", () => {
		if (!self) return;
		self.state = "idle";
		flushNotices(true);
		publish();
		updateStatus();
	});

	// ------------------------------------------------------------------ the guard

	function noteCall(toolCallId: string, update: (state: CallState) => void): void {
		const state = calls.get(toolCallId) ?? {};
		update(state);
		setBounded(calls, toolCallId, state, CALL_MAP_CAP);
	}

	function verdictToResult(verdict: Verdict, toolCallId: string): ToolCallEventResult | undefined {
		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "warn") {
			noteCall(toolCallId, (state) => {
				state.note = state.note ? `${state.note}\n${verdict.note}` : verdict.note;
				if (verdict.staleChange) state.staleOver = verdict.staleChange;
				if (verdict.laneNotes) state.laneNotes = [...(state.laneNotes ?? []), ...verdict.laneNotes];
				if (verdict.contested?.lane) state.laneContest = verdict.contested;
			});
		}
		return undefined;
	}

	on("tool_call", (event, ctx) => {
		if (!self || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw.trim()) return;
		const path = canonicalPath(raw, ctx.cwd);
		const peers = readPeers();
		if (event.toolName === "write") {
			const existed = awareness.hasView(path) || fileExists(path);
			noteCall(event.toolCallId, (state) => {
				state.existedBefore = existed;
			});
		}
		// Solo work pays nothing: with no teammate, no peer history for this path and no stale view
		// of it, there is nothing to check.
		if (
			team(peers).length === 0 &&
			!awareness.hasPeerContext(path) &&
			!peers.some((p) => p.id !== self?.id && p.recent.some((r) => r.path === path))
		) {
			return;
		}
		const claim = awareness.checkClaims(path, cfg.guard, peers, self, lineOf(self, peers));
		if (claim.action === "block") {
			// Held back in this checkout: the owner hears that someone needs the path. (A claim in
			// another checkout never holds anyone back; its owner hears once the edit has landed.)
			if (claim.contested) {
				sendEvent(
					claim.contested.owner,
					{ topic: "claim.contested", data: { path, pattern: claim.contested.claim.pattern } },
					`${self.callsign} tried to change ${displayPath(path, root())}`,
				);
			}
			return { block: true, reason: claim.reason };
		}
		verdictToResult(claim, event.toolCallId);
		const stale = awareness.checkStale(path, event.toolName, cfg.guard, peers, self.id, root());
		const blocked = verdictToResult(stale, event.toolCallId);
		if (blocked) return blocked;
		if (cfg.guard !== "off") verdictToResult(awareness.checkLanes(path, peers, self), event.toolCallId);
		return undefined;
	});

	on("tool_result", (event, ctx) => {
		if (!self) return;
		const toolName = event.toolName;
		if (toolName !== "read" && toolName !== "edit" && toolName !== "write") return;
		const state = calls.get(event.toolCallId) ?? {};
		calls.delete(event.toolCallId);
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || event.isError) return;
		const path = canonicalPath(raw, ctx.cwd);
		if (toolName === "read") {
			awareness.noteRead(path);
			return;
		}
		awareness.noteOwnWrite(path, toolName, state.staleOver);
		announceChange(path, toolName, event, toolName === "write" && state.existedBefore === false);
		// The edit landed: spend the one-time lane notes it showed, and tell a lane claim's owner.
		if (state.laneNotes) awareness.commitLaneNotes(state.laneNotes);
		if (state.laneContest) {
			const { owner, claim } = state.laneContest;
			awareness.noteContested(owner.id, path);
			sendEvent(
				owner,
				{ topic: "claim.contested", data: { path, pattern: claim.pattern, lane: true } },
				`${self.callsign} changed ${displayPath(path, root())}`,
			);
		}
		if (!state.note) return;
		// Append to the current result only; earlier messages are never rewritten (cache rule).
		return {
			content: [...event.content, { type: "text", text: `\n${state.note}` }],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});

	function announceChange(path: string, op: "edit" | "write", event: ToolResultEvent, created: boolean): void {
		if (!self || !transport) return;
		const now = Date.now();
		self.recent = [{ path, op, at: now }, ...self.recent.filter((r) => r.path !== path)].slice(0, RECENT_CAP);
		// Working inside a claim keeps it alive.
		for (const claim of self.claims) {
			if (matchesClaim(path, claim.pattern, root())) claim.expiresAt = now + cfg.claimTtlMs;
		}
		publish();
		const data: FileChangedData = { path, op, ...summarizeOwnChange(op, event, created) };
		const text = `${self.callsign} ${op === "write" ? "wrote" : "edited"} ${displayPath(path, root())}`;
		for (const peer of team()) sendEvent(peer, { topic: "file.changed", data }, text);
	}

	// ------------------------------------------------------------------ actions shared by the tool and the command

	/** Drop `patterns` from this agent's claims and tell every peer that was held back by them. */
	function releaseClaims(me: Presence, patterns: readonly string[]): string[] {
		me.claims = me.claims.filter((c) => !patterns.includes(c.pattern));
		publish();
		const told = tellReleased(me, patterns);
		updateStatus();
		return told;
	}

	/** Tell the peers held back by `patterns` that they are free; returns their callsigns. */
	function tellReleased(me: Presence, patterns: readonly string[]): string[] {
		if (patterns.length === 0) return [];
		const waiting = new Map<string, string>();
		for (const pattern of patterns) {
			for (const [id, callsign] of contesters.get(pattern) ?? []) waiting.set(id, callsign);
			contesters.delete(pattern);
		}
		const live = readPeers();
		for (const id of waiting.keys()) {
			const peer = live.find((p) => p.id === id);
			if (peer) {
				sendEvent(
					peer,
					{ topic: "claim.released", data: { patterns: [...patterns] } },
					`${me.callsign} released ${patterns.join(", ")}`,
				);
			}
		}
		return [...waiting.values()];
	}

	function broadcastTo(
		net: Transport,
		peers: readonly Presence[],
		text: string,
		extra: Partial<Envelope> = {},
	): { reached: string[]; failed: string[] } {
		const reached: string[] = [];
		const failed: string[] = [];
		for (const peer of peers) {
			const sent = net.deliver(envelope(peer.id, "broadcast", text, extra));
			(sent.ok ? reached : failed).push(peer.callsign);
		}
		return { reached, failed };
	}

	function listAsks(asks: readonly InboundAsk[]): string {
		return asks.map((a) => `${a.id} (${a.fromCallsign})`).join(", ");
	}

	// ------------------------------------------------------------------ the tool

	function boardAction({ me, params }: ActionCall): ToolResult {
		return ok(boardText(params.scope ?? "project"), { callsign: me.callsign, peers: team().map((p) => p.callsign) });
	}

	function statusAction({ me, message }: ActionCall): ToolResult {
		if (!message) return ok(`your task as peers see it: ${me.task ?? "(none)"}`);
		me.task = clip(message, TASK_CAP);
		me.taskAt = Date.now();
		publish();
		return ok(`status set — peers now see ${me.callsign}: ${me.task}`);
	}

	/** The checks `send` and `ask` share: a target (`to`, or whoever owns `paths`) and a message. */
	function messageTarget({ params, message }: ActionCall): Target {
		const paths = (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
		if (!params.to?.trim() && paths.length === 0) {
			return { ok: false, reason: `"${params.action}" needs \`to\` (a callsign from the board), or \`paths\` to reach whoever claims or last changed them` };
		}
		if (!message) return { ok: false, reason: `"${params.action}" needs a \`message\`` };
		const peers = readPeers();
		return params.to?.trim() ? resolveTarget(params.to, peers) : ownerOf(paths, params.action, peers);
	}

	/** "bravo", or `bravo, which claims "src/db/**"` for a target found by path. */
	function targetName(target: Target & { ok: true }): string {
		return target.via ? `${target.peer.callsign}, which ${target.via}` : target.peer.callsign;
	}

	function sendAction(call: ActionCall): ToolResult {
		const target = messageTarget(call);
		if (!target.ok) return fail(target.reason);
		const sent = call.net.deliver(envelope(target.peer.id, "message", call.message));
		if (!sent.ok) return fail(sent.reason);
		noteContact(target.peer.id);
		return ok(`sent to ${targetName(target)} (${stateHint(target.peer)})`, { to: target.peer.callsign });
	}

	async function askAction(call: ActionCall): Promise<ToolResult> {
		const target = messageTarget(call);
		if (!target.ok) return fail(target.reason);
		const { me, net, params, message, signal, onUpdate } = call;
		const peer = target.peer;
		const peers = readPeers();
		if (blockedOnMe(me, peer, peers)) {
			// The parent (or a foreground ancestor further up) is inside its `subagent` tool call,
			// waiting for this very run: an ask could only reach it after this run ends, so waiting
			// for the answer would deadlock.
			const parent = parentOf(me, peers);
			const who = parent?.id === peer.id ? "your parent session" : "above you in a chain of foreground subagents";
			return fail(
				`${peer.callsign} is ${who}, and it is blocked waiting for your run to end, so it cannot read an ask until you finish. Decide yourself and state the assumption in your final answer, or end your run with the question. If you have pi-subagents' contact_supervisor tool, it reaches ${parent?.callsign ?? "your parent"} mid-run: contact_supervisor({ reason: "need_decision", message: "…" }).`,
			);
		}
		// A peer inside a foreground subagent run reads nothing until that run ends. If the run
		// waits, through any chain of asks, on this agent, the ask would close a cycle that only
		// this agent can break, by answering what waits on it.
		const running = peers.find((c) => c.state === "busy" && isForegroundChild(c, peer));
		if (running) {
			const asking = { ...me, waitingOn: [...new Set([...ledger.waits().on, peer.id])] };
			const graph = peers.map((p) => (p.id === me.id ? asking : p));
			if (closesCycle(me.id, peer, graph) === true) {
				// The asks waiting on this agent from sessions on the cycle come first: answering
				// one of those is what unblocks the run.
				const cycle = waitedOn(peer, graph);
				const owed = ledger.inbound().sort((x, y) => Number(cycle.has(y.from)) - Number(cycle.has(x.from)));
				const first = owed[0];
				return fail(
					`${peer.callsign} is inside its subagent ${running.callsign}'s run, which is waiting, directly or through others, on you, so ${peer.callsign} cannot read an ask until you unblock it: waiting for an answer would deadlock. ${
						first
							? `Answer what waits on you first: telecom({ action: "reply", askId: "${first.id}", message: "…" })${owed.length > 1 ? ` (all waiting: ${listAsks(owed)})` : ""}. Or decide yourself.`
							: `Decide yourself, or leave the question for later: telecom({ action: "send", to: "${peer.callsign}", message: "…" }).`
					}`,
				);
			}
		}
		const requested = params.timeoutSec && params.timeoutSec > 0 ? params.timeoutSec * 1000 : cfg.askTimeoutMs;
		const timeoutMs = Math.min(requested, MAX_ASK_TIMEOUT_MS);
		const env = envelope(peer.id, "ask", message);
		// Wait before delivering, so an answer that arrives at once has an ask to settle.
		const waiting = ledger.awaitAnswer(env.id, { to: peer.id, toCallsign: peer.callsign, text: message }, timeoutMs, signal);
		// Published before the ask is delivered, so the peer sees the wait when the ask arrives.
		publishWaits();
		const sent = net.deliver(env);
		if (!sent.ok) {
			ledger.abandon(env.id, sent.reason);
			await waiting;
			publishWaits();
			return fail(sent.reason);
		}
		noteContact(peer.id);
		onUpdate?.({
			content: [{ type: "text", text: `waiting for ${targetName(target)} (${stateHint(peer)})…` }],
			details: { waiting: peer.callsign },
		});
		const answer: AskOutcome = await waiting;
		publishWaits();
		if (answer.ok) {
			const asked = target.via ? `${answer.fromCallsign} (it ${target.via}) answered` : `${answer.fromCallsign} answered`;
			return ok(`${asked}:\n\n${answer.text}`, { from: answer.fromCallsign, askId: env.id });
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
			if (live) sendEvent(live, { topic: "ask.withdrawn", data: { askId: env.id } }, `${me.callsign} withdrew an ask`);
		}
		return fail(answer.reason, { askId: env.id });
	}

	function replyAction({ net, params, message }: ActionCall): ToolResult {
		if (!message) return fail('"reply" needs a `message`');
		const outstanding = ledger.inbound();
		let askId = params.askId?.trim() ?? "";
		if (!askId && outstanding.length === 1) askId = (outstanding[0] as InboundAsk).id;
		if (!askId) {
			return fail(
				outstanding.length === 0
					? "no inbound ask is waiting — use send for an ordinary message"
					: `which ask? Pass askId: ${listAsks(outstanding)}`,
			);
		}
		const ask = ledger.resolveInbound(askId);
		let to: Presence | undefined;
		if (ask) {
			to = readPeers().find((p) => p.id === ask.from);
			if (!to) return fail(`${ask.fromCallsign} is gone — their session ended before your reply`);
		} else if (params.to) {
			// An answer to an ask this session no longer tracks (it was reloaded, or it expired).
			const target = resolveTarget(params.to, readPeers());
			if (!target.ok) return fail(target.reason);
			to = target.peer;
		} else {
			return fail(
				`no inbound ask has the handle "${askId}". ${
					outstanding.length ? `Waiting: ${listAsks(outstanding)}.` : "None is waiting."
				}`,
			);
		}
		const sent = net.deliver(envelope(to.id, "answer", message, { answerTo: askId }));
		if (!sent.ok) return fail(sent.reason);
		noteContact(to.id);
		updateStatus();
		return ok(`replied to ${to.callsign}`, { to: to.callsign, askId });
	}

	function broadcastAction({ me, net, params, message }: ActionCall): ToolResult {
		if (!message) return fail('"broadcast" needs a `message`');
		const scope = params.scope ?? "project";
		const peers = readPeers().filter((p) => p.id !== me.id && (scope === "machine" || sameRepo(p, me)));
		if (peers.length === 0) return fail(`no other agent is live ${scope === "machine" ? "on this machine" : "in this project"}`);
		const paths = (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
		const { reached, failed } = broadcastTo(net, peers, message, paths.length > 0 ? { paths } : {});
		const about = paths.length > 0 ? ` — about ${paths.join(", ")}: agents working there get it now, the rest at their next prompt` : "";
		return ok(
			`broadcast to ${reached.join(", ") || "nobody"}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}${about}`,
			{ reached, failed },
		);
	}

	/**
	 * Peers' claims that overlap `patterns`: in this checkout they conflict; in another lane they
	 * are only worth a note (the files are separate until the merge). This agent's lineal family
	 * never conflicts: a subagent may claim part of its parent's claim, and the other way round.
	 */
	function claimConflicts(me: Presence, patterns: readonly string[], now: number): { conflicts: string[]; lanes: string[] } {
		const conflicts: string[] = [];
		const lanes: string[] = [];
		const peers = readPeers();
		const family = lineOf(me, peers);
		for (const peer of team(peers)) {
			if (family.has(peer.id)) continue;
			const otherLane = peer.projectRoot !== me.projectRoot;
			for (const theirs of peer.claims) {
				if (theirs.expiresAt <= now) continue;
				const pattern = otherLane ? laneRelativePattern(theirs.pattern, peer.projectRoot) : theirs.pattern;
				if (pattern === null) continue;
				for (const mine of patterns) {
					if (!claimsOverlap(mine, pattern, me.projectRoot)) continue;
					const what = `"${mine}" overlaps ${peer.callsign}'s claim "${theirs.pattern}"${theirs.note ? ` (${theirs.note})` : ""}`;
					if (otherLane) lanes.push(`${what} in ${laneName(peer)}`);
					else conflicts.push(what);
				}
			}
		}
		return { conflicts, lanes };
	}

	function claimAction({ me, params, message }: ActionCall): ToolResult {
		const patterns = (params.paths ?? []).map((p) => p.trim()).filter(Boolean);
		if (patterns.length === 0) return fail('"claim" needs `paths` — project-relative paths or globs');
		const now = Date.now();
		const { conflicts, lanes } = claimConflicts(me, patterns, now);
		if (conflicts.length > 0) {
			return fail(`${conflicts.join("; ")}. Agree on a split first: telecom({ action: "ask", to: "…", message: "…" }).`);
		}
		const outside = patterns.filter((p) => !absolutePattern(p, me.projectRoot).startsWith(me.projectRoot));
		if (outside.length > 0) return fail(`claims must be inside the project (${me.projectRoot}): ${outside.join(", ")}`);
		// Stored without closing punctuation (a clip "…" stays): it is quoted mid-sentence elsewhere.
		const note = message ? clip(message, CLAIM_NOTE_CAP).replace(/[\s.!?]+$/, "") : "";
		for (const pattern of patterns) {
			me.claims = me.claims.filter((c) => c.pattern !== pattern);
			me.claims.push({ pattern, since: now, expiresAt: now + cfg.claimTtlMs, ...(note ? { note } : {}) });
		}
		publish();
		updateStatus();
		const overlap =
			lanes.length > 0
				? ` Note: ${lanes.join("; ")}. Your checkouts are separate, so both claims stand, but the work meets when the branches merge; agree on one owner if it may conflict.`
				: "";
		return ok(
			`claimed ${patterns.join(", ")}${note ? ` — ${note}` : ""}. Peers editing there are held back and you are told. Release with telecom({ action: "release" }) when done; idle claims expire after ${claimTtlMinutes()} min.${overlap}`,
			{ claims: me.claims.map((c) => c.pattern), ...(lanes.length > 0 ? { laneOverlaps: lanes.length } : {}) },
		);
	}

	function releaseAction({ me, params }: ActionCall): ToolResult {
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
		const told = releaseClaims(me, names);
		return ok(
			`released ${names.join(", ")}${told.length ? ` — told ${told.join(", ")}, who had been waiting` : ""}`,
			{ released: names },
		);
	}

	const actions: Record<ToolAction, (call: ActionCall) => ToolResult | Promise<ToolResult>> = {
		board: boardAction,
		status: statusAction,
		send: sendAction,
		ask: askAction,
		reply: replyAction,
		broadcast: broadcastAction,
		claim: claimAction,
		release: releaseAction,
	};

	pi.registerTool({
		...TOOL_SPEC,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!self || !transport) {
				return fail(
					unavailable
						? `the switchboard is unavailable: ${unavailable}`
						: "this session is not connected yet (it connects at session start)",
				);
			}
			// Schema validation should rule this out, but a model can still send anything.
			if (!Object.hasOwn(actions, params.action)) return fail(`unknown action "${String(params.action)}"`);
			const message = params.message?.trim() ?? "";
			return actions[params.action]({ me: self, net: transport, params, message, signal, onUpdate });
		},
	});

	// ------------------------------------------------------------------ the command

	const SUBCOMMANDS = ["board", "all", "msg", "broadcast", "name", "widget", "release", "help"];
	const HELP = [
		"/telecom                    team board for this project",
		"/telecom all                every agent on this machine",
		"/telecom msg <agent> <text> message an agent as its human (wakes it when idle)",
		"/telecom broadcast <text>   tell every agent in this project",
		"/telecom name <callsign>    rename this agent",
		"/telecom widget             toggle a live board above the editor",
		"/telecom release            drop every claim this agent holds",
	].join("\n");

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
					// Peers' briefs say who we are; ours should restate the team under the new name.
					if (briefState) briefState = { ...briefState, fullAt: 0 };
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
					const { reached, failed } = broadcastTo(net, peers, text, { human: true });
					say(
						`broadcast to ${reached.join(", ") || "nobody"}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`,
						failed.length ? "warning" : "info",
					);
					return;
				}
				case "release": {
					const names = me.claims.map((c) => c.pattern);
					if (names.length === 0) {
						say("no claims to release");
						return;
					}
					const told = releaseClaims(me, names);
					say(`released ${plural(names.length, "claim")}${told.length ? ` — told ${told.join(", ")}` : ""}`);
					return;
				}
				default:
					say(`${HELP}\nguard: ${cfg.guard} (PI_TELECOM_GUARD) · last heartbeat ${ago(lastHeartbeat)}`);
			}
		},
	});
}
