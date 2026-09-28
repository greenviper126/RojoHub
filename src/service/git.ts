import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Target, TargetOption } from "../common/api";

/*
	Runs git and resolves with stdout. Failures carry git's own stderr, which is
	usually the most readable explanation there is.
*/
export function git(cwd: string, args: string[], options: { timeout?: number } = {}): Promise<string> {
	return new Promise((done, fail) => {
		// A fetch that needs credentials fails with git's message instead of waiting on a prompt nobody sees:
		// GIT_TERMINAL_PROMPT for git's own prompt, GCM_INTERACTIVE for Git Credential Manager's sign-in window.
		const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
		execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true, env, timeout: options.timeout ?? 0 }, (error, stdout, stderr) => {
			if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") fail(new Error(GIT_MISSING));
			else if (error) fail(new Error(`git ${args.join(" ")}: ${(stderr || error.message).trim()}`));
			else done(stdout);
		});
	});
}

const GIT_MISSING = "git was not found. Install Git for Windows (https://git-scm.com/downloads), make sure `git` is on PATH, then restart VS Code.";

/** Git 2.31 is the first with `rev-parse --path-format=absolute`, which finding a repo's primary checkout needs. */
export const MIN_GIT: [number, number] = [2, 31];

/** Parses `git --version` ("git version 2.45.1.windows.1") into [major, minor], or null. */
export function gitVersion(text: string): [number, number] | null {
	const match = /git version (\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2])] : null;
}

let gitChecked: Promise<string | null> | null = null;

/*
	Why git cannot be used, or null when it can: missing from PATH or older than
	MIN_GIT. Checked once per service; an older git would otherwise fail later
	with a confusing message (or, for rev-parse, print the unknown flag back as
	if it were a path).
*/
export function gitProblem(): Promise<string | null> {
	gitChecked ??= git(process.cwd(), ["--version"]).then(
		(out) => {
			const version = gitVersion(out);
			if (!version) return null;
			const [major, minor] = version;
			if (major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])) return null;
			return `Rojo-Hub needs git ${MIN_GIT.join(".")} or newer; ${out.trim()} is installed. Update Git for Windows (https://git-scm.com/downloads) and restart VS Code.`;
		},
		(error: Error) => {
			gitChecked = null;
			return error.message;
		},
	);
	return gitChecked;
}

/** Options for a git call that must not run the repo's hooks (core.hooksPath pointed at nothing). */
export const NO_HOOKS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];

/*
	Drops git's record of worktrees under `dir` whose folder is gone, and only
	those. `git worktree prune` would do it for the whole repo, which also
	forgets the user's own worktrees on a drive that is not plugged in.
*/
export async function pruneMissingWorktreesUnder(repo: string, dir: string): Promise<void> {
	const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	const admin = join(common, "worktrees");
	if (!existsSync(admin)) return;
	const under = sameFolders(dir).map((key) => key + "/");
	for (const name of readdirSync(admin)) {
		let tree: string;
		try {
			// gitdir holds the worktree's .git file path.
			tree = dirname(readFileSync(join(admin, name, "gitdir"), "utf8").trim());
		} catch {
			continue;
		}
		if (under.some((prefix) => pathKey(tree).startsWith(prefix)) && !existsSync(tree)) rmSync(join(admin, name), { recursive: true, force: true });
	}
}

/*
	pathKey of a folder, and of where it really is when a junction, symbolic
	link or redirected folder leads to it. git records worktrees by their real
	path, so a folder is only recognised in git's lists by both.
*/
export function sameFolders(dir: string): string[] {
	const keys = [pathKey(dir)];
	try {
		keys.push(pathKey(realpathSync.native(dir)));
	} catch {
		// not there yet
	}
	return [...new Set(keys)];
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

function orca(args: string[], timeout: number): Promise<unknown> {
	return new Promise((done, fail) => {
		execFile("orca", args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
			let parsed: { ok?: boolean; result?: unknown; error?: { message?: string } } | null = null;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				// not JSON: fall through to the error below
			}
			if (!error && parsed?.ok) return done(parsed.result);
			fail(new Error(`orca ${args.slice(0, 2).join(" ")}: ${parsed?.error?.message ?? (stderr || error?.message || stdout).trim()}`));
		});
	});
}

/** Whether Orca is installed, running and has `repo` added. */
export async function inOrca(repo: string): Promise<boolean> {
	try {
		const result = (await orca(["repo", "list", "--json"], 5000)) as { repos?: { path: string }[] };
		return (result.repos ?? []).some((entry) => pathKey(entry.path) === pathKey(repo));
	} catch {
		return false;
	}
}

/*
	Makes an Orca worktree on a new branch. Measured (spec 002): about 1.6 s
	with --setup skip, and Orca names the branch "<git user>/<name>", so the
	branch is read back from its answer rather than assumed.
*/
export async function orcaCreateWorktree(repo: string, name: string, base: string): Promise<{ path: string; branch: string | null }> {
	const result = (await orca(
		["worktree", "create", "--repo", `path:${repo}`, "--name", name, "--base-branch", base, "--setup", "skip", "--no-parent", "--json"],
		120000,
	)) as { worktree?: { path?: string; branch?: string } };
	const path = result.worktree?.path;
	if (!path) throw new Error("orca worktree create did not say where it put the worktree");
	return { path: resolve(path), branch: result.worktree?.branch?.replace(/^refs\/heads\//, "") ?? null };
}

/** git's own check of a new branch name; returns the name as git would store it, or throws git's reason. */
export async function checkBranchName(repo: string, name: string): Promise<string> {
	try {
		return (await git(repo, ["check-ref-format", "--branch", name])).trim();
	} catch {
		throw new Error(`"${name}" is not a valid branch name (no spaces, "..", "~", "^", ":", "?", "*", "[" or a trailing "/" or ".lock").`);
	}
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
	return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).then(
		() => true,
		() => false,
	);
}

/*
	The HEAD file of the worktree at `path`: .git/HEAD in the primary
	checkout, .git/worktrees/<name>/HEAD in a linked worktree, whose .git is a
	file pointing there. Reading it is how a checkout in a served worktree is
	noticed.
*/
export function headFile(path: string): string | null {
	const dotGit = join(path, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return join(dotGit, "HEAD");
		const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
		return pointer ? join(resolve(path, pointer), "HEAD") : null;
	} catch {
		return null;
	}
}

/** What a HEAD file says: the branch name, or the short commit when detached. */
export function readHead(file: string): string | null {
	try {
		const text = readFileSync(file, "utf8").trim();
		return text.startsWith("ref: ") ? text.slice(5).replace(/^refs\/heads\//, "") : text.slice(0, 8);
	} catch {
		return null;
	}
}
