import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { compareVersions } from "./version";

/*
	What the stdio launcher (spec 011, section 1) shares with the service, the
	extension and the uninstall hook: where it lives, how a service script is
	found when nothing answers, and how the service installs the launcher.
	Plain node only, so the launcher bundle stays small.
*/

export const LAUNCHER_FILE = "rojohub-mcp.cjs";
const FIRST_LINE = "// rojo-hub-launcher ";

/** The state folder for this Windows user, worked out exactly as src/service/main.ts does. */
export function hubHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.ROJO_HUB_HOME ?? join(env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "RojoHub");
}

export const launcherDir = (home: string): string => join(home, "launcher");
/** The copy of the launcher that agents' configs point at. */
export const launcherScript = (home: string): string => join(launcherDir(home), LAUNCHER_FILE);
export const hintFile = (home: string): string => join(launcherDir(home), "service.json");
export const cacheFile = (home: string): string => join(launcherDir(home), "cache.json");

/** Written by the extension each time it starts a service: the script it started and that script's version. */
export function writeHint(home: string, version: string, script: string): void {
	try {
		mkdirSync(launcherDir(home), { recursive: true });
		writeFileSync(hintFile(home), JSON.stringify({ version, script }));
	} catch {
		// a hint is an optimisation for development hosts; never fail a start over it
	}
}

export interface FoundService {
	version: string;
	script: string;
	source: "override" | "hint" | "extension";
}

/** The extension folders that can hold greenviper126.rojo-hub-<version>[-<platform>] (shared by every profile). */
function extensionRoots(env: NodeJS.ProcessEnv, userHome: string): string[] {
	return [
		env.VSCODE_EXTENSIONS,
		...[".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf"].map((name) => join(userHome, name, "extensions")),
	].filter((root): root is string => !!root);
}

/*
	The service script to start when /health gets no answer: ROJO_HUB_SERVICE,
	else the newest version among the hint file and the installed extensions
	that has a dist/service.js. Ties go to the hint (a development host).
*/
export function findService(home: string, env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): FoundService | null {
	if (env.ROJO_HUB_SERVICE) return { version: "0", script: env.ROJO_HUB_SERVICE, source: "override" };
	const found: FoundService[] = [];
	try {
		const hint = JSON.parse(readFileSync(hintFile(home), "utf8")) as { version?: unknown; script?: unknown };
		if (typeof hint.script === "string" && typeof hint.version === "string" && existsSync(hint.script)) found.push({ version: hint.version, script: hint.script, source: "hint" });
	} catch {
		// no hint, or an unreadable one
	}
	for (const root of extensionRoots(env, userHome)) {
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			const match = /^greenviper126\.rojo-hub-(\d+(?:\.\d+)*)(?:-.+)?$/i.exec(name);
			const script = join(root, name, "dist", "service.js");
			if (match && existsSync(script)) found.push({ version: match[1], script, source: "extension" });
		}
	}
	let best: FoundService | null = null;
	for (const candidate of found) if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
	return best;
}

/** The version in a launcher file's first line, or null. */
export function launcherVersion(file: string): string | null {
	try {
		const first = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
		return first.startsWith(FIRST_LINE) ? first.slice(FIRST_LINE.length).trim() : null;
	} catch {
		return null;
	}
}

/*
	Copies the launcher bundle to <home>/launcher/rojohub-mcp.cjs with the
	versioned first line: to a temporary name, then renamed over it. A rename
	that fails because a session holds the file is left for the next start. A
	newer launcher is never replaced by an older one.
*/
export function installLauncher(home: string, bundle: string, version: string): "installed" | "same" | "newer" | "failed" {
	try {
		const body = FIRST_LINE + version + "\n" + readFileSync(bundle, "utf8").replace(/^\/\/ rojo-hub-launcher .*\r?\n/, "");
		const target = launcherScript(home);
		const existing = launcherVersion(target);
		if (existing && compareVersions(existing, version) > 0) return "newer";
		try {
			if (readFileSync(target, "utf8") === body) return "same";
		} catch {
			// not there yet
		}
		mkdirSync(launcherDir(home), { recursive: true });
		const temporary = `${target}.${process.pid}.tmp`;
		writeFileSync(temporary, body);
		try {
			renameSync(temporary, target);
		} catch {
			rmSync(temporary, { force: true });
			return "failed";
		}
		return "installed";
	} catch {
		return "failed";
	}
}

/** Deletes the launcher folder (uninstall); a file a running session holds is left, harmlessly. */
export function removeLauncher(home: string): void {
	try {
		rmSync(launcherDir(home), { recursive: true, force: true });
	} catch {
		// left behind
	}
}
