/**
 * runtime — one session runtime's state, and the operations every part of telecom shares on it:
 * publishing this agent's record, reading the team, delivering envelopes, putting messages in
 * front of the model, reporting problems, and the human's footer and widget.
 *
 * pi creates a runtime per session (and a new one on `/reload`), and the tests run many in one
 * process, so all state lives on this object, made by the extension factory (AGENTS.md, rule 5).
 * The parts that act on it — the lifecycle and its loop, inbound handling, the guard, the turn
 * hooks, the tool and the command — each take it as their first argument.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Awareness } from "./awareness.ts";
import { type BoardScope, type BriefState, renderBoard, renderBrief } from "./board.ts";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { readConfig, type TelecomConfig } from "./config.ts";
import { isResource, sameResource } from "./glob.ts";
import { createAskLedger, type HeldMessage, WAITS_CAP } from "./ledger.ts";
import { type LogEntry, type LogKind, TeamLog } from "./log.ts";
import { type PlaceCache, sameRepo } from "./project.ts";
import { MESSAGE_TYPES, type Paint, PLAIN, type TelecomMessageDetails } from "./render.ts";
import {
	byStart,
	type Envelope,
	isLive,
	type Presence,
	type Step,
	type TelecomEvent,
	type Transport,
	settleDepartures,
	WIRE_VERSION,
} from "./transport.ts";
import { ago, clip, messageOf, newId, plural, setBounded } from "./util.ts";
import { type BoardPanel, offStatus, statusText, type TeamSnapshot, TeamWidget, widgetLines } from "./view.ts";

/** What the human and the model hear while this session is turned off. */
export const OFF_TEXT = "telecom is off in this session. Run /telecom on to reconnect.";
const CALLSIGN_ENTRY = "telecom-callsign";
const ENABLED_ENTRY = "telecom-enabled";
/** RPC clients get the widget as plain lines of at most this many columns. */
const PLAIN_WIDGET_COLUMNS = 100;
/** Consecutive failed presence writes before the human is warned; one is a passing file lock. */
const PRESENCE_FAILURES_REPORTED = 3;
/** `PI_TELECOM_MAX_WAKES` counts wake-ups over this rolling window. */
const WAKE_WINDOW_MS = 60_000;
/** Own task and claim notes as peers see them. */
export const TASK_CAP = 160;
/** Sessions this agent has talked with directly; they stay relevant in its briefs. */
const CONTACTS_CAP = 256;
/**
 * A tool call that has run this long is published as this agent's `step`, so a sender learns that
 * a message waits for the call to end. Shorter calls are not: publishing each would rewrite the
 * record on every step, and "before their next step" is then true anyway.
 */
export const STEP_PUBLISH_AFTER_MS = 15_000;
/** Tool calls tracked at once; bounded in case a call's end never comes. */
const RUNNING_CAP = 64;
/** Sessions whose latest callsign is remembered (`seenAs`); bounded, since records are peer input. */
const SEEN_AS_CAP = 256;
/**
 * A wake-up (a message that started a run while this agent was idle) is re-sent when no model turn
 * answered it this many heartbeats after it, then after the next, and so on: about 1, 5 and 15
 * minutes. A run can end before the model sees what started it (a compaction at the start of the
 * run did, once), and nothing else would ever start one: the sender waits, and whoever waits on the
 * sender waits too. In one team that stalled every agent for twelve hours.
 */
const WAKE_RETRY_BEATS = [4, 20, 60];
/** Wake-ups one reminder repeats, and characters of each. */
const UNREAD_CAP = 4;
const UNREAD_TEXT_CAP = 4_000;
/**
 * Broadcasts held for this agent's next run (`later`), and how old one may be to be shown in full.
 * An agent can be idle for hours: an older one is cut to a line, as what was news when it was sent
 * may have moved on since (one team's were read 14 hours late), and the log has the history.
 */
const LATER_CAP = 12;
const LATER_FRESH_MS = 30 * 60_000;
const LATER_LINE_CAP = 160;

/**
 * How a message reaches the model (AGENTS.md, "Delivery to the model"). `wake` starts a turn when
 * idle (steers it in when busy) within the wake limit; `wake-always` ignores the limit, for asks
 * and explicit human tasks; `passive` steers it in when busy and appends it silently when idle;
 * `later` holds it for this agent's next run.
 */
