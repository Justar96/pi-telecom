/** Expand test files ourselves: cmd.exe does not expand shell globs. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../test/", import.meta.url))
	.filter((name) => /\.test\.(?:ts|mjs)$/.test(name))
	.sort()
	.map((name) => fileURLToPath(new URL(`../test/${name}`, import.meta.url)));
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "--test-timeout=120000", ...process.argv.slice(2), ...files], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
