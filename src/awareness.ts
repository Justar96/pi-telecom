/**
 * awareness — what this agent has seen of the tree, and what its peers changed underneath it.
 *
 * The agent's VIEW of a file is the fingerprint the file had when this agent last read or wrote
 * it. A peer's CHANGE is a `file.changed` event it pushed (or an entry in its presence record's
 * recent-edits list, for changes made before this session started listening). Comparing the two
 * answers the question every parallel agent needs answered before it touches a file: "did
 * someone else move this since I looked at it?"
 *
 * Views and changes are per CHECKOUT: a peer in another worktree of the repository edits its own
 * copy of a file, so nothing here goes stale. What two lanes share is the merge, so a lane change
 * to a file this agent also changed is noted once (`checkLanes`, `noteLaneChange`), and a claim
 * made in another lane is advisory: the edit goes through with a note, and the owner is told.
 *
 * Only changes attributable to a PEER are acted on. A file that moved for another reason — this
 * agent's own `bash` (a formatter, `sed -i`), the human's editor — is left alone, exactly as pi
 * would leave it without this extension. Telecom adds teamwork; it does not add a second opinion
 * on solo work.
 *
 * The verdicts are pure decisions; the caller performs the blocking, the warning and the
 * notifications.
 */
import { join } from "node:path";
import type { GuardMode } from "./config.ts";
import { matchesClaim } from "./glob.ts";
import { displayPath, laneIn, laneName, type Place, type PlaceCache, placeOf, sameRepo, workingCheckout } from "./project.ts";
import type { Claim, Presence } from "./transport.ts";
import { ago, fileFingerprint, setBounded } from "./util.ts";

export interface PeerChange {
	peerId: string;
	callsign: string;
	path: string;
	op: "edit" | "write";
	at: number;
	summary?: string;
}

interface View {
	fingerprint: string | null;
	at: number;
	via: "read" | "edit" | "write";
	/** A change notice for this file has been shown since the view was taken. */
	notified: boolean;
	/** The view is still in the model's context (false after a compaction summarised it away). */
	inContext: boolean;
	/** This agent edited the file AFTER a peer's change it never read: its bytes are current, but
	 *  the model's picture of the file is not, so a whole-file write must still re-read first. */
	tainted?: PeerChange;
}

export type Relation = "read" | "edited";

/** A claim a peer ran into: its owner is told. `lane` when the peer is in another checkout. */
export interface Contest {
	owner: Presence;
	claim: Claim;
	lane?: boolean;
}

/**
 * A guard verdict. A warning's one-time parts (`laneNotes`, a lane `contested`) are only proposed:
 * the caller commits them once the call has succeeded (`commitLaneNotes`, `noteContested`), so a
 * call that is blocked later or fails does not use them up.
 */
export type Verdict =
	| { action: "allow" }
	| { action: "warn"; note: string; staleChange?: PeerChange; contested?: Contest; laneNotes?: string[] }
	| { action: "block"; reason: string; contested?: Contest };

/** A peer change older than this, on a file this agent never looked at, is history, not news. */
const UNSEEN_WINDOW_MS = 30 * 60_000;
/** Peer events travel through the inbox; allow for that latency when ordering view vs. change. */
const CLOCK_GRACE_MS = 1_500;
/** A claim warning is shown once; the same agent retrying within this window goes through. */
const CONTEST_WINDOW_MS = 10 * 60_000;
/** A plain read older than this no longer earns a change notice (the guard still protects it). */
const READ_RELEVANCE_MS = 60 * 60_000;
/** A peer that has not refreshed its record for this long is treated as unresponsive. */
export const UNRESPONSIVE_MS = 45_000;
/** Consecutive stale blocks on one change before the guard steps aside (never loop forever). */
const MAX_STALE_BLOCKS = 2;
const CHANGE_CAP = 512;

export class Awareness {
	private readonly views = new Map<string, View>();
	private readonly changes = new Map<string, PeerChange>();
	private readonly contested = new Map<string, number>();
	private readonly staleBlocks = new Map<string, { changeAt: number; count: number }>();
	/** Peer and path pairs already told about a change in another lane: once is enough. */
	private readonly laneNoted = new Map<string, true>();
	/** Each folder's checkout, so placing a path does not walk the tree on every tool call. */
	private readonly places: PlaceCache = new Map();

	/** Where `path` lies in `lane`'s repository (see `placeOf`). */
	placeOf(path: string, lane: Presence): Place | null {
		return placeOf(path, lane, this.places);
	}

	/** The checkouts an agent works in: where it started, and wherever its recent edits landed. */
	checkoutsOf(lane: Presence): Set<string> {
		const out = new Set([lane.projectRoot]);
		for (const r of lane.recent) {
			const place = this.placeOf(r.path, lane);
			if (place) out.add(place.checkout);
		}
		return out;
	}

