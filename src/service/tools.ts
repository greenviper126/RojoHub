import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse } from "smol-toml";

/*
	Which rojo binary serves a project: the version its toolchain manifest pins,
	started directly from Rokit's tool storage.

	Starting Rokit's shim (~/.rokit/bin/rojo.exe) instead works, but the shim
	launches the real rojo as a console program of its own; since Rojo-Hub runs
	it with no console, Windows gives that child a new console window, which
	Windows Terminal shows. Starting the real binary with no console avoids the
	window entirely.

	Manifests are looked for the way Rokit does: rokit.toml, aftman.toml and
	foreman.toml in the project folder and each folder above it, then the
	global ~/.rokit/rokit.toml.
*/

const MANIFESTS = ["rokit.toml", "aftman.toml", "foreman.toml"];

export interface ToolSpec {
	author: string;
	name: string;
	version: string;
}

/** Reads a rojo entry from a manifest: "rojo-rbx/rojo@7.7.0", or Foreman's { source, version }. */
export function rojoSpec(text: string): ToolSpec | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
	const tools = parsed.tools as Record<string, unknown> | undefined;
	if (!tools) return null;
	const entry = Object.entries(tools).find(([key]) => key.toLowerCase() === "rojo")?.[1];
	let source: string | undefined;
	let version: string | undefined;
	if (typeof entry === "string") {
		const at = entry.lastIndexOf("@");
		if (at < 0) return null;
		source = entry.slice(0, at);
		version = entry.slice(at + 1);
	} else if (entry && typeof entry === "object") {
		const table = entry as { source?: unknown; github?: unknown; version?: unknown };
		source = typeof table.source === "string" ? table.source : typeof table.github === "string" ? table.github : undefined;
		version = typeof table.version === "string" ? table.version : undefined;
	}
	if (!source || !version) return null;
	const [author, name] = source.split("/");
	if (!author || !name) return null;
	return { author, name, version: version.replace(/^[=v^~]+/, "") };
}

export type ResolvedRojo =
	| { ok: true; binary: string; version: string; manifest: string }
	| { ok: false; error: string };

/*
	Finds the pinned rojo for a project folder. `rokitHome` is injectable for
	tests; normally ~/.rokit (or ROKIT_ROOT).
*/
export function resolveRojo(projectDir: string, rokitHome = process.env.ROKIT_ROOT ?? join(homedir(), ".rokit")): ResolvedRojo {
	const candidates: string[] = [];
	for (let dir = resolve(projectDir); ; dir = dirname(dir)) {
		for (const manifest of MANIFESTS) candidates.push(join(dir, manifest));
		if (dirname(dir) === dir) break;
	}
	candidates.push(join(rokitHome, "rokit.toml"));

	for (const manifest of candidates) {
		if (!existsSync(manifest)) continue;
		const spec = rojoSpec(readFileSync(manifest, "utf8"));
		if (!spec) continue;
		const exe = process.platform === "win32" ? `${spec.name}.exe` : spec.name;
		const binary = join(rokitHome, "tool-storage", spec.author.toLowerCase(), spec.name.toLowerCase(), spec.version, exe);
		if (!existsSync(binary)) {
			return {
				ok: false,
				error: `Rojo ${spec.version} (pinned in ${manifest}) is not installed. Run "rokit install" in ${dirname(manifest)}, or pin a Rojo version you have.`,
			};
		}
		return { ok: true, binary, version: spec.version, manifest };
	}
	return { ok: false, error: `No rokit.toml, aftman.toml or foreman.toml pins Rojo for ${projectDir}. Add one with "rokit add rojo-rbx/rojo".` };
}

/** True for versions older than 7.7, which Rojo-Hub's live switching and connection count were not measured on. */
export function olderThan77(version: string): boolean {
	const [major, minor] = version.split(".").map((part) => Number(part));
	return major < 7 || (major === 7 && minor < 7);
}
