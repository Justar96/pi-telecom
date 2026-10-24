/**
 * glob — what "this path is inside that claim" means.
 *
 * A claim pattern is written relative to the project root (or absolute):
 *   - a plain path claims that file, or everything under that directory: `src/auth`
 *   - `*` matches within one path segment, `?` one character, `**` any depth: `src/**\/*.test.ts`
 *   - `{a,b}` alternates: `src/{api,db}/**`
 * A trailing `/` or `/**` on a plain directory means the same thing as the bare directory.
 *
 * A pattern that starts with `@` (`@cargo`, `@runtime`) is a named RESOURCE, not a path: a lock
 * on something the team shares that is not a file (a build directory, the test runner, a port).
 * It matches no file and overlaps only the same resource, so the edit guard, change notices and
 * addressing by path never see it. Resource names are not filenames, so they compare without case.
 * An older telecom reads `@cargo` as the relative path `<checkout>/@cargo`: it matches no real file
 * (unless a folder by that name exists), overlaps the same name, and overlaps a claim on the whole
 * checkout (`.`, `**`), which only makes that older peer more careful.
 */
import { isAbsolute, normalize, parse, resolve, sep } from "node:path";
import { displayPath, isWithin } from "./project.ts";
import { escapeRegExp } from "./util.ts";

const GLOB_CHARS = /[*?[{]/;
/** A resource name: `@`, then a letter or digit, then letters, digits, `.`, `_` or `-`. */
const RESOURCE_NAME = /^@[a-z0-9][a-z0-9._-]{0,47}$/i;

/** Is this claim pattern a named resource (`@cargo`) rather than a path? Valid or not, it is never a path. */
export function isResource(pattern: string): boolean {
	return pattern.trim().startsWith("@");
}

/** Is `value` a well-formed resource name? Claims and peers' queue entries must be. */
export function isResourceName(value: unknown): value is string {
	return typeof value === "string" && RESOURCE_NAME.test(value);
}

/** The form a resource is stored and compared in: trimmed, lowercase. */
export function resourceKey(pattern: string): string {
	return pattern.trim().toLowerCase();
}

/** Do two claim patterns name the same resource? */
export function sameResource(a: string, b: string): boolean {
	return isResource(a) && isResource(b) && resourceKey(a) === resourceKey(b);
}

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
function globToRegExp(glob: string): RegExp {
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
	// A resource is the repository's, not a checkout's: it reads the same in every lane.
	if (isResource(pattern)) return resourceKey(pattern);
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
	if (isResource(pattern)) return () => false;
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
	if (isResource(a) || isResource(b)) return sameResource(a, b);
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
