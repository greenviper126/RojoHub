import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { Target, TargetOption } from "../common/api";

/*
	Runs git and resolves with stdout. Failures carry git's own stderr, which is
	usually the most readable explanation there is.
*/
export function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((done, fail) => {
		execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true }, (error, stdout, stderr) => {
			if (error) fail(new Error(`git ${args.join(" ")}: ${(stderr || error.message).trim()}`));
			else done(stdout);
		});
	});
}

/** Case-insensitive, separator-insensitive key for comparing Windows paths. */
export function pathKey(path: string): string {
	return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/*
	The primary checkout of whatever repo `path` is inside, so registering from a
	worktree registers the project and not that one worktree.
*/
export async function primaryCheckout(path: string): Promise<string> {
	const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return resolve(dirname(common));
}

export interface Worktree {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	primary: boolean;
}

/*
	Parses `git worktree list --porcelain`, ported from ServeWorktree.mjs. The
	first entry git prints is always the primary checkout.
*/
export function parseWorktrees(porcelain: string): Worktree[] {
	const entries: Worktree[] = [];
	let current: Worktree | null = null;
	for (const line of porcelain.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			current = { path: resolve(line.slice("worktree ".length)), head: null, branch: null, detached: false, primary: entries.length === 0 };
			entries.push(current);
		} else if (current && line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
		} else if (current && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (current && line === "detached") {
			current.detached = true;
		} else if (current && line === "bare") {
			current.primary = false;
		}
	}
	return entries;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
	return parseWorktrees(await git(repo, ["worktree", "list", "--porcelain"]));
}

/*
	Committer time of each HEAD in one git call, ported from ServeWorktree.mjs,
	so the picker can put recently worked-on worktrees first.
*/
async function commitTimes(repo: string, heads: string[]): Promise<Map<string, number>> {
	const times = new Map<string, number>();
	if (heads.length === 0) return times;
	try {
		const out = await git(repo, ["log", "--no-walk", "--format=%H %ct", ...heads]);
		for (const line of out.split(/\r?\n/)) {
			const [hash, time] = line.trim().split(" ");
			if (hash && time) times.set(hash, Number(time));
		}
	} catch {
		return times;
	}
	return times;
}

interface Branch {
	ref: string;
	name: string;
	committedAt: number;
	remote: boolean;
}

/*
	Local branches, then remote-tracking branches that have no local branch of
	the same name, newest commit first.
*/
async function listBranches(repo: string): Promise<Branch[]> {
	const out = await git(repo, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname)%09%(refname:short)%09%(committerdate:unix)",
		"refs/heads",
		"refs/remotes",
	]);
	const branches: Branch[] = [];
	for (const line of out.split(/\r?\n/)) {
		const [ref, name, time] = line.split("\t");
		if (!ref || ref.endsWith("/HEAD")) continue;
		branches.push({ ref, name, committedAt: Number(time) || 0, remote: ref.startsWith("refs/remotes/") });
	}
	const local = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
	return branches.filter((b) => !b.remote || !local.has(b.name.slice(b.name.indexOf("/") + 1)));
}

/*
	Orca's names for worktrees, keyed by pathKey. Orca is optional: when it is
	not installed or not running, folder names are used instead.
*/
export function orcaNames(): Promise<Map<string, string>> {
	return new Promise((done) => {
		execFile("orca", ["worktree", "list", "--json"], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1 << 24 }, (error, stdout) => {
			const names = new Map<string, string>();
			if (error) return done(names);
			try {
				const parsed = JSON.parse(stdout) as { result?: { worktrees?: { path: string; displayName?: string }[] } };
				for (const entry of parsed.result?.worktrees ?? []) {
					if (entry.path && entry.displayName) names.set(pathKey(entry.path), entry.displayName);
				}
			} catch {
				// Orca printed something other than its JSON; fall back to folder names.
			}
			done(names);
		});
	});
}

/** True when `path` is inside the Hub's own views folder. */
export type IsHubView = (path: string) => boolean;

/*
	Everything a slot can serve: each worktree git knows about (under Orca's name
	when it has one), then every branch not already checked out in one of them.
	The Hub's own view worktrees are left out; they are how a branch is served,
	not a choice.
*/
export async function listTargets(repo: string, isHubView: IsHubView): Promise<TargetOption[]> {
	const [worktrees, branches, names] = await Promise.all([listWorktrees(repo), listBranches(repo), orcaNames()]);
	const visible = worktrees.filter((w) => !isHubView(w.path));
	const times = await commitTimes(repo, visible.map((w) => w.head).filter((h): h is string => !!h));
	const checkedOut = new Set(visible.map((w) => w.branch).filter((b): b is string => !!b));

	const options: TargetOption[] = visible.map((w) => ({
		target: { kind: "worktree", path: w.path },
		label: names.get(pathKey(w.path)) ?? (w.primary ? basename(w.path) : basename(w.path)),
		description: `${w.branch ?? `detached ${w.head?.slice(0, 8)}`}${w.primary ? " · primary" : ""}${existsSync(w.path) ? "" : " · missing"}`,
		branch: w.branch,
		isPrimary: w.primary,
		committedAt: (w.head && times.get(w.head)) || 0,
	}));
	options.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.committedAt - a.committedAt);

	for (const branch of branches) {
		if (!branch.remote && checkedOut.has(branch.name)) continue;
		options.push({
			target: { kind: "branch", ref: branch.ref },
			label: branch.name,
			description: branch.remote ? "remote branch · no worktree" : "branch · no worktree",
			branch: branch.name,
			isPrimary: false,
			committedAt: branch.committedAt,
		});
	}
	return options;
}

export function sameTarget(a: Target, b: Target): boolean {
	if (a.kind === "worktree" && b.kind === "worktree") return pathKey(a.path) === pathKey(b.path);
	if (a.kind === "branch" && b.kind === "branch") return a.ref === b.ref;
	return false;
}
