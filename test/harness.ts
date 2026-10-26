/**
 * harness — plays pi's role for one session so the real extension can be driven in a test.
 *
 * Several sessions can live in one test process: each gets its own fake `pi` and its own
 * extension instance, and they meet on a scratch switchboard (`PI_TELECOM_DIR`). They share
 * the process id, which is fine — liveness is per pid, and the pid is alive.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SCRATCH = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-telecom-test-")));
// Every test file runs in its own process: its scratch directory goes with it, so repeated runs
// do not pile up projects and switchboards in the temp directory.
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));
process.env.PI_TELECOM_DIR = join(SCRATCH, "switchboard");
process.env.PI_TELECOM_TICK_MS = "20";
delete process.env.PI_TELECOM_GUARD;

const { default: telecom } = await import("../src/index.ts");

let host: ReturnType<typeof setInterval> | undefined;
before(() => {
	// Real pi has a live UI/RPC transport. Our fake host needs its own reference while an ask
	// waits: telecom correctly unrefs its timers, and Node 22 otherwise exits mid-scenario.
	host = setInterval(() => {}, 60_000);
});
after(() => clearInterval(host));

export interface Sent {
	customType: string;
	content: string;
	details: Record<string, unknown>;
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

type Handler = (event: any, ctx: any) => unknown;

interface ToolLike {
	name: string;
	execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
}

interface CommandLike {
	handler: (args: string, ctx: any) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
}

let sessionCounter = 0;

export function makeProject(name: string, git = true): string {
	const dir = join(SCRATCH, name);
	mkdirSync(dir, { recursive: true });
	if (git) {
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	}
	return dir;
}

/** A git worktree of `main`, laid out the way `git worktree add` does it. */
export function makeWorktree(main: string, name: string, branch: string, at?: string): string {
	const gitDir = join(main, ".git", "worktrees", name);
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	const dir = at ?? join(SCRATCH, `${basename(main)}-${name}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
	return dir;
}

/** Set an environment variable until test `t` ends. */
export function withEnv(t: TestContext, name: string, value: string | undefined): void {
	const previous = process.env[name];
	t.after(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A theme without styling: renders as plain text. */
export const PLAIN_THEME = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

export class Session {
	readonly id: string;
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, ToolLike>();
	readonly commands = new Map<string, CommandLike>();
	readonly sent: Sent[] = [];
	readonly notified: string[] = [];
	readonly entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	status: string | undefined;
	sessionName: string | undefined;
	readonly ctx: any;
	private callCounter = 0;
	readonly cwd: string;

	/** The session header's `parentSession`: pi-subagents sets it to the parent's session file. */
	parentSession: string | undefined;
	/** Set to simulate pi disposing the session: every `pi.*` call throws from then on. */
	disposed = false;

	constructor(cwd: string, opts: { name?: string; id?: string; parentSession?: string } = {}) {
		this.cwd = cwd;
		sessionCounter++;
		this.id = opts.id ?? `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`;
		this.sessionName = opts.name;
		this.parentSession = opts.parentSession;
		const self = this;
		this.ctx = {
			cwd,
			hasUI: true,
			mode: "rpc",
			model: { id: "test-model" },
			sessionManager: {
				getSessionId: () => self.id,
				getHeader: () => ({ type: "session", id: self.id, timestamp: "", cwd, ...(self.parentSession ? { parentSession: self.parentSession } : {}) }),
				getEntries: () => self.entries,
				getBranch: () => self.entries,
			},
			ui: {
				theme: PLAIN_THEME,
				setStatus: (_key: string, text: string | undefined) => {
					self.status = text;
				},
				notify: (text: string) => {
					self.notified.push(text);
				},
				setWidget: () => {},
			},
			isIdle: () => true,
		};
		const pi = {
			on: (event: string, handler: Handler) => {
				const list = self.handlers.get(event) ?? [];
				list.push(handler);
				self.handlers.set(event, list);
				return () => {};
			},
			registerTool: (tool: ToolLike) => self.tools.set(tool.name, tool),
			registerCommand: (name: string, options: CommandLike) =>
				self.commands.set(name, options),
			registerMessageRenderer: () => {},
			sendMessage: (message: any, options?: Sent["options"]) => {
				self.sent.push({
					customType: message.customType,
					content: String(message.content),
					details: message.details ?? {},
					options,
				});
			},
			appendEntry: (customType: string, data: unknown) => self.entries.push({ type: "custom", customType, data }),
			getSessionName: () => {
				if (self.disposed) throw new Error("This extension ctx is stale after session replacement or reload.");
				return self.sessionName;
			},
			events: { on: () => () => {}, emit: () => {} },
		};
		telecom(pi as unknown as ExtensionAPI);
	}

	async fire(event: string, payload: Record<string, unknown> = {}): Promise<any> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const out = await handler({ type: event, ...payload }, this.ctx);
			if (out !== undefined) result = out;
		}
		return result;
	}

	async start(reason: "startup" | "reload" | "resume" = "startup"): Promise<this> {
		await this.fire("session_start", { reason });
		return this;
	}

	async stop(reason: "quit" | "reload" | "new" = "quit"): Promise<void> {
		await this.fire("session_shutdown", { reason });
	}

	async tool(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: any; isError: boolean }> {
		const tool = this.tools.get("telecom");
		if (!tool) throw new Error("telecom tool not registered");
		const result = await tool.execute(`call-${++this.callCounter}`, params, signal, undefined, this.ctx);
		return {
			text: result.content.map((c: { text: string }) => c.text).join("\n"),
			details: result.details,
			isError: result.isError === true,
		};
	}

	async prompt(text: string): Promise<any> {
		return this.fire("before_agent_start", { messageType: "user", prompt: text, systemPrompt: "", systemPromptOptions: {} });
	}

	async settle(): Promise<any> {
		const result = await this.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: { canContinue: true },
		});
		await this.fire("agent_settled", { aborted: false });
		return result;
	}

	/** A read, the way pi reports it. */
	async read(path: string): Promise<void> {
		const toolCallId = `read-${++this.callCounter}`;
		await this.fire("tool_call", { toolName: "read", toolCallId, input: { path } });
		await this.fire("tool_result", { toolName: "read", toolCallId, input: { path }, content: [], isError: false });
	}

	/** An edit (single replacement) — blocked when the guard says so. */
	async edit(path: string, oldText: string, newText: string): Promise<{ blocked?: string; note?: string }> {
		const toolCallId = `edit-${++this.callCounter}`;
		const input = { path, edits: [{ oldText, newText }] };
		const call = await this.fire("tool_call", { toolName: "edit", toolCallId, input });
		if (call?.block) return { blocked: call.reason };
		const abs = resolve(this.cwd, path);
		writeFileSync(abs, readFileSync(abs, "utf8").replace(oldText, newText));
		const result = await this.fire("tool_result", {
			toolName: "edit",
			toolCallId,
			input,
			content: [{ type: "text", text: "ok" }],
			details: { patch: `--- a\n+++ b\n-${oldText}\n+${newText}\n`, firstChangedLine: 1 },
			isError: false,
		});
		return { note: result?.content?.map((c: { text: string }) => c.text).join("\n") };
	}

	async write(path: string, content: string): Promise<{ blocked?: string; note?: string }> {
		const toolCallId = `write-${++this.callCounter}`;
		const input = { path, content };
		const call = await this.fire("tool_call", { toolName: "write", toolCallId, input });
		if (call?.block) return { blocked: call.reason };
		const abs = resolve(this.cwd, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
		const result = await this.fire("tool_result", {
			toolName: "write",
			toolCallId,
			input,
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		return { note: result?.content?.map((c: { text: string }) => c.text).join("\n") };
	}

	/** Write this session's file the way pi does (header first), for a child's `parentSession`. */
	sessionFile(): string {
		const file = join(SCRATCH, "sessions", `2026-10-22T00-00-00-000Z_${this.id}.jsonl`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: this.id, timestamp: "", cwd: this.cwd })}\n`);
		return file;
	}

	sentOf(customType: string): Sent[] {
		return this.sent.filter((s) => s.customType === customType);
	}

	async command(args: string): Promise<string[]> {
		const before = this.notified.length;
		await this.commands.get("telecom")?.handler(args, this.ctx);
		return this.notified.slice(before);
	}
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long to wait for a change notice. Notices are held for the coalescing window (1.2 s)
 * before they are sent, and a loaded CI runner (Windows especially) runs ticks two to three
 * times slower than a workstation, so the default `eventually` limit is too tight for them.
 */
export const NOTICE_WAIT_MS = 6_000;

/** Wait until `check` passes, or fail with its last error. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			await check();
			return;
		} catch (error) {
			last = error;
			await sleep(15);
		}
	}
	throw last;
}

const open: Session[] = [];

/** Remember a started session, so `stopSessions()` stops it. */
export function track<S extends Session>(session: S): S {
	open.push(session);
	return session;
}

/** Start a session that `stopSessions()` stops. */
export async function session(cwd: string, opts: ConstructorParameters<typeof Session>[1] = {}): Promise<Session> {
	return track(await new Session(cwd, opts).start());
}

/** Stop every tracked session: a test file's `after` or `afterEach` hook. */
export async function stopSessions(): Promise<void> {
	for (const s of open.splice(0)) await s.stop();
}
