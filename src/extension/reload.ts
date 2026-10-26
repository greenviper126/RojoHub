import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { compareVersions } from "../common/version";

/*
	A newer Rojo-Hub installed next to the running one (`code --install-extension
	... --force`, or the Marketplace updating it) does not run until its window
	reloads. The running extension's folder is
	<extensions>/greenviper126.rojo-hub-<version>[-<platform>]; a newer sibling
	with a built service is the update. Pure apart from the two file functions,
	which tests replace.
*/
export function newerInstalled(
	extensionPath: string,
	running: string,
	list: (folder: string) => string[] = readdirSync,
	exists: (path: string) => boolean = existsSync,
): string | null {
	const root = dirname(extensionPath);
	let names: string[];
	try {
		names = list(root);
	} catch {
		return null;
	}
	let best: string | null = null;
	for (const name of names) {
		const match = /^greenviper126\.rojo-hub-(\d+(?:\.\d+)*)(?:-.+)?$/i.exec(name);
		if (!match || !exists(join(root, name, "dist", "extension.js"))) continue;
		if (compareVersions(match[1], running) > 0 && (best === null || compareVersions(match[1], best) > 0)) best = match[1];
	}
	return best;
}
