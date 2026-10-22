/**
 * config — every knob, read from the environment at call time (never at import).
 *
 * Telecom has no config file on purpose: a knob is an environment variable, so a launcher
 * (tmux script, pi-subagents, CI) can set it per process without touching shared state.
 */
import { CALLSIGN_PATTERN } from "./callsign.ts";

/** How hard the edit guard pushes back when a peer's work collides with this agent's. */
export type GuardMode = "strict" | "standard" | "off";

export interface TelecomConfig {
	/** `strict`: block stale edits and every claimed path. `standard`: block stale whole-file
	 *  writes, warn on stale edits, block a claimed path once. `off`: never block. */
	guard: GuardMode;
	/** Default wait for `ask`, in milliseconds. */
	askTimeoutMs: number;
	/** Peer messages that may wake (start a turn in) this agent per rolling minute. Messages over
	 *  the limit still arrive, passively, so a chatty peer cannot burn this agent's tokens. 0 = never
	 *  wake automatically (asks and explicit human team tasks still wake). */
	maxWakesPerMinute: number;
	/** Fixed callsign for this session, instead of the next free NATO word. */
	callsign: string | undefined;
	/** Start disconnected unless this session has an explicit command override. */
	disabled: boolean;
	/** Claim time-to-live without activity, in milliseconds. */
	claimTtlMs: number;
	/** How often the inbox loop runs, in milliseconds. Tests shorten it; users have no reason to. */
	tickMs: number;
}

export const ENV = {
	dir: "PI_TELECOM_DIR",
	guard: "PI_TELECOM_GUARD",
	askTimeout: "PI_TELECOM_ASK_TIMEOUT_MS",
	maxWakes: "PI_TELECOM_MAX_WAKES",
	callsign: "PI_TELECOM_CALLSIGN",
	disable: "PI_TELECOM_DISABLE",
	claimTtl: "PI_TELECOM_CLAIM_TTL_MIN",
	tickMs: "PI_TELECOM_TICK_MS",
} as const;

export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;
export const MAX_ASK_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MAX_WAKES = 6;
const DEFAULT_CLAIM_TTL_MIN = 120;
const DEFAULT_TICK_MS = 500;

function positive(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Like `positive`, but 0 is a meaningful value ("never"). */
function nonNegative(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function truthy(raw: string | undefined): boolean {
	return /^(1|true|yes|on)$/i.test(raw?.trim() ?? "");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): TelecomConfig {
	const guardRaw = env[ENV.guard]?.trim().toLowerCase();
	const guard: GuardMode =
		guardRaw === "strict" || guardRaw === "off" || guardRaw === "standard" ? guardRaw : "standard";
	const callsign = env[ENV.callsign]?.trim().toLowerCase();
	return {
		guard,
		askTimeoutMs: Math.min(positive(env[ENV.askTimeout], DEFAULT_ASK_TIMEOUT_MS), MAX_ASK_TIMEOUT_MS),
		maxWakesPerMinute: Math.floor(nonNegative(env[ENV.maxWakes], DEFAULT_MAX_WAKES)),
		callsign: callsign && CALLSIGN_PATTERN.test(callsign) ? callsign : undefined,
		disabled: truthy(env[ENV.disable]),
		claimTtlMs: positive(env[ENV.claimTtl], DEFAULT_CLAIM_TTL_MIN) * 60_000,
		tickMs: positive(env[ENV.tickMs], DEFAULT_TICK_MS),
	};
}
