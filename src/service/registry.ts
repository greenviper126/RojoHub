import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Target } from "../common/api";

/*
	The slots the Hub knows about, persisted as JSON in the Hub's folder. Only
	what must survive a restart lives here; process state is rediscovered.
*/

export const PORT_RANGE = { first: 34873, last: 34899 };
/** /JumpTo's port in TheLaundryShift; never handed out. */
export const RESERVED_PORTS = new Set([34872]);

export interface SlotRecord {
	id: string;
	projectName: string;
	/** Primary checkout of the project's repo. */
	repoPath: string;
	/** Project file name relative to a checkout, normally default.project.json. */
	projectFile: string;
	port: number;
	target: Target;
	/** Whether the slot should be serving; restored when the service starts. */
	wantRunning: boolean;
	/** The view folder (under views/<id>/) a branch target is served from. */
	activeView: string | null;
}

interface RegistryFile {
	version: 1;
	slots: SlotRecord[];
}

export class Registry {
	private readonly file: string;
	slots: SlotRecord[] = [];

	constructor(readonly home: string) {
		this.file = join(home, "registry.json");
		mkdirSync(home, { recursive: true });
		if (existsSync(this.file)) {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as RegistryFile;
			this.slots = parsed.slots ?? [];
		}
	}

	save(): void {
		const body: RegistryFile = { version: 1, slots: this.slots };
		const temporary = this.file + ".tmp";
		writeFileSync(temporary, JSON.stringify(body, null, "\t") + "\n");
		renameSync(temporary, this.file);
	}

	get(id: string): SlotRecord {
		const slot = this.slots.find((entry) => entry.id === id);
		if (!slot) throw new NotFound(`No project with id "${id}"`);
		return slot;
	}
}

export class NotFound extends Error {}
export class Conflict extends Error {}

/** A folder- and URL-safe id from a project name. */
export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

/*
	The lowest port in the Hub range that no slot owns and nothing is listening
	on. `isFree` is injected so tests do not need real sockets.
*/
export async function allocatePort(taken: Iterable<number>, isFree: (port: number) => Promise<boolean>): Promise<number> {
	const owned = new Set(taken);
	for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) {
		if (owned.has(port) || RESERVED_PORTS.has(port)) continue;
		if (await isFree(port)) return port;
	}
	throw new Conflict(`No free port left in ${PORT_RANGE.first}-${PORT_RANGE.last}`);
}
