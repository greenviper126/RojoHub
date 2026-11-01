import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { compareVersions } from "../common/version";
import { newerInstalled } from "../extension/reload";

/*
	Which Rojo-Hub versions VS Code has installed (spec 015). Every profile has
	its own extensions.json: profiles\<id>\ for a named profile, the extensions
	folder itself for the default one (the shape src/extension/reload.ts reads).
	ROJO_HUB_VSCODE_USER and ROJO_HUB_VSCODE_EXTENSIONS replace the two real
	folders, so tests never read the real ones.
*/
export function extensionLists(env: NodeJS.ProcessEnv = process.env): string[] {
	const user = env.ROJO_HUB_VSCODE_USER ?? join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User");
	const extensions = env.ROJO_HUB_VSCODE_EXTENSIONS ?? join(homedir(), ".vscode", "extensions");
	const files = [join(extensions, "extensions.json")];
	try {
		for (const entry of readdirSync(join(user, "profiles"), { withFileTypes: true })) {
			if (entry.isDirectory()) files.push(join(user, "profiles", entry.name, "extensions.json"));
		}
	} catch {
		// no profiles folder
	}
	return files;
}

/** The newest Rojo-Hub version any of the lists has, when it is newer than `running`; else null. Unreadable lists are skipped. */
export function newestInstalled(files: string[], running: string): string | null {
	let newest: string | null = null;
	for (const file of files) {
		const version = newerInstalled(file, running);
		if (version && (newest === null || compareVersions(version, newest) > 0)) newest = version;
	}
	return newest;
}
