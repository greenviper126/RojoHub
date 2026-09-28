import { readdirSync } from "node:fs";

/*
	A project's Rojo project file (spec 005): one of the *.project.json files
	directly in its folder, default.project.json unless the user picked another.
	Used by the service and the extension; not by the webview, which has no fs.
*/

export const DEFAULT_PROJECT_FILE = "default.project.json";

/** A bare file name ending in .project.json: no folders, so it always names a file in the project's folder. */
export function isProjectFileName(name: unknown): name is string {
	return typeof name === "string" && /^[^\\/:*?"<>|]+\.project\.json$/i.test(name) && name !== "." && !name.startsWith("..");
}

/** The *.project.json files directly in `folder`, default.project.json first, then by name. */
export function listProjectFiles(folder: string): string[] {
	let names: string[];
	try {
		names = readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isProjectFileName(entry.name))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.sort((a, b) => Number(b === DEFAULT_PROJECT_FILE) - Number(a === DEFAULT_PROJECT_FILE) || a.localeCompare(b));
}

/** The file a folder uses without asking: default.project.json, else its only project file, else null. */
export function defaultProjectFile(files: string[]): string | null {
	if (files.includes(DEFAULT_PROJECT_FILE)) return DEFAULT_PROJECT_FILE;
	return files.length === 1 ? files[0] : null;
}