export type InjectMode = "wake" | "passive" | "wake-always" | "later";
export type MessageDetails = TelecomMessageDetails & Record<string, unknown>;

export class Runtime {
	readonly pi: ExtensionAPI;
	cfg: TelecomConfig = readConfig();
	/** The human's choice (or the environment's): off means no connection until `/telecom on`. */
	enabled = !this.cfg.disabled;
	transport: Transport | null = null;
	/** This agent's presence record while connected; null while it is not. */
	self: Presence | null = null;
	ctx: ExtensionContext | null = null;
	/** Why the switchboard could not be reached, for the human and the tool's refusal. */
	unavailable: string | null = null;
	lastHeartbeat = 0;
	/** Consecutive failed writes of our record; the loop writes it again while this is not 0. */
	presenceFailures = 0;
	/** The live records as of the last read (`readPeers`), this session's included. Fresh, but a
	 *  record missing from one read may be back on the next: who is in the team is `present`. */
	peers: Presence[] = [];
	/**
	 * The team as the last team refresh settled it, this session included: records missing from
	 * that read for the first time are kept (`settleDepartures`). Briefs, the footer and widget, and
	 * the line for a lock go by this (or by `presentNow`), so a one-read miss is never told as a
	 * leave and then, a second later, as a join.
	 */
	present: Presence[] = [];
	/**
	 * Each session's callsign as the latest read of any kind saw it. A peer can rename and leave
	 * between two team refreshes (a board read sees the new name, no refresh does): the human is
	 * told it left by the name they last saw, not the one it had at the refresh before.
	 */
	readonly seenAs = new Map<string, string>();
	/** The sessions the last refresh found missing but still counts in `present`. */
	private departing = new Set<string>();
	briefState: BriefState | null = null;
	/** The current task was set on purpose, so only a new direction from a prompt replaces it. */
	taskExplicit = false;
	readonly awareness = new Awareness();
	readonly ledger = createAskLedger();
	/** This session's part of the team log, and the reader of everyone's (`log.ts`). */
	readonly log = new TeamLog();
	/** Sessions this agent has talked with directly, and when last: they stay relevant in its
	 *  briefs, and a broadcast from one in the last while is about its work (`inbound.ts`). */
	readonly contacts = new Map<string, number>();
	/** Who was held back by each of our claims (pattern → peer id → callsign), so a release can tell them. */
	readonly contesters = new Map<string, Map<string, string>>();
	/** The open `/telecom` panel (TUI only), redrawn on every team refresh like the widget. */
	panel: { tui: TUI; component: BoardPanel } | null = null;
	/** The live widget (TUI only), while it is shown. */
	private widget: { tui: TUI; component: TeamWidget } | null = null;
	private widgetOn = false;
	/** Where peers' files lie, for the plain widget an RPC client gets: redrawn every refresh. */
	private readonly widgetPlaces: PlaceCache = new Map();
	/** The footer text last set (see `showStatus`). */
	private shownStatus: string | undefined;
	private readonly wakeTimes: number[] = [];
	private readonly reported = new Set<string>();
	/** Tool calls running now (call id → tool, start), kept locally until one runs long (`publishStep`). */
	private readonly running = new Map<string, Step>();
	/** The call whose step our published record shows, if any. */
	private stepCall: string | null = null;
	/** `later` messages, held here (not in pi's queue) so they can be cut to a line when old. */
	private later: { at: number; head: string; body: string; content: string }[] = [];
	/** `later` messages dropped past `LATER_CAP`, oldest first. */
	private laterDropped = 0;
	/** Wake-ups no model turn has answered yet, and how often they were re-sent (`checkWakes`). */
	private unread: {
		items: Array<{ at: number; content: string; from?: string }>;
		tries: number;
		nextAt: number;
		/** A compaction came after them: the context may no longer hold their text. */
		compacted: boolean;
		reported: boolean;
	} | null = null;

