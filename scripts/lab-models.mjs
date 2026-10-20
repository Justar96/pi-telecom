/**
 * lab-models — the models live tests run on, and the only models docs and examples name.
 *
 * Rule (see AGENTS.md): name only these models in docs, examples and test results, and run the
 * live suites on them. When a lab ships a newer model, replace its entry, update `UPDATED`, and
 * re-run `npm run e2e:matrix` and `npm run e2e:cache`.
 *
 * `id` is the model id under the provider you test through. TELECOM_LIVE_PROVIDER supplies the
 * provider prefix (`<provider>/<id>`), and TELECOM_MATRIX_MODELS can override the whole list.
 */
export const UPDATED = "2026-10-21";

export const LAB_MODELS = [
	{ lab: "Anthropic", name: "Claude Opus 5.5", id: "claude-opus-5-5" },
	{ lab: "OpenAI", name: "GPT-6.1 Sol", id: "gpt-6.1-sol" },
];