	noteRead(path: string): void {
		this.views.set(path, {
			fingerprint: fileFingerprint(path),
			at: Date.now(),
			via: "read",
			notified: false,
			inContext: true,
		});
		this.staleBlocks.delete(path);
	}

	/** Record this agent's own successful change. `staleOver` is the peer change it edited on top
	 *  of without reading; a full rewrite of a stale file (`write`) clears the taint by definition. */
	noteOwnWrite(path: string, op: "edit" | "write", staleOver?: PeerChange): void {
		const prior = this.views.get(path);
		const tainted = op === "edit" ? (staleOver ?? prior?.tainted) : undefined;
		this.views.set(path, {
			fingerprint: fileFingerprint(path),
			at: Date.now(),
			via: op,
			notified: false,
			inContext: true,
			...(tainted ? { tainted } : {}),
		});
		this.staleBlocks.delete(path);
	}

	/** After a compaction the files read before it are no longer in the model's context, so a peer
	 *  changing them is not news worth a notice. The guard keeps using the views. */
	markCompacted(): void {
		for (const view of this.views.values()) view.inContext = false;
	}

	hasView(path: string): boolean {
		return this.views.has(path);
	}

	/** Has a peer ever touched this path as far as this agent knows, or is its view tainted? */
	hasPeerContext(path: string): boolean {
		return this.changes.has(path) || this.views.get(path)?.tainted !== undefined;
	}

	viewedPaths(): string[] {
		return [...this.views.keys()];
	}

	/** The files this agent works with: the ones a peer's change to would earn a notice. */
	focusPaths(now = Date.now()): Set<string> {
		const paths = new Set<string>();
		for (const [path, view] of this.views) {
			if (view.inContext && (view.via !== "read" || now - view.at <= READ_RELEVANCE_MS)) paths.add(path);
		}
		return paths;
	}

	/**
	 * Record a peer's change. Returns how this agent relates to the file and whether this is the
	 * first notice since this agent last looked at it — further edits by the peer do not change
	 * the advice ("re-read it"), so they are not worth another interruption.
	 */
	notePeerChange(change: PeerChange): { relation: Relation | null; firstNotice: boolean } {
		setBounded(this.changes, change.path, change, CHANGE_CAP);
		const view = this.views.get(change.path);
		if (!view || !view.inContext) return { relation: null, firstNotice: false };
		if (view.via === "read" && Date.now() - view.at > READ_RELEVANCE_MS) return { relation: null, firstNotice: false };
		const firstNotice = !view.notified;
		view.notified = true;
		return { relation: view.via === "read" ? "read" : "edited", firstNotice };
	}

	/**
	 * A peer in another checkout changed its copy of the file at `path` (this agent's copy). Worth
	 * a notice once per peer and file, and only when this agent changed its own copy: a read is no
	 * conflict, since the files are separate. Never recorded as a peer change to `path` — its
	 * bytes did not move, so the guard has nothing to say about it.
	 */
	noteLaneChange(peerId: string, path: string): boolean {
		const view = this.views.get(path);
		if (!view || view.via === "read") return false;
		return this.firstLaneNote(peerId, path);
	}

	private firstLaneNote(peerId: string, path: string): boolean {
		const key = `${peerId}\u0000${path}`;
		if (this.laneNoted.has(key)) return false;
		setBounded(this.laneNoted, key, true, CHANGE_CAP);
		return true;
	}

	/** The lane notes a successful call showed: each is told once. */
	commitLaneNotes(keys: readonly string[]): void {
		for (const key of keys) setBounded(this.laneNoted, key, true, CHANGE_CAP);
	}

	/** A claim's owner was told about an edit to `path`: not again within the contest window. */
	noteContested(ownerId: string, path: string): void {
		this.contested.set(`${ownerId}\u0000${path}`, Date.now());
	}

