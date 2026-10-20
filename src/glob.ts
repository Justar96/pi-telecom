/**
 * glob — what "this path is inside that claim" means.
 *
 * A claim pattern is written relative to the project root (or absolute):
 *   - a plain path claims that file, or everything under that directory: `src/auth`
 *   - `*` matches within one path segment, `?` one character, `**` any depth: `src/**\/*.test.ts`
 *   - `{a,b}` alternates: `src/{api,db}/**`
 * A trailing `/` or `/**` on a plain directory means the same thing as the bare directory.
 */
import { isAbsolute, join, normalize } from "node:path";
import { isWithin } from "./project.ts";

const GLOB_CHARS = /[*?[{]/;

function escapeRegExp(text: string): string {
	return text.replace(/[.+^$()|\\\]]/g, "\\$&");
}

/** Translate a glob into an anchored regular expression over absolute posix paths. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let inGroup = 0;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const slashAfter = glob[i + 2] === "/";
				out += slashAfter ? "(?:.*/)?" : ".*";
				i += slashAfter ? 2 : 1;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "[") {
			const close = glob.indexOf("]", i + 1);
			if (close === -1) {
				out += "\\[";
			} else {
				out += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
				i = close;
			}
		} else if (ch === "{") {
			inGroup++;
			out += "(?:";
		} else if (ch === "}" && inGroup > 0) {
			inGroup--;
			out += ")";
		} else if (ch === "," && inGroup > 0) {
			out += "|";
		} else {
			out += escapeRegExp(ch);
		}
	}
	return new RegExp(`^${out}$`);
}

/** A claim pattern, anchored at the project root. */
export function absolutePattern(pattern: string, root: string): string {
	const trimmed = pattern.trim().replace(/^\.\//, "");
	const joined = isAbsolute(trimmed) ? trimmed : join(root, trimmed);
	// normalize() would collapse "**" segments harmlessly but strips a trailing slash we ignore anyway.
	return normalize(joined).replace(/\/+$/, "").replace(/\/\*\*$/, "") || "/";
}

/** Does an absolute file path fall inside a claim pattern? */
export function matchesClaim(path: string, pattern: string, root: string): boolean {
	const anchored = absolutePattern(pattern, root);
	if (!GLOB_CHARS.test(anchored)) return isWithin(path, anchored);
	const regex = globToRegExp(anchored);
	if (regex.test(path)) return true;
	// A glob naming directories (`src/*/internal`) also claims what is under them.
	let dir = path;
	while (dir.includes("/")) {
		dir = dir.slice(0, dir.lastIndexOf("/"));
		if (dir && regex.test(dir)) return true;
	}
	return false;
}

/** Do two claim patterns overlap? Exact for plain paths; conservative for globs. */
export function claimsOverlap(a: string, b: string, root: string): boolean {
	const left = absolutePattern(a, root);
	const right = absolutePattern(b, root);
	const leftGlob = GLOB_CHARS.test(left);
	const rightGlob = GLOB_CHARS.test(right);
	if (!leftGlob && !rightGlob) return isWithin(left, right) || isWithin(right, left);
	// A plain path overlaps a glob when the glob matches it, when the plain path is a directory the
	// glob reaches into, or when the plain path sits under the glob's fixed prefix (conservative:
	// something under it could match).
	if (!leftGlob) return plainOverlapsGlob(left, right, root);
	if (!rightGlob) return plainOverlapsGlob(right, left, root);
	const lp = staticPrefix(left);
	const rp = staticPrefix(right);
	return isWithin(lp, rp) || isWithin(rp, lp);
}

function plainOverlapsGlob(plain: string, glob: string, root: string): boolean {
	const prefix = staticPrefix(glob);
	return matchesClaim(plain, glob, root) || isWithin(prefix, plain) || isWithin(plain, prefix);
}

/** The directory part of a glob before its first wildcard. */
function staticPrefix(glob: string): string {
	const index = glob.search(GLOB_CHARS);
	const head = index === -1 ? glob : glob.slice(0, index);
	return head.includes("/") ? head.slice(0, head.lastIndexOf("/")) || "/" : "/";
}
