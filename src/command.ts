/**
 * command — `/telecom`, for the human: the board (a live panel in the TUI, text for an RPC
 * client), the command list, turning telecom off and on, renaming, team tasks, messages,
 * broadcasts and releasing claims. Nothing here reaches the model except a team task or a message
 * the human sends.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveTarget, stateHint } from "./address.ts";
import type { BoardScope } from "./board.ts";
import { CALLSIGN_PATTERN, NATO } from "./callsign.ts";
import { readConfig } from "./config.ts";
import type { Inbound } from "./inbound.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { callsignText } from "./render.ts";
import { OFF_TEXT, type Runtime } from "./runtime.ts";
import { deliveryReport } from "./tool.ts";
import { textTooLong } from "./transport.ts";
import { ago, clip, plural } from "./util.ts";
import { BoardPanel, CommandList, COMMANDS, type CommandSpec, helpText, usage } from "./view.ts";

type Level = "info" | "warning" | "error";

export function registerCommand(rt: Runtime, life: Lifecycle, inbound: Inbound): void {
	/** Diagnostics the help and the board panel show: how the guard acts, and the last heartbeat. */
	function diagnostics(): string {
		return `guard ${rt.cfg.guard} (PI_TELECOM_GUARD) · heartbeat ${ago(rt.lastHeartbeat)}`;
	}

	/** `/telecom` in the TUI: the board in a live panel where the editor was, until escape. */
	async function showBoard(ctx: ExtensionCommandContext, scope: BoardScope): Promise<void> {
		// The panel redraws on every status update, which mostly follows a fresh read of the peers:
		// it draws from that cache instead of scanning the presence directory again each time.
		rt.readPeers();
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			const component = new BoardPanel({
				theme,
				keybindings,
				tui,
				scope,
				board: (s) => rt.boardText(s, rt.peers),
				aside: diagnostics,
				toggleWidget: () => rt.toggleWidget(),
				done: () => done(),
			});
			const entry = { tui, component };
			rt.panel = entry;
			return Object.assign(component, {
				dispose: () => {
					if (rt.panel === entry) rt.panel = null;
				},
			});
		});
		rt.panel = null;
	}

	/** `/telecom help` in the TUI: pick a command; one with arguments opens in the editor. */
	async function showCommands(ctx: ExtensionCommandContext): Promise<void> {
		const p = ctx.ui.theme;
		const status = rt.self
			? `${callsignText(p, rt.self.callsign)}${p.fg("dim", ` · ${plural(rt.team().length, "other agent")}`)}`
			: p.fg("dim", rt.enabled ? "not connected" : "off");
		const chosen = await ctx.ui.custom<CommandSpec | undefined>((tui, theme, _keybindings, done) =>
			new CommandList({ theme, tui, status, done }),
		);
		if (!chosen || chosen.name === "help") return;
		if (chosen.args) {
			ctx.ui.setEditorText(`/telecom ${chosen.name} `);
			return;
		}
		await runCommand(chosen.name, ctx);
	}

	async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		rt.ctx = ctx;
		const [sub = "board", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		// Every line telecom adds to the transcript starts with its mark, so it reads as telecom's.
		const say = (text: string, level: Level = "info") => ctx.ui.notify(`📡 ${text}`, level);
		const tui = ctx.mode === "tui";
		if (sub === "help") {
			if (tui) await showCommands(ctx);
			else ctx.ui.notify(`${helpText()}\n${diagnostics()}`, "info");
			return;
		}
		if (sub === "off") {
			rt.enabled = false;
			rt.persistEnabled();
			life.stop();
			rt.showOff();
			say(OFF_TEXT);
			return;
		}
		if (sub === "on") {
			if (rt.self) {
				say(`telecom is already on — you are ${rt.self.callsign}`);
				return;
			}
			rt.enabled = true;
			rt.persistEnabled();
			rt.cfg = readConfig();
			const connected = life.connect(ctx);
			if (!connected) rt.showOff();
			say(
				connected
					? `telecom is on — you are ${connected.callsign}`
					: `telecom could not connect: ${rt.unavailable ?? "no session id"}. Try /telecom on again.`,
				connected ? "info" : "warning",
			);
			return;
		}
		const me = rt.self;
		const net = rt.transport;
		if (!me || !net) {
			say(
				!rt.enabled
					? OFF_TEXT
					: `telecom is not connected${rt.unavailable ? `: ${rt.unavailable}` : ""}. Run /telecom on to reconnect.`,
				"warning",
			);
			return;
		}
		switch (sub) {
			case "run": {
				// Keep code blocks, indentation and newlines exactly as the human entered them.
				const prompt = args.trim().slice(sub.length).trim();
				if (!prompt) {
					say("usage: /telecom run <prompt> — starts work in every connected session in this repository, including this one", "warning");
					return;
				}
				const tooLong = textTooLong(prompt, "the prompt");
				if (tooLong) {
					say(tooLong, "warning");
					return;
				}
				const task = { human: true, triggerTurn: true } as const;
				const { reached, failed } = rt.deliverEach(net, rt.team(rt.readPeers()), "message", prompt, task);
				const sentHere = inbound.runTask(rt.envelope(me.id, "message", prompt, task));
				(sentHere ? reached : failed).unshift(`${me.callsign} (this session)`);
				say(`task sent to ${deliveryReport(reached, failed)}`, failed.length ? "warning" : "info");
				return;
			}
			case "board":
			case "all": {
				const scope = sub === "all" ? "machine" : "project";
				// The panel is the TUI's; an RPC client gets the board as text, as the model does.
				if (tui) await showBoard(ctx, scope);
				else ctx.ui.notify(rt.boardText(scope), "info");
				return;
			}
			case "widget":
				say(rt.toggleWidget() ? "live team widget on — it sits above the editor; /telecom widget hides it" : "live team widget off");
				return;
			case "name": {
				const wanted = rest[0]?.toLowerCase();
				if (!wanted || !CALLSIGN_PATTERN.test(wanted)) {
					say(`usage: /telecom name <callsign> — lowercase letters, digits, - or _ (e.g. ${NATO.slice(0, 3).join(", ")})`, "warning");
					return;
				}
				if (rt.team(rt.readPeers()).some((p) => p.callsign === wanted)) {
					say(`${wanted} is taken in this project`, "warning");
					return;
				}
				me.callsign = wanted;
				rt.persistCallsign();
				rt.publish();
				// Peers' briefs say who we are; ours should restate the team under the new name.
				rt.requestFullBrief();
				rt.updateStatus();
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
				const target = resolveTarget(to, me, rt.readPeers());
				if (!target.ok) {
					say(target.reason, "warning");
					return;
				}
				const sent = net.deliver(rt.envelope(target.peer.id, "message", text, { human: true }));
				say(sent.ok ? `sent to ${target.peer.callsign} (${stateHint(target.peer, me, rt.peers)})` : sent.reason, sent.ok ? "info" : "error");
				return;
			}
			case "broadcast": {
				const text = rest.join(" ").trim();
				const peers = rt.team(rt.readPeers());
				if (!text || peers.length === 0) {
					say(!text ? "usage: /telecom broadcast <text>" : "no other agent is live in this project", "warning");
					return;
				}
				const { reached, failed } = rt.deliverEach(net, peers, "broadcast", text, { human: true });
				say(`broadcast to ${deliveryReport(reached, failed)}`, failed.length ? "warning" : "info");
				return;
			}
			case "release": {
				const names = me.claims.map((c) => c.pattern);
				if (names.length === 0) {
					say("no claims to release");
					return;
				}
				const told = rt.releaseClaims(me, names);
				say(`released ${plural(names.length, "claim")}${told.length ? ` — told ${told.join(", ")}` : ""}`);
				return;
			}
			default:
				if (tui) {
					say(`unknown command "${sub}" — pick one below`, "warning");
					await showCommands(ctx);
				} else {
					ctx.ui.notify(`📡 unknown command "${sub}"\n${helpText()}\n${diagnostics()}`, "warning");
				}
		}
	}

	rt.pi.registerCommand("telecom", {
		description: "Team board, tasks and messages for parallel pi agents · /telecom help lists everything",
		getArgumentCompletions(prefix) {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return COMMANDS.filter((c) => c.name.startsWith(parts[0] ?? "")).map((c) => ({
					value: c.name,
					label: usage(c),
					description: c.about,
				}));
			}
			if (parts[0] === "msg" && parts.length === 2) {
				return rt
					.team()
					.filter((p) => p.callsign.startsWith(parts[1] ?? ""))
					.map((p) => ({
						value: `msg ${p.callsign} `,
						label: p.callsign,
						description: `${p.state}${p.task ? ` · ${clip(p.task, 60)}` : ""}`,
					}));
			}
			return null;
		},
		handler: runCommand,
	});
}
