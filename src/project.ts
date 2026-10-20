/**
 * project — what "the same project" means, and one canonical spelling for every path.
 *
 * Two agents share a project when they share a project root: the nearest ancestor of their
 * working directory holding a `.git` entry (a directory, or the file a worktree or submodule
 * uses), or the working directory itself when there is none. Each git worktree is its own
 * project, because its files are its own; agents in sibling worktrees still see each other with
 * `scope: "machine"`.
 *
 * Paths are compared in one canonical form — `@`-prefix stripped and `~` expanded the way pi's
 * own tools do it, resolved against the session cwd, and symlinks resolved — so `src/a.ts`
 * typed in one session and `/home/me/proj/src/a.ts` typed in another are the same key.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

function real(path: string): string {
	try {
		return realpathSync(path);
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

/** The checked-out branch of a project root, read from git's own files (no git process). */
export function readBranch(root: string): string | undefined {
	try {
		let gitDir = join(root, ".git");
		if (statSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
			if (!pointer) return undefined;
			gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
		}
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
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	const absolute = resolve(cwd, path);
	try {
		return realpathSync(absolute);
	} catch {
		const tail: string[] = [];
		let dir = absolute;
		for (;;) {
			tail.unshift(basename(dir));
			const parent = dirname(dir);
			if (parent === dir) return normalize(absolute);
			dir = parent;
			try {
				return join(realpathSync(dir), ...tail);
			} catch {
				/* keep walking up */
			}
		}
	}
}

/** True when `path` is `root` or sits underneath it (segment-wise, so /a/bc is not in /a/b). */
export function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A path as a human reads it on the board: project-relative when inside the project. */
export function displayPath(path: string, root: string): string {
	if (!isWithin(path, root)) return path;
	const rel = relative(root, path);
	return rel === "" ? "." : rel.split(sep).join("/");
}
