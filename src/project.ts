/**
 * project — what "the same project" means, and one canonical spelling for every path.
 *
 * An agent's project root (its CHECKOUT) is the nearest ancestor of its working directory holding
 * a `.git` entry (a directory, or the file a worktree or submodule uses), or the working directory
 * itself when there is none. Checkouts that share a git common directory — the main checkout and
 * its worktrees — belong to one REPOSITORY, and the agents in them are one team. Each checkout is
 * a LANE: its files are its own, so the edit guard works within a lane, while claims and
 * overlapping edits are compared across lanes by their repository-relative path.
 *
 * Paths are compared in one canonical form — `@`-prefix stripped and `~` expanded the way pi's
 * own tools do it, resolved against the session cwd, and symlinks resolved — so `src/a.ts`
 * typed in one session and `/home/me/proj/src/a.ts` typed in another are the same key.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Use the OS spelling (including case/Unicode aliases on macOS and Windows), without folding
 *  names ourselves: case-sensitive volumes may contain both spellings as distinct files. */
function realExisting(path: string): string {
	return process.platform === "win32" || process.platform === "darwin" ? realpathSync.native(path) : realpathSync(path);
}

function real(path: string): string {
	try {
		return realExisting(path);
	} catch {
		return normalize(path);
	}
}

/** The project root for a working directory. */
export function findProjectRoot(cwd: string): string {
	const start = real(resolve(cwd));
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** The git directory of a checkout: `.git` itself, or where a worktree's or submodule's `.git`
 *  file points. `null` outside git. */
function gitDirOf(root: string): string | null {
	const dotGit = join(root, ".git");
	try {
		if (!statSync(dotGit).isFile()) return dotGit;
		const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim();
		return pointer ? resolve(root, pointer) : null;
	} catch {
		return null;
	}
}

/**
 * The repository a checkout belongs to: its git common directory, which the main checkout and
 * every worktree share (`<main>/.git`; a worktree's git dir names it in its `commondir` file).
 * A submodule's git dir has no `commondir`, so a submodule is a repository of its own, and so is
 * a folder outside git.
 */
export function findRepo(root: string): string {
	const gitDir = gitDirOf(root);
	if (!gitDir) return root;
	try {
		return real(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
	} catch {
		return real(gitDir);
	}
}

/** Where an agent works, as far as grouping goes. `repo` is optional on the wire: a peer without
 *  it (an older telecom) is grouped by its checkout alone. */
export interface Lane {
	projectRoot: string;
	repo?: string;
}

/** Teammates: the same checkout, or checkouts of one repository. */
export function sameRepo(a: Lane, b: Lane): boolean {
	return a.projectRoot === b.projectRoot || (a.repo !== undefined && a.repo === b.repo);
}

/** How a peer's checkout reads to someone in another lane of the repository. */
export function laneName(peer: Lane): string {
	// The main checkout holds the common directory itself, as its `.git`.
	return peer.repo === join(peer.projectRoot, ".git") ? `the main checkout (${peer.projectRoot})` : `worktree ${peer.projectRoot}`;
}

/** Another checkout of `of`'s repository, as a lane: where a peer works when it left its own. */
export function laneIn(checkout: string, of: Lane): Lane {
	return { projectRoot: checkout, ...(of.repo ? { repo: of.repo } : {}) };
}

/**
 * The file in checkout `to` that `path`, touched by a session in checkout `from`, stands for.
 * A path that physically belongs to `to` is `to`'s own file, returned as is: the session reached
 * into `to` (an absolute path, or `to` nested in `from`, like `/repo/.worktrees/wt`). A path that
 * belongs to `from` stands for the same repository path in `to`, its copy there. `null` when
 * `path` is in neither. A path inside both belongs to the deeper checkout.
 */
export function inCheckout(path: string, from: string, to: string): string | null {
	const inTo = isWithin(path, to);
	const inFrom = isWithin(path, from);
	if (inTo && (!inFrom || isWithin(to, from))) return path;
	if (!inFrom) return null;
	return join(to, relative(from, path));
}

/** Where a file lies in a repository: the checkout that physically holds it, and its path there. */
export interface Place {
	checkout: string;
	rel: string;
}

/** A directory's nearest checkout and that checkout's repository, as `placeOf` caches them. */
export type PlaceCache = Map<string, { checkout: string; repo: string } | null>;
const PLACE_CACHE_CAP = 1_024;

/**
 * Where `path` lies in `lane`'s repository. An agent's checkout is where it STARTED, but it may
 * edit any worktree of the repository (a common setup: start in the main checkout, work in
 * `../repo-<agent>`), so the checkout is found from the file itself: the nearest folder holding
 * `.git` (a worktree nested in another wins), when it belongs to the repository. Otherwise a path
 * inside the lane's own checkout (a submodule, a folder outside git) is placed there, and
 * anything else is in no checkout of the repository: `null`. `cache` saves the walk per folder.
 */
export function placeOf(path: string, lane: Lane, cache?: PlaceCache): Place | null {
	const dir = dirname(path);
	let found = cache?.get(dir);
	if (found === undefined) {
		found = null;
		for (let at = dir; ; at = dirname(at)) {
			if (existsSync(join(at, ".git"))) {
				found = { checkout: at, repo: findRepo(at) };
				break;
			}
			if (dirname(at) === at) break;
		}
		if (cache) {
			if (cache.size >= PLACE_CACHE_CAP) cache.clear();
			cache.set(dir, found);
		}
	}
	if (found && (found.checkout === lane.projectRoot || (lane.repo !== undefined && found.repo === lane.repo))) {
		return { checkout: found.checkout, rel: relative(found.checkout, path) };
	}
	return isWithin(path, lane.projectRoot) ? { checkout: lane.projectRoot, rel: relative(lane.projectRoot, path) } : null;
}

/**
 * Where an agent works now: the checkout of its newest edit in the repository, else where it
 * started. An edit outside the repository (shared notes, a scratch script) says nothing of it.
 */
export function workingCheckout(agent: Lane & { recent: readonly { path: string; at: number }[] }, cache?: PlaceCache): string {
	let newest: { at: number; checkout: string } | null = null;
	for (const r of agent.recent) {
		const place = placeOf(r.path, agent, cache);
		if (place && (!newest || r.at > newest.at)) newest = { at: r.at, checkout: place.checkout };
	}
	return newest?.checkout ?? agent.projectRoot;
}

/** The checked-out branch of a project root, read from git's own files (no git process). */
export function readBranch(root: string): string | undefined {
	try {
		const gitDir = gitDirOf(root);
		if (!gitDir) return undefined;
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
		return ref ?? (head.length >= 7 ? `detached@${head.slice(0, 7)}` : undefined);
	} catch {
		return undefined;
	}
}

/**
 * The canonical absolute form of a path a tool was called with. A path that does not exist yet
 * keeps its basename and has its nearest existing ancestor resolved, so a file created later
 * still has the same key it had at creation time.
 */
export function canonicalPath(input: string, cwd: string): string {
	let path = input.trim().replace(/^@/, "");
	if (process.platform === "win32") {
		// pi also accepts Git Bash/MSYS, WSL and Cygwin drive paths on native Windows.
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
		if (drive && !path.includes("\\")) path = `${drive[1]!.toUpperCase()}:/${drive[2] ?? ""}`;
	}
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
	if (path.startsWith("file://")) path = fileURLToPath(path);
	const absolute = resolve(cwd, path);
	try {
		return realExisting(absolute);
	} catch {
		const tail: string[] = [];
		let dir = absolute;
		for (;;) {
			tail.unshift(basename(dir));
			const parent = dirname(dir);
			if (parent === dir) return normalize(absolute);
			dir = parent;
			try {
				return join(realExisting(dir), ...tail);
			} catch {
				/* keep walking up */
			}
		}
	}
}

/** True when `path` is `root` or sits underneath it (segment-wise, so /a/bc is not in /a/b). */
export function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A path as a human reads it on the board: project-relative when inside the project. */
export function displayPath(path: string, root: string): string {
	if (!isWithin(path, root)) return path;
	const rel = relative(root, path);
	return rel === "" ? "." : rel.split(sep).join("/");
}
