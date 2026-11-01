import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { compareVersions } from "../common/version";

const ID = "greenviper126.rojo-hub";
const DEFAULT_PROFILE = "__default__profile__";

/*
	A newer Rojo-Hub installed in this window's profile (`code --install-extension
	... --force --profile X`, or the Marketplace updating it) does not run until
	the window reloads.

	Every profile's extensions share one folder, so a newer folder there may
	belong to another profile: a window of a profile that still has an older
	version would reload forever. Only the profile's own list counts: its
	extensions.json, in profiles\<id>\ for a named profile and in the extensions
	folder itself for the default one.

	Which profile a window uses is not in the extension API, and globalStorage is
	shared by all profiles (0.22.6 assumed it was not, and never reloaded). VS
	Code records it per workspace in User\globalStorage\storage.json,
	`profileAssociations.workspaces` { "<workspace URI>": "<profile id>" }.
	Measured 2026-10-26: profiles\<id>\extensions.json and
	~\.vscode\extensions\extensions.json, entries { identifier: { id }, version }.
*/

/** VS Code's User folder, from this extension's globalStorage path (shared, or a profile's). */
export function userFolder(globalStoragePath: string): string {
	const above = dirname(dirname(globalStoragePath));
	return basename(dirname(above)).toLowerCase() === "profiles" ? dirname(dirname(above)) : above;
}

/** The extensions.json of the profile this workspace opens in; null when VS Code has no record of it (an empty window). */
export function profileExtensionsFile(globalStoragePath: string, extensionPath: string, workspace: string | undefined, read: (file: string) => string = (file) => readFileSync(file, "utf8")): string | null {
	if (!workspace) return null;
	const user = userFolder(globalStoragePath);
	try {
		const storage = JSON.parse(read(join(user, "globalStorage", "storage.json"))) as { profileAssociations?: { workspaces?: Record<string, unknown> } };
		const profile = storage.profileAssociations?.workspaces?.[workspace];
		if (typeof profile !== "string" || profile === "") return null;
		return profile === DEFAULT_PROFILE ? join(dirname(extensionPath), "extensions.json") : join(user, "profiles", profile, "extensions.json");
	} catch {
		return null;
	}
}

/** The version of Rojo-Hub the profile has installed, when it is newer than the one running; else null. */
export function newerInstalled(listFile: string, running: string, read: (file: string) => string = (file) => readFileSync(file, "utf8")): string | null {
	try {
		const entries = JSON.parse(read(listFile)) as { identifier?: { id?: unknown }; version?: unknown }[];
		const mine = entries.find((entry) => typeof entry?.identifier?.id === "string" && entry.identifier.id.toLowerCase() === ID);
		const version = typeof mine?.version === "string" ? mine.version : null;
		return version && compareVersions(version, running) > 0 ? version : null;
	} catch {
		return null;
	}
}
