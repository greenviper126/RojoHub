import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { StudioPluginStatus } from "../common/api";

/*
	Installs Rojo-Hub's Studio plugin (spec 007): the RojoHub.rbxm built into
	dist/ beside this service, copied into Studio's local plugins folder.

	The running service is always the newest one any window has (ensureService
	in src/extension/client.ts), so the plugin it installs always matches it and
	is never downgraded, and two VS Code profiles on different versions do not
	take turns overwriting it. Studio loads a changed plugin only when a place
	is next opened (spec 007, M3).
*/

export const PLUGIN_FILE = "RojoHub.rbxm";
/** What `rojo plugin install` names the official Rojo plugin; only reported, never touched. */
const OFFICIAL_ROJO = "rojomanagedplugin.rbxm";
/** Our own earlier or hand-downloaded copies, which would load twice beside the managed one. */
const OUR_COPIES = /^rojohub.*\.rbxmx?$/i;

/** Studio's local plugins folder. ROJO_HUB_STUDIO_PLUGINS overrides it, so tests never touch the real one. */
export function pluginsFolder(): string {
	return process.env.ROJO_HUB_STUDIO_PLUGINS ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Roblox", "Plugins");
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/*
	Puts `source` in `folder` as RojoHub.rbxm unless an identical file is there,
	and removes other RojoHub*.rbxm(x) files. Only acts when Studio is installed
	(the plugins folder's parent exists); never throws.
*/
export function installPlugin(source: string, folder = pluginsFolder()): StudioPluginStatus {
	const status: StudioPluginStatus = { state: "installed", detail: "", removed: [], officialRojo: false };
	try {
		if (!existsSync(source)) return { ...status, state: "error", detail: `${PLUGIN_FILE} is missing from Rojo-Hub's install (${dirname(source)}).` };
		if (!existsSync(dirname(folder)) && !process.env.ROJO_HUB_STUDIO_PLUGINS) {
			return { ...status, state: "no-studio", detail: `Roblox Studio was not found (${dirname(folder)}).` };
		}
		mkdirSync(folder, { recursive: true });
		const bytes = readFileSync(source);
		const target = join(folder, PLUGIN_FILE);
		let current: string | null = null;
		try {
			current = sha(readFileSync(target));
		} catch {
			// not installed yet
		}
		if (current !== sha(bytes)) {
			// A temporary file beside it, then a rename, so Studio never loads a half-written plugin.
			const temporary = join(folder, `.${PLUGIN_FILE}.${process.pid}.tmp`);
			writeFileSync(temporary, bytes);
			renameSync(temporary, target);
			status.detail = current === null ? "Installed; it loads in the next place you open." : "Updated; each open place loads it when it is next opened.";
		}
		for (const name of readdirSync(folder)) {
			const lower = name.toLowerCase();
			if (lower === OFFICIAL_ROJO) status.officialRojo = true;
			if (name === PLUGIN_FILE || !OUR_COPIES.test(name)) continue;
			rmSync(join(folder, name), { force: true });
			status.removed.push(name);
		}
		return status;
	} catch (error) {
		return { ...status, state: "error", detail: `Could not install the Studio plugin in ${folder}: ${error instanceof Error ? error.message : error}` };
	}
}

/** Removes the managed plugin (the uninstall hook). */
export function removePlugin(folder = pluginsFolder()): boolean {
	const target = join(folder, PLUGIN_FILE);
	if (!existsSync(target)) return false;
	rmSync(target, { force: true });
	return true;
}