	/**
	 * Has a peer in another checkout of the repository changed this same file there? Nothing is
	 * stale here, so this never blocks; it notes, once per peer and file, that the two changes
	 * will meet when the branches merge.
	 */
	checkLanes(path: string, peers: readonly Presence[], self: Presence): Verdict {
		// Lanes are told apart by where the files lie, not where the agents started: two agents
		// started in one checkout may each work in a worktree of their own.
		const mine = this.placeOf(path, self);
		if (!mine) return { action: "allow" };
		const lines: string[] = [];
		const keys: string[] = [];
		let first: string | null = null;
		for (const peer of peers) {
			if (peer.id === self.id || !sameRepo(peer, self)) continue;
			let hit: { op: "edit" | "write"; at: number; checkout: string } | undefined;
			for (const r of peer.recent) {
				const theirs = this.placeOf(r.path, peer);
				// The very same file (one checkout): the stale check covers it.
				if (theirs && theirs.checkout !== mine.checkout && theirs.rel === mine.rel) {
					hit = { op: r.op, at: r.at, checkout: theirs.checkout };
					break;
				}
			}
			const key = `${peer.id}\u0000${path}`;
			if (!hit || this.laneNoted.has(key)) continue;
			keys.push(key);
			first ??= peer.callsign;
			lines.push(`${peer.callsign} ${hit.op === "write" ? "rewrote" : "edited"} its copy ${ago(hit.at)}, in ${laneName(laneIn(hit.checkout, peer))}`);
		}
		if (!first) return { action: "allow" };
		return {
			action: "warn",
			note: `⚠ telecom: ${displayPath(path, mine.checkout)} — ${lines.join("; ")}. Your checkouts are separate, so this went through, but the two changes meet when the branches merge. If they may conflict, agree on one owner: telecom({ action: "send", to: "${first}", message: "…" }).`,
			laneNotes: keys,
		};
	}

	/** The latest peer change to `path`, from pushed events or from live peers' records. */
	latestPeerChange(path: string, peers: readonly Presence[], selfId: string): PeerChange | null {
		let best = this.changes.get(path) ?? null;
		if (best && best.peerId === selfId) best = null;
		for (const peer of peers) {
			if (peer.id === selfId) continue;
			for (const recent of peer.recent) {
				if (recent.path !== path) continue;
				if (!best || recent.at > best.at) {
					best = { peerId: peer.id, callsign: peer.callsign, path, op: recent.op, at: recent.at };
				}
			}
		}
		return best;
	}

	/**
	 * Is this agent about to act on a stale picture of `path`? Only a change by a PEER after this
	 * agent's last view counts, and only when the bytes on disk actually differ from that view.
	 */
	checkStale(
		path: string,
		tool: "edit" | "write",
		mode: GuardMode,
		peers: readonly Presence[],
		selfId: string,
		root: string,
	): Verdict {
		if (mode === "off") return { action: "allow" };
		const view = this.views.get(path);
		const shown = displayPath(path, root);
		if (view?.tainted && tool === "write") {
			const t = view.tainted;
			return this.block(path, t, tool, mode, `you edited ${shown} on top of ${t.callsign}'s change (${ago(t.at)}) without re-reading it, so your picture of the file is out of date`, shown);
		}
		const change = this.latestPeerChange(path, peers, selfId);
		if (!change) return { action: "allow" };
		const who = `${change.callsign} ${change.op === "write" ? "rewrote" : "edited"} ${shown} ${ago(change.at)}`;
		const detail = change.summary ? ` (${change.summary})` : "";

		let problem: string | null = null;
		if (view) {
			if (change.at + CLOCK_GRACE_MS < view.at) return { action: "allow" };
			const now = fileFingerprint(path);
			if (now === view.fingerprint) return { action: "allow" };
			problem = `${who}${detail}, after you last ${view.via === "read" ? "read" : "wrote"} it`;
		} else {
			if (Date.now() - change.at > UNSEEN_WINDOW_MS) return { action: "allow" };
			if (fileFingerprint(path) === null) return { action: "allow" };
			problem = `${who}${detail}, and you have not read it in this session`;
		}

		return this.block(path, change, tool, mode, problem, shown);
	}

	private block(path: string, change: PeerChange, tool: "edit" | "write", mode: GuardMode, problem: string, shown: string): Verdict {
		const strict = mode === "strict";
		const wouldBlock = tool === "write" || strict;
		if (!wouldBlock) {
			return {
				action: "warn",
				staleChange: change,
				note: `⚠ telecom: ${problem}. Your edit applied because its anchors still matched, but re-read the file to make sure it fits with ${change.callsign}'s change.`,
			};
		}
		const prior = this.staleBlocks.get(path);
		const count = prior && prior.changeAt === change.at ? prior.count + 1 : 1;
		if (count > MAX_STALE_BLOCKS) {
			return {
				action: "warn",
				staleChange: change,
				note: `⚠ telecom: ${problem}. Allowed after ${MAX_STALE_BLOCKS} warnings — tell ${change.callsign} what you overwrote.`,
			};
		}
		this.staleBlocks.set(path, { changeAt: change.at, count });
		return {
			action: "block",
			reason: `telecom: ${problem}. Re-read ${shown} and re-apply your change on top of theirs${
				tool === "write" ? " (prefer `edit` over a whole-file `write`)" : ""
			}. If you must coordinate, telecom({ action: "ask", to: "${change.callsign}", message: "…" }).`,
		};
	}

