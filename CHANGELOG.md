# Changelog

All notable changes to `@justar_96/pi-telecom`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The `telecom` tool's `action` and `scope` parameters use `StringEnum`, as pi's examples
  require. Google's API rejects the previous union-of-literals schema.
- A telecom hook that hits an internal error no longer blocks the tool it watches. pi treats a
  throwing `tool_call` handler as a block. Every hook now catches its own errors, reports them,
  and lets the tool run.

### Added

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

[Unreleased]: https://github.com/Justar96/pi-telecom/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Justar96/pi-telecom/releases/tag/v0.1.0
