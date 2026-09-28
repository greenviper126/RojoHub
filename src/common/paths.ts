import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/*
	The long form of a Windows path that holds 8.3 short names
	(C:\Users\JOHNSM~1\...), which %TEMP% and %LOCALAPPDATA% can be when a user
	name is long or has spaces. git and VS Code report long forms, so without
	this the same folder compares unequal to itself. Only the part that exists
	is expanded; the rest is kept as written.
*/
export function longPath(path: string): string {
	const absolute = resolve(path);
	if (process.platform !== "win32" || !absolute.includes("~")) return absolute;
	let existing = absolute;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	try {
		return join(realpathSync.native(existing), relative(existing, absolute));
	} catch {
		return absolute;
	}
}

/** Case-, separator- and short-name-insensitive key for comparing Windows paths. */
export function pathKey(path: string): string {
	return longPath(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
