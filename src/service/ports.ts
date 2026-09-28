import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_PORT_RANGE, SERVICE_PORT, type PortSettings } from "../common/api";
import { git } from "./git";

/*
	Which port each project gets. Deterministic, so a project lands on the same
	port on every machine and after every reinstall (spec 001, "Ports"):

	1. A project whose project file sets `servePort` gets exactly that.
	2. Every other project hashes its seed (the repo's first commit) into the
	   range, then steps forward past excluded ports, ports claimed by
	   `servePort`, and ports already taken by projects registered before it.

	Rule 2 follows rule 1: adding a `servePort` that lands on a hashed port moves
	the hashed project, never the other way round.

	The range and the excluded ports are global, set in VS Code's user settings
	(rojoHub.portRange, rojoHub.excludedPorts). The extension sends them to the
	service, which keeps the last ones in settings.json so it can start projects
	with no window open.
*/

const [defaultFirst, defaultLast] = DEFAULT_PORT_RANGE.split("-").map(Number);
export const DEFAULT_RANGE = { first: defaultFirst, last: defaultLast };
/** Rojo's default port (plain `rojo serve`) and Rojo-Hub's own service port; excluded whatever the settings say. */
export const ALWAYS_EXCLUDED = [34872, SERVICE_PORT];

export interface PortConfig {
	first: number;
	last: number;
	exclude: Set<number>;
	/** Problems with the settings; the defaults are used for the broken parts. */
	problems: string[];
}

function isPort(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

/*
	Reads the settings. `portRange` is "first-last"; each `excludedPorts` entry is
	a port or a "first-last" range, as a number or a string.
*/
export function parsePortSettings(settings: PortSettings): PortConfig {
	const config: PortConfig = { first: DEFAULT_RANGE.first, last: DEFAULT_RANGE.last, exclude: new Set(ALWAYS_EXCLUDED), problems: [] };
	const span = (value: unknown): [number, number] | null => {
		if (isPort(value)) return [value, value];
		const match = typeof value === "string" ? /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(value) : null;
		if (!match) return null;
		const first = Number(match[1]);
		const last = match[2] === undefined ? first : Number(match[2]);
		return isPort(first) && isPort(last) && first <= last ? [first, last] : null;
	};
	if (settings.portRange !== undefined && settings.portRange !== "") {
		const range = span(settings.portRange);
		if (range) [config.first, config.last] = range;
		else config.problems.push(`rojoHub.portRange "${settings.portRange}" is not "first-last"; using ${DEFAULT_RANGE.first}-${DEFAULT_RANGE.last}.`);
	}
	for (const entry of settings.excludedPorts ?? []) {
		const range = span(entry);
		if (!range) {
			config.problems.push(`rojoHub.excludedPorts entry ${JSON.stringify(entry)} is not a port or "first-last"; ignored.`);
			continue;
		}
		for (let port = range[0]; port <= range[1]; port++) config.exclude.add(port);
	}
	return config;
}

function settingsFile(home: string): string {
	return join(home, "settings.json");
}

export function loadPortSettings(home: string): PortSettings {
	try {
		return existsSync(settingsFile(home)) ? (JSON.parse(readFileSync(settingsFile(home), "utf8")) as PortSettings) : {};
	} catch {
		return {};
	}
}

export function savePortSettings(home: string, settings: PortSettings): void {
	const clean: PortSettings = { portRange: settings.portRange ?? "", excludedPorts: settings.excludedPorts ?? [], sourcemaps: settings.sourcemaps !== false };
	const temporary = settingsFile(home) + ".tmp";
	writeFileSync(temporary, JSON.stringify(clean, null, "\t") + "\n");
	renameSync(temporary, settingsFile(home));
}

export function loadPortConfig(home: string): PortConfig {
	return parsePortSettings(loadPortSettings(home));
}

/*
	The seed: the repo's oldest root commit. Every clone has it, and renaming the
	repo, its folder or its project does not change it. Oldest, because a repo
	can have later roots (an orphan gh-pages branch); ties go to the smaller
	hash. A repo with no commits yet falls back to the project name.
*/
export async function repoSeed(repo: string, projectName: string): Promise<string> {
	try {
		const out = await git(repo, ["log", "--max-parents=0", "--all", "--format=%ct %H"]);
		const roots = out
			.split(/\r?\n/)
			.map((line) => line.trim().split(" "))
			.filter((parts) => parts.length === 2)
			.map(([time, hash]) => ({ time: Number(time), hash }))
			.sort((a, b) => a.time - b.time || a.hash.localeCompare(b.hash));
		if (roots.length > 0) return `commit:${roots[0].hash}`;
	} catch {
		// no commits yet
	}
	return `name:${projectName}`;
}

export function preferredPort(seed: string, config: Pick<PortConfig, "first" | "last">): number {
	const size = config.last - config.first + 1;
	return config.first + (createHash("sha256").update(seed).digest().readUInt32BE(0) % size);
}

export interface PortRequest {
	id: string;
	name: string;
	seed: string;
	servePort: number | null;
}

export interface PortAssignment {
	port: number | null;
	source: "servePort" | "hash";
	/** Why the port is not the obvious one, or why there is none. */
	note: string | null;
	error: string | null;
}

/*
	Assigns every project at once, in registration order, which is the only
	tie-break: when two hashed projects want the same port, the one registered
	first keeps it.
*/
export function assignPorts(requests: PortRequest[], config: PortConfig): Map<string, PortAssignment> {
	const result = new Map<string, PortAssignment>();
	const owner = new Map<number, string>();

	for (const request of requests) {
		if (request.servePort === null) continue;
		const port = request.servePort;
		if (port === SERVICE_PORT) {
			result.set(request.id, { port: null, source: "servePort", note: null, error: `servePort ${port} is Rojo-Hub's own service port. Pick another port in the project file.` });
			continue;
		}
		const holder = owner.get(port);
		if (holder) {
			result.set(request.id, {
				port: null,
				source: "servePort",
				note: null,
				error: `servePort ${port} is also set by ${holder}; two projects cannot share a port. Change one of them.`,
			});
			continue;
		}
		owner.set(port, request.name);
		result.set(request.id, {
			port,
			source: "servePort",
			note: config.exclude.has(port) ? `servePort ${port} is in rojoHub.excludedPorts; the project file wins.` : null,
			error: null,
		});
	}

	const size = config.last - config.first + 1;
	for (const request of requests) {
		if (request.servePort !== null) continue;
		const preferred = preferredPort(request.seed, config);
		let assigned: PortAssignment | null = null;
		for (let step = 0; step < size; step++) {
			const port = config.first + ((preferred - config.first + step) % size);
			if (config.exclude.has(port) || owner.has(port)) continue;
			let note: string | null = null;
			if (step > 0) {
				const reason = owner.has(preferred) ? `taken by ${owner.get(preferred)}` : "excluded";
				note = `Its own port ${preferred} is ${reason}, so it moved to ${port}. Set "servePort" in its project file to fix a port.`;
			}
			owner.set(port, request.name);
			assigned = { port, source: "hash", note, error: null };
			break;
		}
		result.set(request.id, assigned ?? { port: null, source: "hash", note: null, error: `No free port left in ${config.first}-${config.last}.` });
	}
	return result;
}
