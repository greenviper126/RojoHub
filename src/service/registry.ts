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
	/** The project picked for a Studio place that several serving projects claim, by place ID (spec 007). */
	placeChoices?: Record<string, string>;
	/** The project name each Studio place last synced with, by place ID (spec 007). */
	placeSynced?: Record<string, string>;
}

export class Registry {
	private readonly file: string;
	slots: SlotRecord[] = [];
	groups: GroupRecord[] = [];
	order: DisplayOrder = { projects: [], groups: [] };
	placeChoices: Record<string, string> = {};
	placeSynced: Record<string, string> = {};
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

	/*
		Takes only records that have what the service relies on, so a hand edit
		that breaks one project or group costs that one, not every status the
		service sends.
	*/
	private load(parsed: RegistryFile): void {
		this.slots = Array.isArray(parsed.slots) ? parsed.slots.filter(validSlot) : [];
		this.groups = Array.isArray(parsed.groups) ? parsed.groups.filter(validGroup) : [];
		this.order = { projects: parsed.order?.projects ?? [], groups: parsed.order?.groups ?? [] };
		this.placeChoices = stringMap(parsed.placeChoices);
		this.placeSynced = stringMap(parsed.placeSynced);
	}

	/*
		Writes a temporary file, flushes it to disk, keeps the current file as
		registry.json.bak, then renames the new one into place, so a crash or power
		cut at any point leaves one whole registry to start from.
	*/
	save(): void {
		const body: RegistryFile = {
			version: 1,
			slots: this.slots,
			groups: this.groups,
			order: this.order,
			placeChoices: this.placeChoices,
			placeSynced: this.placeSynced,
		};
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

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A { key: string } object from the file, without entries a hand edit broke. */
function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "string"));
}

function validSlot(slot: SlotRecord): boolean {
	const target = slot?.target as { kind?: unknown; path?: unknown; ref?: unknown } | undefined;
	return (
		!!slot &&
		text(slot.id) &&
		text(slot.projectName) &&
		text(slot.repoPath) &&
		text(slot.projectFile) &&
		Number.isInteger(slot.port) &&
		(target?.kind === "worktree" ? text(target.path) : target?.kind === "branch" && text(target.ref))
	);
}

function validGroup(group: GroupRecord): boolean {
	return !!group && text(group.id) && typeof group.name === "string" && Array.isArray(group.slotIds);
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