	/**
	 * Every hook is registered through this. pi treats a throwing `tool_call` handler as a veto —
	 * it blocks the tool — so a telecom bug must never escape as an exception: it is reported once
	 * and the hook gives no opinion. The guard therefore fails OPEN: telecom is a teammate, not a
	 * security boundary, and a bug in it must not stop anyone's work.
	 */
	readonly on: ExtensionAPI["on"];

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.on = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			pi.on(event as never, ((ev: unknown, ctx: ExtensionContext) => {
				try {
					const out = handler(ev, ctx);
					return out instanceof Promise
						? out.catch((error: unknown) => {
								this.report(event, error);
								return undefined;
							})
						: out;
				} catch (error) {
					this.report(event, error);
					return undefined;
				}
			}) as never)) as ExtensionAPI["on"];
	}

	// ------------------------------------------------------------------ diagnostics

	/** Diagnostics never reach the model; they surface in the UI once per distinct problem. */
	report(where: string, error: unknown): void {
		const text = `telecom ${where}: ${messageOf(error)}`;
		if (this.reported.has(text)) return;
		this.reported.add(text);
		this.notifyUser(text, "warning");
	}

	/** Run one step of a larger job; a throw is reported, and the job goes on. */
	step(where: string, run: () => void): void {
		try {
			run();
		} catch (error) {
			this.report(where, error);
		}
	}

	// ------------------------------------------------------------------ presence and the team

	/** The checkout this agent started in; "" while it is not connected. */
	root(): string {
		return this.self?.projectRoot ?? "";
	}

	publish(): void {
		if (!this.transport || !this.self) return;
		this.self.heartbeatAt = Date.now();
		const name = this.pi.getSessionName();
		if (name) this.self.name = name;
		else delete this.self.name;
		const owed = this.ledger.inbound().length;
		if (owed > 0) this.self.asksOwed = owed;
		else delete this.self.asksOwed;
		const written = this.transport.writePresence(this.self);
		// One failed write leaves the previous record in place, and the next tick writes again (a
		// claim or a release must not wait for the heartbeat to reach peers), so only a write that
		// keeps failing is worth a warning.
		this.presenceFailures = written.ok ? 0 : this.presenceFailures + 1;
		if (!written.ok && this.presenceFailures >= PRESENCE_FAILURES_REPORTED) this.report("presence", written.reason);
		this.lastHeartbeat = Date.now();
	}

	/** Read every live record on the switchboard; on a failed read, the last one read. */
	readPeers(): Presence[] {
		if (!this.transport) return [];
		try {
			this.peers = this.transport.readPeers();
			for (const p of this.peers) if (this.seenAs.get(p.id) !== p.callsign) setBounded(this.seenAs, p.id, p.callsign, SEEN_AS_CAP);
		} catch (error) {
			this.report("peers", error);
		}
		return this.peers;
	}

	/**
	 * Settle a read against the team of the last refresh (`present`): a record missing for the first
	 * time stays, one missing twice in a row, or whose process is dead, or that left on purpose
	 * (`Transport.markLeft`), is gone. With `commit` (the team refresh) the result becomes `present`;
	 * without it, only sessions seen for the first time are added to it.
	 */
	settleTeam(read: readonly Presence[], commit: boolean): Presence[] {
		const selfId = this.self?.id;
		const known = new Map(this.present.filter((p) => p.id !== selfId).map((p) => [p.id, p]));
		const settled = settleDepartures(
			known,
			read.filter((p) => p.id !== selfId),
			this.departing,
			(record) => isLive(record) && !(this.transport?.hasLeft(record.id) ?? false),
		);
		const present = settled.departing.size === 0 ? [...read] : [...read, ...settled.departing.values()].sort(byStart);
		if (commit) {
			this.present = present;
			this.departing = new Set(settled.departing.keys());
		} else {
			// A session first seen now has joined, whatever the next refresh reads: a brief may tell
			// the model so before that refresh, and a miss on the read after must not then be a leave.
			const seen = new Set(this.present.map((p) => p.id));
			const joined = read.filter((p) => !seen.has(p.id));
			if (joined.length > 0) this.present = [...this.present, ...joined].sort(byStart);
		}
		return present;
	}

	/** Start the team over from `read`: this session joined, or left (`[]`). */
	resetTeam(read: readonly Presence[]): void {
		this.present = [...read];
		this.departing = new Set();
	}

	/**
	 * The team as of now: `read` (a fresh read by default) settled against the last refresh's team,
	 * which only the refresh updates (bar newcomers, see `settleTeam`). For what must be both current
	 * and debounced: a brief, the line for a lock.
	 */
	presentNow(read: readonly Presence[] = this.readPeers()): Presence[] {
		return this.settleTeam(read, false);
	}

	/** Live peers in this repository (this checkout or a sibling worktree), this session excluded. */
	team(peers: readonly Presence[] = this.peers): Presence[] {
		const me = this.self;
		return me ? peers.filter((p) => p.id !== me.id && sameRepo(p, me)) : [];
	}

	/** The task peers see for this agent. */
	setTask(me: Presence, text: string, explicit: boolean): void {
		const before = me.task;
		me.task = clip(text, TASK_CAP);
		if (me.task !== before) this.logEntry("task", `task: ${me.task}`);
		me.taskAt = Date.now();
		this.taskExplicit = explicit;
	}

	/** Publish whom this agent is blocked on, so peers can tell a wait cycle from a mere queue. */
	publishWaits(): void {
		if (!this.self) return;
		const waits = this.ledger.waits();
		this.self.waitingOn = waits.on.slice(0, WAITS_CAP);
		if (waits.since !== undefined) this.self.waitingSince = waits.since;
		else delete this.self.waitingSince;
		this.publish();
	}

	/** Mark this agent busy or idle; `stateSince` says since when, for peers' hints and boards. */
	setState(me: Presence, state: Presence["state"]): void {
		if (me.state !== state || me.stateSince === undefined) me.stateSince = Date.now();
		me.state = state;
		if (state === "idle") this.endSteps();
	}

	/** A tool call started. Only noted: the tick publishes it once it runs long (`publishStep`). */
	noteStepStart(callId: string, tool: string): void {
		setBounded(this.running, callId, { tool, since: Date.now() }, RUNNING_CAP);
	}

	/** A tool call ended. The record is written again only if it showed this call. */
	noteStepEnd(callId: string): void {
		if (!this.running.delete(callId) || this.stepCall !== callId) return;
		this.stepCall = null;
		if (this.self) delete this.self.step;
		// Another call still running long takes its place in the same write.
		if (!this.publishStep()) this.publish();
	}

	/**
	 * From the tick: publish the oldest call still running once it has run `STEP_PUBLISH_AFTER_MS`.
	 * Returns whether it wrote the record.
	 */
	publishStep(now = Date.now()): boolean {
		const me = this.self;
		if (!me || me.state !== "busy" || this.stepCall) return false;
		// Insertion order is start order, so the first entry is the oldest call.
		const oldest = this.running.entries().next().value;
		if (!oldest || now - oldest[1].since < STEP_PUBLISH_AFTER_MS) return false;
		this.stepCall = oldest[0];
		me.step = { ...oldest[1] };
		this.publish();
		return true;
	}

	/** Forget the calls in flight: the run ended, or this session left the switchboard. */
	endSteps(): void {
		this.running.clear();
		this.stepCall = null;
		if (this.self) delete this.self.step;
	}

	/**
	 * The team brief for this agent now, compared with what it was told before (`briefState`, which
	 * then records what this one tells). A null text: nothing to tell.
	 */
	nextBrief(me: Presence, peers: readonly Presence[] = this.presentNow()): { text: string | null; details: MessageDetails } {
		const brief = renderBrief(me, peers, this.briefState, {
			paths: this.awareness.focusPaths(),
			contacts: new Set(this.contacts.keys()),
		});
		this.briefState = brief.state;
		return {
			text: brief.text,
			details: {
				summary: brief.summary,
				// Display only: the renderer paints these names in each agent's colour.
				callsigns: [me.callsign, ...this.team(peers).map((p) => p.callsign)],
			},
		};
	}

	/** Remember a peer this agent talked with: its work stays relevant in this agent's briefs. */
	noteContact(id: string): void {
		// Re-inserted, so the bound drops the longest silent first.
		this.contacts.delete(id);
		setBounded(this.contacts, id, Date.now(), CONTACTS_CAP);
	}

	/** The next brief describes the team in full: the context may no longer hold the last one. */
	requestFullBrief(): void {
		if (this.briefState) this.briefState = { ...this.briefState, fullAt: 0 };
	}

	claimTtlMinutes(): number {
		return Math.round(this.cfg.claimTtlMs / 60_000);
	}

	boardText(scope: BoardScope, peers: readonly Presence[] = this.readPeers()): string {
		if (!this.self) return "telecom is not connected in this session.";
		return renderBoard({ self: this.self, peers, scope, inboundAsks: this.ledger.inbound() });
	}

	// ------------------------------------------------------------------ claims

	/** Drop `patterns` from this agent's claims and tell every peer that was held back by them. */
	releaseClaims(me: Presence, patterns: readonly string[]): string[] {
		me.claims = me.claims.filter((c) => !patterns.includes(c.pattern));
		this.publish();
		this.logEntry("release", `released ${patterns.join(", ")}`, patterns);
		const told = this.tellReleased(me, patterns);
		this.updateStatus();
		return told;
	}

	/** Tell the peers held back by `patterns` that they are free; returns their callsigns. Peers
	 *  queued for a released lock are told too: the first of them takes it at once. */
	tellReleased(me: Presence, patterns: readonly string[]): string[] {
		if (patterns.length === 0) return [];
		const waiting = new Map<string, string>();
		for (const pattern of patterns) {
			for (const [id, callsign] of this.contesters.get(pattern) ?? []) waiting.set(id, callsign);
			this.contesters.delete(pattern);
		}
		const peers = this.readPeers();
		const locks = patterns.filter(isResource);
		if (locks.length > 0) {
			for (const peer of this.team(peers)) {
				if (peer.queued?.some((q) => locks.some((l) => sameResource(l, q.pattern)))) waiting.set(peer.id, peer.callsign);
			}
		}
		const live = new Set(peers.map((p) => p.id));
		for (const id of waiting.keys()) {
			if (live.has(id)) {
				this.sendEvent(id, { topic: "claim.released", data: { patterns: [...patterns] } }, `${me.callsign} released ${patterns.join(", ")}`);
			}
		}
		return [...waiting.values()];
	}

	// ------------------------------------------------------------------ the team log

	/** Log something this agent did that teammates need later; written on the next tick. */
	logEntry(kind: LogKind, text: string, paths: readonly string[] = []): void {
		if (this.self) this.log.record(this.self, kind, text, paths);
	}

	/** Write this agent's log file if something was logged since the last write. */
	flushLog(): void {
		const written = this.log.flush();
		if (written && !written.ok && written.report) this.report("log", written.reason);
	}

	/** The team log of this repository, oldest first: live sessions and recently departed ones. */
	teamLog(peers: readonly Presence[] = this.readPeers()): LogEntry[] {
		const me = this.self;
		return me ? this.log.read(me, new Set(peers.map((p) => p.id))) : [];
	}

	// ------------------------------------------------------------------ the wire

	envelope(to: string, kind: Envelope["kind"], text: string, extra: Partial<Envelope> = {}): Envelope {
		return {
			v: WIRE_VERSION,
			id: newId(kind === "ask" ? "ask" : kind.slice(0, 3)),
			ts: Date.now(),
			from: this.self?.id ?? "unknown",
			fromCallsign: this.self?.callsign ?? "unknown",
			to,
			kind,
			text,
			...extra,
		};
	}

	sendEvent(to: string, event: TelecomEvent, text: string): void {
		if (!this.transport) return;
		const sent = this.transport.deliver(this.envelope(to, "event", text, { topic: event.topic, data: event.data }));
		if (!sent.ok) this.report("event", sent.reason);
	}

	/** Deliver one envelope to each of `peers`; the callsigns it reached, and those it did not. */
	deliverEach(
		net: Transport,
		peers: readonly Presence[],
		kind: Envelope["kind"],
		text: string,
		extra: Partial<Envelope> = {},
	): { reached: string[]; failed: string[] } {
		const reached: string[] = [];
		const failed: string[] = [];
		for (const peer of peers) {
			const sent = net.deliver(this.envelope(peer.id, kind, text, extra));
			(sent.ok ? reached : failed).push(peer.callsign);
		}
		return { reached, failed };
	}

	// ------------------------------------------------------------------ the model

	/** Put a telecom message in front of the model, as `mode` says (see `InjectMode`). */
	inject(customType: string, content: string, details: MessageDetails, mode: InjectMode): boolean {
		if (mode === "later") {
			// Held for the next run (`takeLater`): never steered into the current one.
			const split = content.indexOf("\n\n");
			const head = (split < 0 ? content : content.slice(0, split)).replace(/^\*\*📡 |\*\*$/g, "");
			this.later.push({ at: Date.now(), head, body: split < 0 ? "" : content.slice(split + 2), content });
			if (this.later.length > LATER_CAP) {
				this.later.shift();
				this.laterDropped++;
			}
			return true;
		}
		try {
			// Steering into a running turn does not spend an idle wake-up or need a limit note.
			const idle = this.ctx?.isIdle() === true;
			const needsWake = mode === "wake" && idle;
			const wake = mode === "wake-always" || (needsWake && this.allowWake());
			const note = needsWake && !wake ? `\n\n${this.wakeLimitNote()}` : "";
			// Noted before sending: the run it starts must find it owed, however soon it answers.
			if (wake && idle) this.noteWake(content, details);
			this.pi.sendMessage(
				{ customType, content: content + note, display: true, details },
				wake ? { triggerTurn: true } : undefined,
			);
			return true;
		} catch (error) {
			this.report("deliver", error);
			return false;
		}
	}

	/**
	 * Deliver a peer's direct message. Shared by the inbox and by an ask that ends unanswered:
	 * the messages its peer sent meanwhile were held with it (`AskLedger.hold`), and are delivered
	 * then exactly as they would have been on arrival.
	 */
	injectMessage(msg: HeldMessage): boolean {
		const human = msg.human ? " (from their human)" : "";
		return this.inject(
			MESSAGE_TYPES.message,
			`**📡 Message from ${msg.fromCallsign}${human}**\n\n${msg.text}\n\n(Reply only if needed: action "send", to "${msg.fromCallsign}".)`,
			{ from: msg.from, fromCallsign: msg.fromCallsign, id: msg.id, tone: "accent" },
			"wake",
		);
	}

	/**
	 * What was held for this run (`later`), for the run-start message: recent ones in full, older
	 * ones a line each. Null when nothing was held.
	 */
	takeLater(now = Date.now()): string | null {
		const held = this.later;
		const dropped = this.laterDropped;
		this.later = [];
		this.laterDropped = 0;
		if (held.length === 0) return null;
		const fresh = held.filter((h) => now - h.at <= LATER_FRESH_MS);
		const stale = held.filter((h) => now - h.at > LATER_FRESH_MS);
		const parts: string[] = [];
		if (stale.length > 0 || dropped > 0) {
			const lines = stale.map((h) => `- ${ago(h.at, now)}, ${h.head}: ${clip(h.body.replace(/\s+/g, " "), LATER_LINE_CAP)}`);
			const more = dropped > 0 ? `\n- and ${plural(dropped, "older one")}` : "";
			parts.push(`**📡 Older broadcasts, held while you were away** (as sent: they may have moved on since; telecom({ action: "log" }) has the team's history)\n${lines.join("\n")}${more}`);
		}
		parts.push(...fresh.map((h) => h.content));
		return parts.join("\n\n");
	}

	/** Leaving: what is still held goes to pi's queue for the next run, as it is. */
	flushLater(): void {
		const held = this.later;
		this.later = [];
		this.laterDropped = 0;
		for (const h of held) {
			try {
				this.pi.sendMessage({ customType: MESSAGE_TYPES.broadcast, content: h.content, display: true, details: {} }, { deliverAs: "nextTurn" });
			} catch (error) {
				this.report("deliver", error);
				return;
			}
		}
	}

	/** A run was started for `content`: until a model turn answers, it is owed (`checkWakes`). */
	private noteWake(content: string, details: MessageDetails): void {
		const from = typeof details.fromCallsign === "string" ? details.fromCallsign : undefined;
		const item = { at: Date.now(), content, ...(from ? { from } : {}) };
		if (!this.unread) {
			this.unread = { items: [item], tries: 0, nextAt: item.at + (WAKE_RETRY_BEATS[0] as number) * this.cfg.heartbeatMs, compacted: false, reported: false };
			return;
		}
		this.unread.items = [...this.unread.items, item].slice(-UNREAD_CAP);
	}

	/** The model answered (an assistant message that did not fail): every wake-up is answered. */
	noteModelTurn(): void {
		if (!this.unread) return;
		this.unread = null;
		if (this.self?.unreadSince !== undefined) {
			delete this.self.unreadSince;
			this.publish();
		}
	}

	/** This session left the switchboard: what was owed then is not re-sent after a reconnect. */
	forgetWakes(): void {
		this.unread = null;
	}

	/** Compactions of this session's context so far: advice told once is told in full again after
	 *  one, since the earlier telling may be gone from the context. */
	compactions = 0;

	/** The context was compacted: a reminder of an unanswered wake-up repeats its text in full. */
	noteCompaction(): void {
		this.compactions++;
		if (this.unread) this.unread.compacted = true;
	}

	/**
	 * From the tick: re-send wake-ups no model turn answered once the next retry is due, while the
	 * agent is idle (busy, it is reading them, or compacting before it does). The record says since
	 * when, so teammates see it. Past the last retry the human is told, once.
	 */
	checkWakes(now = Date.now()): void {
		const unread = this.unread;
		const me = this.self;
		if (!unread || !me || now < unread.nextAt || this.ctx?.isIdle() !== true) return;
		const oldest = unread.items[0]?.at ?? now;
		if (unread.tries >= WAKE_RETRY_BEATS.length) {
			if (!unread.reported) {
				unread.reported = true;
				this.notifyUser(`telecom: ${plural(unread.items.length, "message")} to this session started no model turn after ${unread.tries} reminders. Teammates may be waiting on it: look at its last run.`, "warning");
			}
			return;
		}
		unread.tries++;
		unread.nextAt = now + (WAKE_RETRY_BEATS[unread.tries] ?? 0) * this.cfg.heartbeatMs;
		if (me.unreadSince === undefined) {
			me.unreadSince = oldest;
			this.publish();
		}
		const senders = [...new Set(unread.items.map((i) => i.from).filter((f): f is string => f !== undefined))];
		const shown = unread.items.map((i) => `${ago(i.at, now)}:\n\n${clip(i.content, unread.compacted ? UNREAD_TEXT_CAP : UNREAD_TEXT_CAP / 4)}`).join("\n\n---\n\n");
		const answer = senders.length > 0 ? ` If you cannot act on it, tell ${senders.join(" and ")} why: telecom({ action: "send", to: "${senders[0]}", message: "…" }).` : "";
		this.pi.sendMessage(
			{
				customType: MESSAGE_TYPES.message,
				content: `**📡 ${unread.items.length === 1 ? "This message" : `These ${unread.items.length} messages`} started a run, but your run ended before you answered** (reminder ${unread.tries} of ${WAKE_RETRY_BEATS.length})\n\nSent ${shown}\n\nAct on ${unread.items.length === 1 ? "it" : "them"} now.${answer}`,
				display: true,
				details: { tone: "warning" },
			},
			{ triggerTurn: true },
		);
	}

	private allowWake(): boolean {
		const now = Date.now();
		while (this.wakeTimes.length > 0 && now - (this.wakeTimes[0] as number) > WAKE_WINDOW_MS) this.wakeTimes.shift();
		if (this.wakeTimes.length >= this.cfg.maxWakesPerMinute) return false;
		this.wakeTimes.push(now);
		return true;
	}

	private wakeLimitNote(): string {
		return this.cfg.maxWakesPerMinute === 0
			? "(telecom: peer wake-ups are off in this session (PI_TELECOM_MAX_WAKES=0), so this arrived without starting a turn.)"
			: `(telecom: the limit of ${this.cfg.maxWakesPerMinute} peer wake-ups in the last minute was reached, so this arrived without starting a turn.)`;
	}

	// ------------------------------------------------------------------ settings kept in the session

	/** Remember this session's callsign on its active branch, for a resume. */
	persistCallsign(): void {
		if (!this.self) return;
		try {
			this.pi.appendEntry(CALLSIGN_ENTRY, { callsign: this.self.callsign });
		} catch {
			/* not persisted; a resume will just pick a fresh word */
		}
	}

	/** Remember the human's `/telecom on|off` on the active branch: it outlives reloads. */
	persistEnabled(): void {
		this.step("setting", () => this.pi.appendEntry(ENABLED_ENTRY, { enabled: this.enabled }));
	}

	// ------------------------------------------------------------------ the human

	/** The UI, when this mode has one (the TUI or an RPC client); print and JSON modes get null. */
	ui(): ExtensionUIContext | null {
		return this.ctx?.hasUI ? this.ctx.ui : null;
	}

	/** Tell the human. Best effort: a UI that throws must not take telecom down with it. */
	notifyUser(text: string, level: "info" | "warning" = "info"): void {
		try {
			this.ui()?.notify(text, level);
		} catch {
			/* no UI */
		}
	}

	/** Colours in the TUI; plain text for RPC and print clients, which show strings. */
	paint(): Paint {
		const u = this.ui();
		return this.ctx?.mode === "tui" && u?.theme ? u.theme : PLAIN;
	}

	/** Redraw what the human sees of the team: the footer, the widget and an open board panel. */
	updateStatus(): void {
		const me = this.self;
		if (!me || !this.ui()) return;
		try {
			// Rebuilt on every refresh, so a theme change shows up within a second.
			const mates = this.team(this.present);
			const peers = mates.filter((p) => p.role !== "child");
			const status = {
				callsign: me.callsign,
				peers: peers.length,
				busy: peers.filter((p) => p.state === "busy").length,
				subagents: mates.length - peers.length,
				claims: me.claims.length,
				asks: this.ledger.inbound().length,
			};
			this.showStatus(statusText(status, this.paint()));
			if (this.widgetOn) this.showWidget();
			if (this.panel) {
				this.panel.component.refresh();
				this.panel.tui.requestRender();
			}
		} catch {
			/* UI not available in this mode */
		}
	}

	/** The footer while this session is off: shown only after the human turned it off. */
	showOff(why?: string): void {
		try {
			this.showStatus(offStatus(this.paint(), why));
		} catch {
			/* no UI */
		}
	}

	/** Take the footer down: this session left the switchboard. */
	clearStatus(): void {
		this.showStatus(undefined);
	}

	/** pi clears extension statuses when it rebinds a session: the next update sets the footer again. */
	forgetStatus(): void {
		this.shownStatus = undefined;
	}

	/**
	 * Set the footer, only when its text changed: pi redraws the screen for every `setStatus`, and
	 * the team refresh runs every second. The text carries the theme's colours, so a theme change
	 * still shows.
	 */
	private showStatus(text: string | undefined): void {
		const u = this.ui();
		if (!u || text === this.shownStatus) return;
		try {
			u.setStatus("telecom", text);
			this.shownStatus = text;
		} catch {
			/* no UI */
		}
	}

	toggleWidget(): boolean {
		this.widgetOn = !this.widgetOn;
		if (this.widgetOn) this.showWidget();
		else this.hideWidget();
		return this.widgetOn;
	}

	hideWidget(): void {
		this.widget = null;
		try {
			this.ui()?.setWidget("telecom", undefined);
		} catch {
			/* no UI */
		}
	}

	private snapshot(): TeamSnapshot | null {
		return this.self ? { self: this.self, peers: this.present, asks: this.ledger.inbound(), now: Date.now() } : null;
	}

	/** Show the widget, or redraw it: a component in the TUI, plain lines for an RPC client. */
	private showWidget(): void {
		const u = this.ui();
		if (!u) return;
		if (this.ctx?.mode !== "tui") {
			const snap = this.snapshot();
			if (snap) u.setWidget("telecom", widgetLines(snap, PLAIN, PLAIN_WIDGET_COLUMNS, this.widgetPlaces));
			return;
		}
		if (this.widget) {
			this.widget.component.invalidate();
			this.widget.tui.requestRender();
			return;
		}
		u.setWidget("telecom", (tui, theme) => {
			const component = new TeamWidget(theme, () => this.snapshot());
			const entry = { tui, component };
			this.widget = entry;
			return Object.assign(component, {
				dispose: () => {
					if (this.widget === entry) this.widget = null;
				},
			});
		});
	}
}

/** The line of a prompt or a team task that becomes the task peers see: its first non-blank one. */
export function taskLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? text;
}

/** The last valid value `read` finds in this session's `type` entries on its active branch. */
function lastEntry<T>(ctx: ExtensionContext, type: string, read: (data: Record<string, unknown>) => T | undefined): T | undefined {
	let last: T | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== type) continue;
		const value = read((entry.data ?? {}) as Record<string, unknown>);
		if (value !== undefined) last = value;
	}
	return last;
}

/** The callsign this session last used on its active branch, if any. */
export function rememberedCallsign(ctx: ExtensionContext): string | undefined {
	return lastEntry(ctx, CALLSIGN_ENTRY, ({ callsign }) => (typeof callsign === "string" && CALLSIGN_PATTERN.test(callsign) ? callsign : undefined));
}

/** A command overrides the environment for this session's active branch, including reloads. */
export function rememberedEnabled(ctx: ExtensionContext): boolean | undefined {
	return lastEntry(ctx, ENABLED_ENTRY, ({ enabled }) => (typeof enabled === "boolean" ? enabled : undefined));
}
