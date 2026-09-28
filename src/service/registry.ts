import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
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
	/** What happened when registry.json could not be read, for service.log; null when it read fine. */
	readonly recovered: string | null = null;

	/*
		Reads registry.json, or the copy of the one before the last save
		(registry.json.bak) when it is damaged: a power cut mid-write, a hand edit.
		The damaged file is kept beside it for the user, never thrown away, and the
		service starts either way; failing here would leave Rojo-Hub unable to
		start until the file was deleted by hand.
	*/
	constructor(readonly home: string) {
		this.file = join(home, "registry.json");
		mkdirSync(home, { recursive: true });
		if (!existsSync(this.file)) return;
		const parsed = readRegistry(this.file);
		if (parsed) {
			this.load(parsed);
			return;
		}
		const kept = join(home, `registry.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
		renameSync(this.file, kept);
		const backup = existsSync(this.file + ".bak") ? readRegistry(this.file + ".bak") : null;
		if (backup) this.load(backup);
		this.recovered = `registry.json could not be read; kept it as ${kept} and ${backup ? "restored the previous save from registry.json.bak" : "started with no projects"}.`;
		this.save();
	}

	private load(parsed: RegistryFile): void {
		this.slots = Array.isArray(parsed.slots) ? parsed.slots : [];
		this.groups = Array.isArray(parsed.groups) ? parsed.groups : [];
		this.order = { projects: parsed.order?.projects ?? [], groups: parsed.order?.groups ?? [] };
	}

	/*
		Writes a temporary file, flushes it to disk, keeps the current file as
		registry.json.bak, then renames the new one into place, so a crash or power
		cut at any point leaves one whole registry to start from.
	*/
	save(): void {
		const body: RegistryFile = { version: 1, slots: this.slots, groups: this.groups, order: this.order };
		const temporary = this.file + ".tmp";
		const fd = openSync(temporary, "w");
		try {
			writeSync(fd, JSON.stringify(body, null, "\t") + "\n");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (existsSync(this.file)) {
			try {
				copyFileSync(this.file, this.file + ".bak");
			} catch {
				// the backup is a convenience; the save itself matters
			}
		}
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

/*
	A registry file's contents, or null when it is damaged (not JSON, not an
	object). A file that cannot be opened at all throws instead: that is a
	locked or unreadable file, not a damaged one, and must not be set aside.
*/
function readRegistry(file: string): RegistryFile | null {
	const text = readFileSync(file, "utf8");
	try {
		const parsed = JSON.parse(text) as RegistryFile | null;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
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
