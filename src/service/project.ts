import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { longPath } from "../common/paths";

/*
	How a slot's project file is generated. See spec 001, "Live-switch
	measurement", for why each rule here exists.

	The slot file is what `rojo serve` is started with, once, by its verbatim
	path. Its root node is a single `$path` to the served tree's own project
	file (also verbatim), so Rojo reads that tree's project natively: its
	globIgnorePaths, syncRules and relative $paths all resolve against the tree,
	and edits to the tree's project file sync live. Switching rewrites only that
	one `$path`.

	When the tree lacks a folder its project file maps that the primary checkout
	has (Packages and ServerPackages in a worktree that has not run Wally), the
	root `$path` points instead at a generated copy of the tree's project file
	with every `$path` made absolute and those folders borrowed from the primary.
	That copy lives in the Hub's folder, so rules relative to the project folder
	(globIgnorePaths, syncRules) no longer match anything; the slot reports that.
*/

/** Top-level fields Rojo reads once when the session starts, copied from the primary. */
const SESSION_FIELDS = ["servePlaceIds", "blockedPlaceIds", "placeId", "gameId", "emitLegacyScripts"] as const;

/** Rules whose paths are relative to the project file's folder. */
const FOLDER_RELATIVE_RULES = ["globIgnorePaths", "syncRules"] as const;

/** Wally's install folders, ported from ServeWorktree.mjs's PACKAGE_PATHS for the wally.toml warning. */
const PACKAGE_PATHS = new Set(["Packages", "ServerPackages", "DevPackages"]);

export type ProjectJson = Record<string, unknown> & { name?: string; tree?: unknown };

/*
	Prefix that makes Rojo register a path the way it canonicalizes change
	events on Windows. The path is made long first: Rojo's events carry long
	names, so a watch registered under an 8.3 short name (C:\Users\JOHNSM~1)
	never matches them, and a switch would not reach Studio.
*/
export function verbatim(path: string): string {
	const absolute = longPath(path);
	if (process.platform !== "win32" || absolute.startsWith("\\\\?\\")) return absolute;
	if (absolute.startsWith("\\\\")) return "\\\\?\\UNC\\" + absolute.slice(2);
	return "\\\\?\\" + absolute;
}

export function readProject(file: string): ProjectJson {
	return JSON.parse(readFileSync(file, "utf8")) as ProjectJson;
}

/** A `$path` is either a string or `{ "optional": string }`. */
function pathOf(value: unknown): { path: string; optional: boolean } | null {
	if (typeof value === "string") return { path: value, optional: false };
	if (value && typeof value === "object" && typeof (value as { optional?: unknown }).optional === "string") {
		return { path: (value as { optional: string }).optional, optional: true };
	}
	return null;
}

/** Every `$path` in a project tree, as written. */
export function collectPaths(node: unknown, into: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) collectPaths(item, into);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			const found = key === "$path" ? pathOf(value) : null;
			if (found) into.push(found.path);
			else collectPaths(value, into);
		}
	}
	return into;
}

/*
	The folders the tree's project file maps that the tree does not have but the
	primary does. Only these are borrowed; a folder missing from both is left for
	Rojo to report, since borrowing cannot fix it.
*/
export function missingRoots(project: ProjectJson, treeDir: string, primaryDir: string): string[] {
	const missing = new Set<string>();
	for (const path of collectPaths(project.tree)) {
		if (isAbsolute(path)) continue;
		if (!existsSync(join(treeDir, path)) && existsSync(join(primaryDir, path))) missing.add(path);
	}
	return [...missing];
}

/*
	Rewrites every `$path` to an absolute path into the tree, or into the
	primary for the borrowed ones. Ported from ServeWorktree.mjs's
	redirectPaths, with absolute instead of relative paths.
*/
export function redirectPaths(node: unknown, treeDir: string, primaryDir: string, borrowed: Set<string>): unknown {
	if (Array.isArray(node)) return node.map((item) => redirectPaths(item, treeDir, primaryDir, borrowed));
	if (node === null || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		const found = key === "$path" ? pathOf(value) : null;
		if (found) {
			const absolute = isAbsolute(found.path) ? found.path : join(borrowed.has(found.path) ? primaryDir : treeDir, found.path);
			out[key] = found.optional ? { optional: absolute } : absolute;
		} else {
			out[key] = redirectPaths(value, treeDir, primaryDir, borrowed);
		}
	}
	return out;
}

/*
	The slot file: the fixed name and session fields, and one root `$path`.
	Everything except `nestedFile` must stay identical across switches, because
	Rojo reads the name and place IDs only when the session starts.
*/
export function slotProject(projectName: string, primaryProject: ProjectJson, nestedFile: string): ProjectJson {
	const slot: ProjectJson = { name: projectName };
	for (const field of SESSION_FIELDS) {
		if (primaryProject[field] !== undefined) slot[field] = primaryProject[field];
	}
	slot.tree = { $path: verbatim(nestedFile) };
	return slot;
}

function normalizedText(file: string): string | null {
	return existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
}

export interface Plan {
	mode: "native" | "borrowed";
	/** The project file the slot file's root `$path` points at. */
	nestedFile: string;
	/** The generated copy's contents, for "borrowed" mode. */
	borrowedProject: ProjectJson | null;
	warnings: string[];
}

/*
	Decides how to serve `treeDir`: natively when it has every folder its
	project maps, otherwise from a borrowed copy written to `borrowedFile`.
*/
export function planTree(treeDir: string, primaryDir: string, projectFile: string, borrowedFile: string): Plan {
	const treeProjectFile = join(treeDir, projectFile);
	if (!existsSync(treeProjectFile)) throw new Error(`${treeDir} has no ${projectFile}`);
	const project = readProject(treeProjectFile);
	const missing = missingRoots(project, treeDir, primaryDir);
	if (missing.length === 0) return { mode: "native", nestedFile: treeProjectFile, borrowedProject: null, warnings: [] };

	const warnings: string[] = [];
	const packages = missing.filter((path) => PACKAGE_PATHS.has(path.split(/[\\/]/)[0]));
	const manifest = normalizedText(join(treeDir, "wally.toml"));
	if (packages.length > 0 && manifest !== null && manifest !== normalizedText(join(primaryDir, "wally.toml"))) {
		warnings.push(
			`This branch changed wally.toml but has no ${packages.join(" or ")} of its own; the primary's copies do not match it. Run Wally in the worktree before trusting what Studio shows.`,
		);
	} else {
		warnings.push(`${missing.join(", ")} come${missing.length === 1 ? "s" : ""} from the primary checkout (not present in this tree).`);
	}
	const lostRules = FOLDER_RELATIVE_RULES.filter((rule) => {
		const value = project[rule];
		return Array.isArray(value) && value.length > 0;
	});
	if (lostRules.length > 0) {
		warnings.push(`${lostRules.join(" and ")} do not apply while folders are borrowed. Give the tree its own ${missing.join(", ")} to serve it natively.`);
	}
	const borrowedProject = redirectPaths(project, treeDir, primaryDir, new Set(missing)) as ProjectJson;
	return { mode: "borrowed", nestedFile: borrowedFile, borrowedProject, warnings };
}
