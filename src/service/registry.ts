import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DisplayOrder, Target } from "../common/api";

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

/** A named set of projects and groups started and stopped together (spec 001, "Groups"). */
export interface GroupRecord {
	id: string;
	name: string;
	slotIds: string[];
	/** Nested groups; missing in registries written before nesting existed. */
	groupIds?: string[];
	/** Started and not stopped since; missing means false. */
	active?: boolean;
}

interface RegistryFile {
	version: 1;
	slots: SlotRecord[];
	groups?: GroupRecord[];
	/** How the panel shows things; never affects ports (see DisplayOrder). */
	order?: DisplayOrder;
}

export class Registry {
	private readonly file: string;
	slots: SlotRecord[] = [];
	groups: GroupRecord[] = [];
	order: DisplayOrder = { projects: [], groups: [] };

	constructor(readonly home: string) {
		this.file = join(home, "registry.json");
		mkdirSync(home, { recursive: true });
		if (existsSync(this.file)) {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as RegistryFile;
			this.slots = parsed.slots ?? [];
			this.groups = parsed.groups ?? [];
			this.order = { projects: parsed.order?.projects ?? [], groups: parsed.order?.groups ?? [] };
		}
	}

	save(): void {
		const body: RegistryFile = { version: 1, slots: this.slots, groups: this.groups, order: this.order };
		const temporary = this.file + ".tmp";
		writeFileSync(temporary, JSON.stringify(body, null, "\t") + "\n");
		renameSync(temporary, this.file);
	}

	get(id: string): SlotRecord {
		const slot = this.slots.find((entry) => entry.id === id);
		if (!slot) throw new NotFound(`No project with id "${id}"`);
		return slot;
	}

	group(id: string): GroupRecord {
		const group = this.groups.find((entry) => entry.id === id);
		if (!group) throw new NotFound(`No group with id "${id}"`);
		return group;
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
