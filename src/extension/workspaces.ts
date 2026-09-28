import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { parse } from "jsonc-parser";

import type { WorkspaceInfo } from "../common/panel";
import { listProjectFiles } from "../common/projectFiles";

/*
	VS Code workspaces (.code-workspace files) that Rojo-Hub projects belong to,
	for grouping the Projects list visually. Found in two places: the file this
	window has open, and the top folder of every registered project (where a
	multi-root workspace usually lives, e.g. MyGame.code-workspace).
	Nothing here changes a project; it only decides where its card is drawn,
	and which folders in a workspace could still be added.
*/

export { pathKey } from "../common/paths";
import { pathKey } from "../common/paths";

/** The folders a workspace file lists, as absolute paths. Accepts VS Code's comments and trailing commas. */
export function parseWorkspaceFile(text: string, file: string): string[] {
	const parsed = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as { folders?: { path?: unknown; uri?: unknown }[] } | undefined;
	const folders: string[] = [];
	for (const folder of parsed?.folders ?? []) {
		if (typeof folder.path !== "string") continue; // uri folders (remote, virtual) are not local projects
		folders.push(isAbsolute(folder.path) ? resolve(folder.path) : resolve(dirname(file), folder.path));
	}
	return folders;
}

function workspaceFilesIn(folder: string): string[] {
	try {
		return readdirSync(folder)
			.filter((name) => name.toLowerCase().endsWith(".code-workspace"))
			.map((name) => join(folder, name));
	} catch {
		return [];
	}
}

export interface WorkspaceInput {
	/** The .code-workspace file this window has open, if any. */
	windowFile: string | null;
	slots: { id: string; repoPath: string }[];
	/** The primary checkout of the repo a folder is in, or null outside git. */
	primaryOf: (folder: string) => Promise<string | null>;
	projectFile?: string;
}

/*
	Every workspace that holds at least one registered project or one folder
	that could be added. The window's own workspace comes first, then the rest
	by name.
*/
export async function findWorkspaces(input: WorkspaceInput): Promise<WorkspaceInfo[]> {
	// Without one, a folder is addable when it has any *.project.json (spec 005).
	const projectFile = input.projectFile;
	const files = new Map<string, string>();
	const add = (file: string) => {
		if (existsSync(file) && !files.has(pathKey(file))) files.set(pathKey(file), file);
	};
	if (input.windowFile) add(input.windowFile);
	for (const slot of input.slots) workspaceFilesIn(slot.repoPath).forEach(add);

	const byRepo = new Map(input.slots.map((slot) => [pathKey(slot.repoPath), slot.id]));
	const found: WorkspaceInfo[] = [];
	for (const file of files.values()) {
		let folders: string[];
		try {
			folders = parseWorkspaceFile(readFileSync(file, "utf8"), file);
		} catch {
			continue;
		}
		const slotIds: string[] = [];
		const addable: WorkspaceInfo["addable"] = [];
		for (const folder of folders) {
			if (!existsSync(folder)) continue;
			const primary = (await input.primaryOf(folder)) ?? folder;
			const slotId = byRepo.get(pathKey(primary));
			if (slotId) {
				if (!slotIds.includes(slotId)) slotIds.push(slotId);
			} else if ((projectFile ? existsSync(join(folder, projectFile)) : listProjectFiles(folder).length > 0) && !addable.some((entry) => pathKey(entry.path) === pathKey(primary))) {
				addable.push({ label: basename(primary), path: primary });
			}
		}
		if (slotIds.length + addable.length === 0) continue;
		found.push({ file, name: basename(file).replace(/\.code-workspace$/i, ""), slotIds, addable, isWindow: !!input.windowFile && pathKey(file) === pathKey(input.windowFile) });
	}
	return found.sort((a, b) => Number(b.isWindow) - Number(a.isWindow) || a.name.localeCompare(b.name));
}
