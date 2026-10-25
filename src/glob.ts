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
import { basename, isAbsolute, normalize, parse, resolve, sep } from "node:path";
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

/** A claim as it reads: its pattern, and the checkout it binds in when its owner named one. */
export function claimShown(claim: { pattern: string; checkout?: string }): string {
	return claim.checkout ? `${claim.pattern} (in ${basename(claim.checkout)})` : claim.pattern;
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

/**
 * Do two claim patterns overlap: is there a path both claim? A claim covers what its pattern
 * matches and everything under that (`claimMatcher`), so this asks whether `a/**` and `b/**` share
 * a path, segment by segment. Exact, so a claim is refused only where the guard would hold an edit
 * back: `V1_1_14.sql` is clear of `V1_1_13*`, and `lib/x/y.ts` of `lib/*.ts`. A pattern with more
 * brace alternatives than `EXPANSIONS_CAP`, or `**` inside a segment, falls back to comparing the
 * fixed prefixes, which can only over-refuse.
 */
export function claimsOverlap(a: string, b: string, root: string): boolean {
	if (isResource(a) || isResource(b)) return sameResource(a, b);
	const left = absolutePattern(a, root);
	const right = absolutePattern(b, root);
	if (globIndex(left, root) === -1 && globIndex(right, root) === -1) return isWithin(left, right) || isWithin(right, left);
	const lefts = segmentsOf(left, root);
	const rights = segmentsOf(right, root);
	if (!lefts || !rights) return prefixesOverlap(left, right, root);
	return lefts.some((l) => rights.some((r) => segmentsOverlap(l, r)));
}

/** The conservative fallback: the fixed directory prefixes nest. */
function prefixesOverlap(left: string, right: string, root: string): boolean {
	const lp = staticPrefix(left, root);
	const rp = staticPrefix(right, root);
	return isWithin(lp, rp) || isWithin(rp, lp);
}

/** Brace alternatives one pattern may expand to before `claimsOverlap` falls back. */
const EXPANSIONS_CAP = 64;

/** One character position of a segment pattern. */
type Token = { kind: "char"; ch: string } | { kind: "any" } | { kind: "star" } | { kind: "class"; re: RegExp };
/** A path segment pattern, or `**` (any number of segments). */
type Segment = "**" | Token[];

/**
 * An anchored pattern as segment lists, one per brace alternative, each ending in `**` (a claim
 * covers what is under what it names). `null` when it is beyond the exact check.
 */
function segmentsOf(anchored: string, root: string): Segment[][] | null {
	const literal = literalRootLength(anchored, root);
	const alternatives = expandBraces(anchored.slice(literal));
	if (!alternatives) return null;
	const out: Segment[][] = [];
	for (const alternative of alternatives) {
		const segments = toSegments(anchored.slice(0, literal), alternative);
		if (!segments) return null;
		out.push([...segments, "**"]);
	}
	return out;
}

/** `{a,b}` alternatives expanded, nested ones included; `null` past the cap or when unbalanced. */
function expandBraces(glob: string): string[] | null {
	const open = glob.indexOf("{");
	if (open === -1) return [glob];
	const options: string[] = [];
	let depth = 0;
	let start = open + 1;
	let close = -1;
	for (let i = open + 1; i < glob.length && close === -1; i++) {
		const ch = glob[i];
		if (ch === "{") depth++;
		else if (ch === "}" && depth > 0) depth--;
		else if (ch === "}") close = i;
		else if (ch === "," && depth === 0) {
			options.push(glob.slice(start, i));
			start = i + 1;
		}
	}
	if (close === -1) return null;
	options.push(glob.slice(start, close));
	const out: string[] = [];
	for (const option of options) {
		const rest = expandBraces(`${glob.slice(0, open)}${option}${glob.slice(close + 1)}`);
		if (!rest) return null;
		out.push(...rest);
		if (out.length > EXPANSIONS_CAP) return null;
	}
	return out;
}

/** Split into segments: the literal root's characters stay literal, the rest is glob syntax. */
function toSegments(literal: string, glob: string): Segment[] | null {
	const segments: Segment[] = [];
	let current: Token[] = [];
	let raw = "";
	const end = (): boolean => {
		if (raw === "**") segments.push("**");
		else if (raw.includes("**")) return false;
		else segments.push(current);
		current = [];
		raw = "";
		return true;
	};
	for (const ch of literal) {
		if (ch === "/") {
			if (!end()) return null;
		} else {
			current.push({ kind: "char", ch });
			// Literal characters never form a `**`.
			raw += ch === "*" ? "\u0000" : ch;
		}
	}
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "/") {
			if (!end()) return null;
			continue;
		}
		raw += ch;
		if (ch === "*") current.push({ kind: "star" });
		else if (ch === "?") current.push({ kind: "any" });
		else if (ch === "[" && glob.indexOf("]", i + 1) !== -1) {
			const close = glob.indexOf("]", i + 1);
			const body = glob.slice(i + 1, close);
			current.push({ kind: "class", re: new RegExp(`^[${body.replace(/^!/, "^").replace(/\\/g, "\\\\")}]$`) });
			raw += body;
			i = close;
		} else current.push({ kind: "char", ch });
	}
	return end() ? segments : null;
}

/** Is there one list of path segments both match? `**` matches any number of segments. */
function segmentsOverlap(a: readonly Segment[], b: readonly Segment[]): boolean {
	return sequencesOverlap(a, b, (x) => x === "**", (x, y) => tokensOverlap(x as Token[], y as Token[]));
}

/** Is there one segment both match? `*` matches any run of characters. */
function tokensOverlap(a: readonly Token[], b: readonly Token[]): boolean {
	return sequencesOverlap(a, b, (x) => x.kind === "star", charsOverlap);
}

function charsOverlap(a: Token, b: Token): boolean {
	if (a.kind === "any" || b.kind === "any") return true;
	if (a.kind === "char" && b.kind === "char") return a.ch === b.ch;
	if (a.kind === "char" && b.kind === "class") return b.re.test(a.ch);
	if (a.kind === "class" && b.kind === "char") return a.re.test(b.ch);
	// Two classes: rare enough to assume they share a character.
	return true;
}

/**
 * Do two patterns (sequences of single items and `rest` wildcards that match any run of items)
 * match a common sequence? `rest` items are assumed to match anything, and single items to be
 * satisfiable. Memoised over positions, so it is quadratic at worst.
 */
function sequencesOverlap<T>(a: readonly T[], b: readonly T[], rest: (x: T) => boolean, single: (x: T, y: T) => boolean): boolean {
	const memo = new Map<number, boolean>();
	const go = (i: number, j: number): boolean => {
		const key = i * (b.length + 1) + j;
		const known = memo.get(key);
		if (known !== undefined) return known;
		let result: boolean;
		if (i === a.length && j === b.length) result = true;
		else if (i < a.length && rest(a[i] as T)) result = go(i + 1, j) || (j < b.length && go(i, j + 1));
		else if (j < b.length && rest(b[j] as T)) result = go(i, j + 1) || (i < a.length && go(i + 1, j));
		else if (i === a.length || j === b.length) result = false;
		else result = single(a[i] as T, b[j] as T) && go(i + 1, j + 1);
		memo.set(key, result);
		return result;
	};
	return go(0, 0);
}

/** The directory part of a glob before its first wildcard. */
function staticPrefix(glob: string, root: string): string {
	const index = globIndex(glob, root);
	const head = index === -1 ? glob : glob.slice(0, index);
	return atLeastVolume(head.slice(0, head.lastIndexOf("/")), glob);
}
