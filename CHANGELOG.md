# Changelog

All notable changes to `@justar_96/pi-telecom`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-21

### Fixed

- The board showed the same id for agents started within the same minute (pi's session ids are
  UUIDv7, whose first characters are a timestamp). Ids now show their random tail, and `send` and
  `ask` accept that short form as well as the start of an id.
- A claim note ending in a period no longer prints as `note.. Peers …`.
- Event payloads from peers (change summaries and excerpts, claim patterns, paths, ask ids) are
  now validated, flattened to one line and capped before they reach the model, like presence
  records already were. Malformed payloads and unknown topics are ignored.
- `/telecom release` now tells the peers that were held back by the released claims, as the
  tool's `release` action already did.
- `/telecom broadcast` reports agents it could not reach.
- The `telecom` tool's `action` and `scope` parameters use `StringEnum`, as pi's examples
  require. Google's API rejects the previous union-of-literals schema.
- A telecom hook that hits an internal error no longer blocks the tool it watches. pi treats a
  throwing `tool_call` handler as a block. Every hook now catches its own errors, reports them,
  and lets the tool run.

### Added

- A real screenshot in the README, captured from two pi sessions (`npm run screenshots`).
- `npm run e2e:matrix`: the live scenario on every model in `scripts/lab-models.mjs` (Claude
  Opus 5.5 and GPT-6.1 Sol).
- In the transcript, wrapped lines in telecom messages keep their indent, and a change notice's
  diff excerpt is colored like pi's own diffs.
- Tool `annotations` (not read-only, not destructive, local only), so permission extensions
  don't ask for confirmation needlessly.
- `outputSchema` and `structuredContent` on every result, so codemode scripts get structured
  data. It isn't sent to the model, so it costs no tokens.
- Folded tool results: long results show 8 lines until expanded, and a pending `ask` shows
  "waiting for …".
- Themed footer status.
- The board lists at most 25 agents.
- `AGENTS.md` with the development guide.

### Changed

- Internal cleanup with no change to model-facing text: the static tool definition moved to
  `src/tool.ts` and change-notice text to `src/notices.ts`; each tool action is its own function;
  bounded maps share one helper; `PI_TELECOM_TICK_MS` is read in `config.ts` with the other knobs.
- UI calls are skipped in modes without a UI (`ctx.hasUI`).
- The callsign is restored from the active session branch (`getBranch()`), not from every entry.
- `@earendil-works/pi-ai` is declared as a peer dependency.
- The README is rewritten around what the agents see.

## [0.1.0] - 2026-10-21

First release.

- Callsigns and presence for every pi session in a project; team briefs, full first and then
  only what changed.
- Change notices when a peer edits a file this agent read or edited, or one inside its claim.
- An edit guard against overwriting a peer's change you haven't read, plus claims that hold
  peers back once and tell the owner.
- The `telecom` tool (`board`, `send`, `ask`, `reply`, `broadcast`, `status`, `claim`,
  `release`) and the `/telecom` command.
- Durable delivery: messages are removed from the inbox only after they're handled, and
  duplicates are handled once. `/reload` loses nothing, a session opened twice is detected, and
  presence repairs itself.
- Prompt cache unaffected: 84.4 % hit rate with and without telecom on Claude Sonnet 5.5.

[Unreleased]: https://github.com/Justar96/pi-telecom/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Justar96/pi-telecom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Justar96/pi-telecom/releases/tag/v0.1.0
