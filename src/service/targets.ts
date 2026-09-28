import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import type { TargetOption } from "../common/api";
import { listTargets, pathKey, type IsHubView } from "./git";

/** Orca's worktree names can change without git noticing, so a list older than this is refreshed when asked for. */
const STALE_MS = 60_000;
/** git writes several files per operation; one refresh covers them all. */
const SETTLE_MS = 250;

interface Entry {
	repo: string;
	options: TargetOption[] | null;
	/** When `options` was read (ms), 0 before the first read. */
	at: number;
	running: Promise<void> | null;
	/** A change arrived while a read was running, so read again after it. */
	again: boolean;
	watcher: FSWatcher | null;
	timer: NodeJS.Timeout | null;
}

/*
	Every registered repo's branch-picker list, kept in memory so the picker
	opens at once (spec 002). Reading it runs git and `orca`, about 0.3 s, so
	that happens in the background: when the repo's refs or worktrees change
	(a watch on .git), after the Hub fetches or makes a branch, and when a
	list older than a minute is asked for. Callers get the list they have
	while a newer one is read.
*/
export class TargetCache {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly isHubView: IsHubView) {}

	/** The cached list, reading it first only if there is none yet. */
	async get(repo: string): Promise<TargetOption[]> {
		const entry = this.entry(repo);
		if (!entry.watcher) entry.watcher = this.watch(entry);
		if (!entry.options) await this.refresh(repo);
		else if (Date.now() - entry.at > STALE_MS) void this.refresh(repo).catch(() => undefined);
		if (!entry.options) throw new Error(`Could not list ${repo}'s branches`);
		return entry.options;
	}

	/** The list as it is now, without reading it; null before the first read. */
	peek(repo: string): TargetOption[] | null {
		return this.entries.get(pathKey(repo))?.options ?? null;
	}

	/** When the repo's list was last read, so the panel can tell that a newer one is ready. */
	stamp(repo: string): number {
		return this.entries.get(pathKey(repo))?.at ?? 0;
	}

	/** Reads the list again now; one read at a time per repo, with one more queued if asked during it. */
	refresh(repo: string): Promise<void> {
		const entry = this.entry(repo);
		if (entry.running) {
			entry.again = true;
			return entry.running;
		}
		entry.running = (async () => {
			try {
				do {
					entry.again = false;
					entry.options = await listTargets(entry.repo, this.isHubView);
					entry.at = Date.now();
				} while (entry.again);
			} finally {
				entry.running = null;
			}
		})();
		return entry.running;
	}

	/** Watches the repos in use and reads their lists; forgets repos no longer registered. */
	track(repos: string[]): void {
		const wanted = new Set(repos.map(pathKey));
		for (const [key, entry] of this.entries) {
			if (wanted.has(key)) continue;
			entry.watcher?.close();
			if (entry.timer) clearTimeout(entry.timer);
			this.entries.delete(key);
		}
		for (const repo of repos) {
			const entry = this.entry(repo);
			if (!entry.watcher) entry.watcher = this.watch(entry);
			if (!entry.options && !entry.running) void this.refresh(repo).catch(() => undefined);
		}
	}

	dispose(): void {
		this.track([]);
	}

	private entry(repo: string): Entry {
		const key = pathKey(repo);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { repo, options: null, at: 0, running: null, again: false, watcher: null, timer: null };
			this.entries.set(key, entry);
		}
		return entry;
	}

	/*
		Measured on Windows (spec 002): a recursive watch on .git sees a new
		branch, a fetch, a pack-refs, a new worktree and a checkout in any
		worktree within ~30 ms. Only ref and worktree files matter; the index,
		logs and objects change all the time (VS Code's own git status) and are
		ignored.
	*/
	private watch(entry: Entry): FSWatcher | null {
		const gitDir = join(entry.repo, ".git");
		if (!existsSync(gitDir)) return null;
		try {
			const watcher = watch(gitDir, { recursive: true }, (_event, name) => {
				if (!name || !isRefChange(String(name))) return;
				if (entry.timer) clearTimeout(entry.timer);
				entry.timer = setTimeout(() => {
					entry.timer = null;
					void this.refresh(entry.repo).catch(() => undefined);
				}, SETTLE_MS);
			});
			// A watch that fails (the .git folder moved, a network drive dropped) is let go, so the next get() or track() makes a new one.
			watcher.on("error", () => {
				watcher.close();
				if (entry.watcher === watcher) entry.watcher = null;
			});
			return watcher;
		} catch {
			return null;
		}
	}
}

/** Whether a path inside .git (as fs.watch reports it) is a ref, HEAD or worktree change. */
export function isRefChange(name: string): boolean {
	const path = name.replace(/\\/g, "/");
	if (path.endsWith(".lock")) return false;
	return path === "HEAD" || path === "packed-refs" || path === "refs" || path.startsWith("refs/") || /^worktrees(\/[^/]+(\/HEAD)?)?$/.test(path);
}
