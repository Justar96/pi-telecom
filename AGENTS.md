# AGENTS.md — pi-telecom

A pi extension, published as `@justar_96/pi-telecom`, that connects pi sessions working in the
same project. It gives each session a callsign, presence, team briefs and change notices, and
adds an edit guard, claims, and a `telecom` tool and `/telecom` command for messaging. The
README is the user-facing description. This file is for working on the code.

## Commands

```bash
npm install            # dev tooling only — the package has no runtime dependencies
npm run typecheck      # tsc --noEmit: strict, erasable syntax only, covers src/ test/ scripts/
npm test               # node:test over test/*.test.ts (~10 s)
npm run e2e            # real `pi --mode rpc` processes, no model calls (~1 min)
npm run check          # all three; run before every commit

# one test:
node --experimental-strip-types --no-warnings --test --test-name-pattern="claims" test/team.test.ts

# with a real model (spends a few short turns each):
TELECOM_LIVE_MODEL=<provider/model> npm run e2e:live    # TELECOM_LIVE_ONLY=core|claims for one part
TELECOM_LIVE_MODEL=<provider/model> npm run e2e:cache   # the prompt-cache proof
```

The scripts exit `0` on pass, `1` when a check fails, and `2` when a precondition is missing (for
example, no model configured). Never treat `2` as a pass. The live scripts load only this
extension (`--no-extensions`). If the model's provider is itself an extension, pass its entry with
`TELECOM_LIVE_EXTENSIONS=/path/to/provider/index.ts`.

Run `e2e:live` and `e2e:cache` before a release whenever model-facing text, the tool schema, or
message delivery changed.

## Layout

| file | owns |
|---|---|
| `src/index.ts` | The entry point. One closure per session runtime wires presence, the inbox loop, inbound handling, the guard hooks, the `telecom` tool and the `/telecom` command. Sections are marked `// ---- name`. |
| `src/transport.ts` | The wire: root directory, liveness, presence records, envelopes, `deliver`/`drain`, reload handoff, and **all validation of peer data**. |
| `src/awareness.ts` | What this agent has seen (views), what peers changed, and the guard's verdicts. Pure decisions; the caller acts on them. |
| `src/ledger.ts` | Asks this agent is waiting on, and asks it owes an answer. |
| `src/board.ts` | Board text and team briefs (full, then only the changes). |
| `src/glob.ts` | Claim patterns: matching and overlap. |
| `src/project.ts` | Project root, git branch, canonical paths. |
| `src/callsign.ts` | Callsign choice and collision handling. |
| `src/config.ts` | Every `PI_TELECOM_*` variable, read at session start (never at import). |
| `src/render.ts` | TUI renderers for telecom messages. |
| `src/util.ts` | Small helpers (`clip`, `ago`, `fileFingerprint`, `newId`). |
| `test/harness.ts` | A fake `pi` that drives the real extension; many sessions in one process. |
| `scripts/` | e2e drivers (`rpc-driver.mjs`), the probe extension for the cache test. |
| `reference/` | Gitignored. A clone of tinoy1336/pi-extensions at `6a71be3`, the code the transport was derived from. Recreate it with `git clone https://github.com/tinoy1336/pi-extensions.git reference/pi-extensions`. |

Runtime imports are acyclic: `index → board → awareness → glob → project`, and `transport →
callsign, config, util`. `callsign.ts` imports only *types* from `transport.ts` (erased at load),
which is what keeps that pair from forming a cycle. Keep it acyclic: an ESM import cycle can hand
a module an uninitialized binding.

## How it fits together

- **Shared directory** (`transport.ts`): `presence/<session>.json` (each written only by its
  owner) and `inbox/<session>/<seq>-<id>.json`. Every write goes to a temporary name and is then
  renamed. Presence records are checked against the process table, not heartbeats.
