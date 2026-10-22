/**
 * glob — what "this path is inside that claim" means.
 *
 * A claim pattern is written relative to the project root (or absolute):
 *   - a plain path claims that file, or everything under that directory: `src/auth`
 *   - `*` matches within one path segment, `?` one character, `**` any depth: `src/**\/*.test.ts`
 *   - `{a,b}` alternates: `src/{api,db}/**`
 * A trailing `/` or `/**` on a plain directory means the same thing as the bare directory.
 */
import { isAbsolute, normalize, parse, resolve, sep } from "node:path";
import { displayPath, isWithin } from "./project.ts";
import { escapeRegExp } from "./util.ts";

const GLOB_CHARS = /[*?[{]/;

/** Glob syntax always uses `/`; native Windows inputs accept either separator. Do not rewrite
 *  backslashes on POSIX, where they can be literal filename characters. */
function globPath(path: string): string {
	let native = normalize(path);
	if (sep === "\\") native = native.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
	const normalized = native.split(sep).join("/");
	return sep === "\\" ? normalized.replace(/^[a-z]:/i, (drive) => drive.toUpperCase()) : normalized;
}

/** Only the user-supplied pattern is glob syntax. A checkout named `repo [copy]` is literal. */
function literalRootLength(pattern: string, root: string): number {
	const base = globPath(resolve(root));
	return pattern === base || pattern.startsWith(base.endsWith("/") ? base : `${base}/`) ? base.length : 0;
}

/** Where the glob syntax in an anchored pattern starts (past the literal root); -1 for a plain path. */
function globIndex(anchored: string, root: string): number {
	const literal = literalRootLength(anchored, root);
	const found = anchored.slice(literal).search(GLOB_CHARS);
	return found === -1 ? -1 : found + literal;
}

/** Stripping a tail must not turn C:/ into the drive-relative C:, or lose a UNC share root. */
function atLeastVolume(path: string, of: string): string {
	const volume = globPath(parse(of).root);
	return path.length < volume.length ? volume : path;
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
	const joined = resolve(root, trimmed);
	return atLeastVolume(globPath(joined).replace(/\/+$/, "").replace(/\/\*\*$/, ""), joined);
}

/**
 * A claim as it reads from another checkout of the same repository: relative to its owner's
 * checkout, so the same pattern names the same files of the repository in every lane. `null` for
 * an absolute pattern outside the owner's checkout.
 */
export function laneRelativePattern(pattern: string, ownerRoot: string): string | null {
	const trimmed = globPath(pattern.trim()).replace(/^\.\//, "");
	if (!isAbsolute(trimmed)) return trimmed;
	return isWithin(trimmed, ownerRoot) ? displayPath(trimmed, ownerRoot) : null;
}

/** Does an absolute file path fall inside a claim pattern? */
export function matchesClaim(path: string, pattern: string, root: string): boolean {
	return claimMatcher(pattern, root)(path);
}

/** `matchesClaim` with the pattern compiled once, for testing many paths against one claim. */
export function claimMatcher(pattern: string, root: string): (path: string) => boolean {
	const anchored = absolutePattern(pattern, root);
	const literal = literalRootLength(anchored, root);
	const glob = anchored.slice(literal);
	if (!GLOB_CHARS.test(glob)) return (path) => isWithin(globPath(resolve(root, path)), anchored);
	const prefix = escapeRegExp(anchored.slice(0, literal));
	const regex = new RegExp(`^${prefix}${globToRegExp(glob).source.slice(1)}`);
	return (path) => {
		const normalized = globPath(resolve(root, path));
		if (regex.test(normalized)) return true;
		// A glob naming directories (`src/*/internal`) also claims what is under them.
		let dir = normalized;
		while (dir.includes("/")) {
			dir = dir.slice(0, dir.lastIndexOf("/"));
			if (dir && regex.test(dir)) return true;
		}
		return false;
	};
}

/** Do two claim patterns overlap? Exact for plain paths; conservative for globs. */
export function claimsOverlap(a: string, b: string, root: string): boolean {
	const left = absolutePattern(a, root);
	const right = absolutePattern(b, root);
	const leftGlob = globIndex(left, root) !== -1;
	const rightGlob = globIndex(right, root) !== -1;
	if (!leftGlob && !rightGlob) return isWithin(left, right) || isWithin(right, left);
	// A plain path overlaps a glob when the glob matches it, when the plain path is a directory the
	// glob reaches into, or when the plain path sits under the glob's fixed prefix (conservative:
	// something under it could match).
	if (!leftGlob) return plainOverlapsGlob(left, right, root);
	if (!rightGlob) return plainOverlapsGlob(right, left, root);
	const lp = staticPrefix(left, root);
	const rp = staticPrefix(right, root);
	return isWithin(lp, rp) || isWithin(rp, lp);
}

function plainOverlapsGlob(plain: string, glob: string, root: string): boolean {
	const prefix = staticPrefix(glob, root);
	return matchesClaim(plain, glob, root) || isWithin(prefix, plain) || isWithin(plain, prefix);
}

/** The directory part of a glob before its first wildcard. */
function staticPrefix(glob: string, root: string): string {
	const index = globIndex(glob, root);
	const head = index === -1 ? glob : glob.slice(0, index);
	return atLeastVolume(head.slice(0, head.lastIndexOf("/")), glob);
}
