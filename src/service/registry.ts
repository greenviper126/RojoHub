import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Target } from "../common/api";

/*
	The slots the Hub knows about, persisted as JSON in the Hub's folder. Only
	what must survive a restart lives here; process state is rediscovered.
*/

export interface SlotRecord {
	id: string;
	projectName: string;
	/** Primary checkout of the project's repo. */
	repoPath: string;
	/** Project file name relative to a checkout, normally default.project.json. */
	projectFile: string;
	/** What the port is hashed from: the repo's first commit (see ports.ts). */
	seed: string;
	/** The port last assigned; recomputed from ports.ts's rules, stored to notice moves. */
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
