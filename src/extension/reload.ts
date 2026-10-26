import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { compareVersions } from "../common/version";

const ID = "greenviper126.rojo-hub";

/*
	A newer Rojo-Hub installed in this window's profile (`code --install-extension
	... --force --profile X`, or the Marketplace updating it) does not run until
	the window reloads.

	Every profile's extensions share one folder, so a newer folder there may
	belong to another profile: a window of a profile that still has an older
	version would reload forever. Only the profile's own list counts: its
	extensions.json, in the profile's folder (two above globalStorage/<id>) for
	a named profile, and in the extensions folder itself for the default one.
	Measured 2026-10-26: profiles\<id>\extensions.json and
	~\.vscode\extensions\extensions.json, entries { identifier: { id }, version }.
*/
export function profileExtensionsFile(globalStoragePath: string, extensionPath: string): string {
	const profile = dirname(dirname(globalStoragePath));
	return basename(dirname(profile)).toLowerCase() === "profiles" ? join(profile, "extensions.json") : join(dirname(extensionPath), "extensions.json");
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