- **The loop** (`tick()` in `index.ts`, every 500 ms, `unref`'d): drain the inbox → refresh the
  team every 2nd tick (repair our own record, detect the same session open twice, resolve callsign
  collisions, notice joins and leaves) → flush pending change notices → expire asks → heartbeat
  every 15 s (expire claims, re-read the branch, sweep dead records).
- **Envelope kinds:** `message`, `broadcast`, `ask`, `answer`, and `event`. Event topics are
  `file.changed`, `claim.contested`, `claim.released` and `ask.withdrawn`.
- **Delivery to the model** (`inject` modes):

  | mode | used for | when busy | when idle |
  |---|---|---|---|
  | `wake` | direct messages, late answers | steered in | starts a turn (wake-limited) |
  | `wake-always` | asks (a peer is blocked) | steered in | starts a turn |
  | `passive` | notices, broadcasts, claim news | steered in | appended, no turn |

## Rules the code must keep

Each rule has a test or an e2e check. Read the reason before bending a rule.

1. **Never break the prompt cache.** Never mutate `systemPromptOptions`, return `systemPrompt`,
   or register, re-register or re-describe tools at runtime. Tool `description`,
   `promptSnippet` and `promptGuidelines` are static strings: no callsigns, counts or anything
   else that varies. Every model-facing text is appended, via a `before_agent_start` `message`,
   `pi.sendMessage`, a `tool_result` edit of the *current* result, or `agent_before_settle`
   entries. `npm run e2e:cache` proves it; re-run it when touching any of these.
2. **Solo work costs nothing.** No brief without peers. The `tool_call` guard returns before doing
   any work when there is no teammate, no peer history for the path, and no tainted view. Extra
   tokens and latency for a lone agent are bugs.
3. **Hooks never throw.** Register hooks with the local `on(...)`, never `pi.on(...)`. pi treats a
   throwing `tool_call` handler as a block, so the wrapper reports the error once and returns
   nothing: the guard **fails open**. Telecom is a teammate, not a security boundary.
4. **Start nothing at import or factory time.** pi loads extensions in invocations that never
   start a session, so the factory only registers things. No timers, processes, watchers or file
   I/O there: start them in `session_start` (which also re-reads the config).
   `session_shutdown` must be idempotent. Timers are `unref`'d.
5. **All state lives in the factory closure.** pi creates a new runtime on `/reload`, and the
   tests run many sessions in one process. Only id counters may live at module level.
6. **Keep the wire backward compatible.** Sessions on one machine can run *different* telecom
   versions during an upgrade. Add optional fields only, and have parsers ignore unknown fields.
   Changing the meaning of a field requires bumping `WIRE_VERSION`, and older and newer sessions
   then ignore each other's records.
7. **Peer data is untrusted model input.** Anything a peer writes (callsign, name, task, notes,
   paths, event data) passes through `parsePresence`/`parseEnvelope`, which validate it, flatten
   it to one line, and cap it. Never put raw peer text into a model message without `clip`.
8. **Information never wakes an idle agent.** Only direct messages, late answers and asks start
   turns, and `wake` respects `PI_TELECOM_MAX_WAKES`. A new passive kind must use `passive`.
9. **Every refusal says what happened and what to do next,** including the exact
   `telecom({ ... })` call when one helps. Models follow these literally; the live tests show it.
10. **Tool schema conventions:** string enums use `StringEnum` from `@earendil-works/pi-ai`
    (Google rejects unions of literals). Every result carries `structuredContent` equal to
    `details` (`outputSchema`: `{ ok, ... }`). Keep `annotations` accurate. Keep the description
    short, since every session pays for it in tokens.

## pi API facts this code relies on (pi 1.3)

- `pi.sendMessage(msg)` with no options **steers** the message in while the agent is streaming,
  and appends it without a turn while idle. With `{ triggerTurn: true }` it steers while
  streaming and starts a run while idle. `deliverAs: "nextTurn"` waits for the next user prompt.
- A `before_agent_start` `message` lands **after** the user prompt of that run, so it is safe for
  the cache.
- `session_shutdown.reason` is `quit`, `reload`, `new`, `resume` or `fork`. On `reload`, telecom
  keeps its presence record and inbox and parks state with `transport.writeHandoff()`. The new
  runtime takes it if it has the same pid and the handoff is less than 5 minutes old.
- Rebuild session state from `ctx.sessionManager.getBranch()`, not `getEntries()`, because
  abandoned branches aren't history.
- Call UI only through `ui()`, which returns `null` unless `ctx.hasUI`. Use `ctx.ui.theme` for
  colors, and rebuild themed strings on every refresh; never store them.
- The edit tool's `details.patch` and `details.firstChangedLine` feed change-notice excerpts.
- RPC mode (`pi --mode rpc`) runs extension commands with no model call. The e2e scripts drive it
  and read `extension_ui_request` records (`notify`, `setStatus`).

The docs ship with pi: `<pi install>/node_modules/@earendil-works/pi-coding-agent/docs/`, mainly
`extensions.md`, `packages.md` and `tui.md`, plus `examples/extensions/README.md` (Key Patterns).
The exact types are in `dist/core/extensions/types.d.ts`.

## Code style

- TypeScript, `strict`, **erasable syntax only**. Sources ship raw and Node strips the types, so
  no `enum`, `namespace` or constructor parameter properties. Relative imports carry `.ts`; use
  `import type` for types.
- No runtime dependencies. Host packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`,
  `typebox`) are `peerDependencies` with `"*"`, and `devDependencies` only for typechecking.
- Tabs, double quotes, trailing commas.
- Comments explain *why*, especially for anything a reader could "simplify" into a bug. Module
  headers say what the module owns.
- Name constants by meaning (`UNRESPONSIVE_MS`, not `TIMEOUT_2`) and keep them at the top of
  their module.

## Tests

- **Unit tests** (`test/units.test.ts`): pure modules and the transport against a scratch
  directory.
- **Scenario tests** (`test/team.test.ts`): real extension instances via `test/harness.ts`.
  - Each test calls `makeProject("p-<unique>")`, so tests can't see each other.
  - `session(dir)` starts a session and registers it for cleanup.
  - `eventually()` polls asynchronous delivery; never use a fixed `sleep` as the assertion.
  - The harness sets `PI_TELECOM_TICK_MS=20` and a scratch `PI_TELECOM_DIR` *before* importing
    the extension.
  - To simulate a different live process, write a presence record with `pid: process.ppid`.
- **Coverage:** a new behavior needs a scenario test, and a fix needs a test that fails without
  it. Anything that depends on pi's real lifecycle (reload, RPC, session ids) also needs a check
  in `scripts/e2e-rpc.mjs`.
- **Live scripts:** `run()` waits for idle, then for its *own* run's start and end. A peer's ask
  can wake an agent at any moment, so never wait for the next `agent_settled` alone.

## Releasing

1. Update `CHANGELOG.md`, bump `version` in `package.json`, and run `npm run check`. For changes
   that reach the model, also run `e2e:live` and `e2e:cache`.
2. Commit (Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`) and push `main`.
3. Publish: `npm publish --access public --otp=<code>`. The scope is the npm user `justar_96`.
   `prepublishOnly` runs the typecheck and tests. The tarball contains only `src/`, `README.md`,
   `CHANGELOG.md`, `LICENSE` and `package.json`. Check them with `npm pack --dry-run`.
4. Tag and release:
   `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z && gh release create vX.Y.Z`.
5. Verify in a clean config: `PI_CODING_AGENT_DIR=$(mktemp -d) pi install npm:@justar_96/pi-telecom`,
   then start two RPC sessions in one directory and check that `/telecom` lists both.
