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
import { type BoardScope, type BriefState, renderBoard } from "./board.ts";
import { CALLSIGN_PATTERN } from "./callsign.ts";
import { readConfig, type TelecomConfig } from "./config.ts";
import { createAskLedger, WAITS_CAP } from "./ledger.ts";
import { type PlaceCache, sameRepo } from "./project.ts";
import { type Paint, PLAIN, type TelecomMessageDetails } from "./render.ts";
import { type Envelope, type Presence, type TelecomEvent, type Transport, WIRE_VERSION } from "./transport.ts";
import { clip, messageOf, newId, setBounded } from "./util.ts";
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
const TASK_CAP = 160;
/** Sessions this agent has talked with directly; they stay relevant in its briefs. */
const CONTACTS_CAP = 256;

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
	/** The live records as of the last read (`readPeers`), this session's included. */
	peers: Presence[] = [];
	briefState: BriefState | null = null;
	/** The current task was set on purpose, so only a new direction from a prompt replaces it. */
	taskExplicit = false;
	readonly awareness = new Awareness();
	readonly ledger = createAskLedger();
	/** Sessions this agent has talked with directly; they stay relevant in its briefs. */
	readonly contacts = new Map<string, true>();
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
		} catch (error) {
			this.report("peers", error);
		}
		return this.peers;
	}

	/** Live peers in this repository (this checkout or a sibling worktree), this session excluded. */
	team(peers: readonly Presence[] = this.peers): Presence[] {
		const me = this.self;
		return me ? peers.filter((p) => p.id !== me.id && sameRepo(p, me)) : [];
	}

	/** The task peers see for this agent. */
	setTask(me: Presence, text: string, explicit: boolean): void {
		me.task = clip(text, TASK_CAP);
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

	/** Remember a peer this agent talked with: its work stays relevant in this agent's briefs. */
	noteContact(id: string): void {
		setBounded(this.contacts, id, true, CONTACTS_CAP);
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
		const told = this.tellReleased(me, patterns);
		this.updateStatus();
		return told;
	}

	/** Tell the peers held back by `patterns` that they are free; returns their callsigns. */
	tellReleased(me: Presence, patterns: readonly string[]): string[] {
		if (patterns.length === 0) return [];
		const waiting = new Map<string, string>();
		for (const pattern of patterns) {
			for (const [id, callsign] of this.contesters.get(pattern) ?? []) waiting.set(id, callsign);
			this.contesters.delete(pattern);
		}
		const live = new Set(this.readPeers().map((p) => p.id));
		for (const id of waiting.keys()) {
			if (live.has(id)) {
				this.sendEvent(id, { topic: "claim.released", data: { patterns: [...patterns] } }, `${me.callsign} released ${patterns.join(", ")}`);
			}
		}
		return [...waiting.values()];
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
		try {
			// Steering into a running turn does not spend an idle wake-up or need a limit note.
			const needsWake = mode === "wake" && this.ctx?.isIdle() === true;
			const wake = mode === "wake-always" || (needsWake && this.allowWake());
			const note = needsWake && !wake ? `\n\n${this.wakeLimitNote()}` : "";
			this.pi.sendMessage(
				{ customType, content: content + note, display: true, details },
				// `later`: held until this agent's next run starts, never steered into the current one.
				wake ? { triggerTurn: true } : mode === "later" ? { deliverAs: "nextTurn" } : undefined,
			);
			return true;
		} catch (error) {
			this.report("deliver", error);
			return false;
		}
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
			const mates = this.team();
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
		return this.self ? { self: this.self, peers: this.peers, asks: this.ledger.inbound(), now: Date.now() } : null;
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
