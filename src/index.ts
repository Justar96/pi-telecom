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
 *     claim, release and log (the team's history: broadcasts, tasks, claims, joins and leaves);
 *   - the `/telecom` COMMAND for the human: the board, renaming, messaging an agent directly,
 *     and a live board widget.
 *
 * pi-subagents children join as FAMILY (see `family.ts`): named after their parent (`alpha-1`),
 * listed under it, folded into it in briefs, and never held back by their parent's claims.
 *
 * This factory only creates the session's state (`runtime.ts`) and registers the parts that act
 * on it: the lifecycle and its loop, inbound handling, the guard, the turn hooks, the tool and the
 * command. Nothing starts here; a session connects at `session_start` (AGENTS.md, rule 4).
 *
 * Messaging is derived from @tinoy/pi-ipc (MIT, github.com/tinoy1336/pi-extensions); the team
 * layer — projects, callsigns, briefs, change notices, claims and the guard — is new.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "./actions.ts";
import { registerCommand } from "./command.ts";
import { registerGuard } from "./guard.ts";
import { createInbound } from "./inbound.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { registerRenderers } from "./render.ts";
import { Runtime } from "./runtime.ts";
import { registerTurns } from "./turns.ts";
import { createWaiting } from "./waiting.ts";

export default function telecom(pi: ExtensionAPI): void {
	const rt = new Runtime(pi);
	registerRenderers(pi);
	const waiting = createWaiting(rt);
	const inbound = createInbound(rt, waiting);
	const guard = registerGuard(rt);
	const life = registerLifecycle(rt, inbound, guard, waiting);
	registerTurns(rt, inbound);
	registerTool(rt, waiting);
	registerCommand(rt, life, inbound);
}