	/**
	 * Is `path` inside a live peer's claim? Standard mode blocks the first attempt and lets a
	 * retry through (the owner is told either way); strict blocks every attempt. A claim made in
	 * another checkout of the repository is advisory: a note, and the owner told once. Claims of
	 * this agent's lineal family (`exempt`: its parent chain and its subagents) never apply.
	 */
	checkClaims(
		path: string,
		mode: GuardMode,
		peers: readonly Presence[],
		self: Presence,
		exempt: ReadonlySet<string>,
	): Verdict {
		if (mode === "off") return { action: "allow" };
		const now = Date.now();
		const mine = this.placeOf(path, self);
		if (!mine) return { action: "allow" };
		// Advisory matches are kept aside while the scan goes on: a binding claim further down the
		// list (a responsive owner in this checkout) must still hold the edit back.
		let lane: { peer: Presence; claim: Claim; what: string } | null = null;
		let unenforced: string | null = null;
		for (const peer of peers) {
			if (peer.id === self.id || exempt.has(peer.id) || !sameRepo(peer, self)) continue;
			// A claim is written against its owner's checkout (where it started). `theirs` is the
			// file there that this edit stands for. The claim binds when it names this very file, or
			// when its owner works in the checkout this file lies in (its recent edits landed there):
			// then both agents change one copy. Otherwise the copies are separate: advisory.
			const theirs = join(peer.projectRoot, mine.rel);
			const sharedCheckout = this.checkoutsOf(peer).has(mine.checkout);
			for (const claim of peer.claims) {
				if (claim.expiresAt <= now) continue;
				const exact = matchesClaim(path, claim.pattern, peer.projectRoot);
				if (!exact && !matchesClaim(theirs, claim.pattern, peer.projectRoot)) continue;
				const otherLane = !exact && !sharedCheckout;
				const shown = displayPath(path, mine.checkout);
				const what = `${shown} is inside ${peer.callsign}'s claim "${claim.pattern}"${
					claim.note ? ` (${claim.note})` : ""
				}, held since ${ago(claim.since)}`;
				if (otherLane) {
					lane ??= { peer, claim, what };
					continue;
				}
				if (now - peer.heartbeatAt > UNRESPONSIVE_MS) {
					// A suspended or hung owner cannot answer, so its claim must not block anyone.
					unenforced ??= `⚠ telecom: ${what}, but ${peer.callsign} has not checked in for ${ago(peer.heartbeatAt).replace(" ago", "")}, so the claim is not enforced. Tell them what you changed when they are back.`;
					continue;
				}
				const key = `${peer.id}\u0000${path}`;
				const warnedAt = this.contested.get(key);
				if (mode === "standard" && warnedAt !== undefined && now - warnedAt < CONTEST_WINDOW_MS) {
					return {
						action: "warn",
						note: `⚠ telecom: ${what}. You went ahead after the warning; ${peer.callsign} has been told.`,
					};
				}
				this.contested.set(key, now);
				return {
					action: "block",
					contested: { owner: peer, claim },
					reason:
						mode === "strict"
							? `telecom: ${what}. ${peer.callsign} has been told you need it. Ask them to release it or to make the change: telecom({ action: "ask", to: "${peer.callsign}", message: "…" }).`
							: `telecom: ${what}. ${peer.callsign} has been told you tried. Best: ask them first — telecom({ action: "ask", to: "${peer.callsign}", message: "…" }) — or pick other work. If the change is small and clearly safe, retrying the same call goes through.`,
				};
			}
		}
		const advisory = lane ? this.laneClaim(path, lane.peer, lane.claim, lane.what, now) : null;
		if (!unenforced) return advisory ?? { action: "allow" };
		return {
			action: "warn",
			note: advisory ? `${unenforced}\n${advisory.note}` : unenforced,
			...(advisory?.contested ? { contested: advisory.contested } : {}),
		};
	}

	/** A claim from another checkout: advisory. The owner is told (by the caller, on success). */
	private laneClaim(path: string, peer: Presence, claim: Claim, what: string, now: number): Verdict & { action: "warn" } {
		const warnedAt = this.contested.get(`${peer.id}\u0000${path}`);
		const tell = warnedAt === undefined || now - warnedAt >= CONTEST_WINDOW_MS;
		return {
			action: "warn",
			note: `⚠ telecom: ${what}, in ${laneName(laneIn(workingCheckout(peer, this.places), peer))}. Your checkout is separate, so this went through, but the two changes meet when the branches merge${
				tell ? ` — ${peer.callsign} has been told` : ""
			}. If they may conflict, agree on one owner: telecom({ action: "send", to: "${peer.callsign}", message: "…" }).`,
			...(tell ? { contested: { owner: peer, claim, lane: true } } : {}),
		};
	}
}
