import type { GroupResult, GroupView } from "../common/api";
import { expandGroup, pathBetween } from "../common/groups";
import type { Hub } from "./hub";
import { Conflict, NotFound, slugify, type GroupRecord } from "./registry";

/*
	Groups: named sets of projects and other groups, started and stopped
	together like profiles (spec 001, "Groups"). A project or group can be in
	any number of groups.

	Nesting never loops: adding a group that already contains this one is
	refused with the chain that would loop, and expansion ignores any loop that
	got into registry.json some other way.

	A group is "running" from Start (or Only this) until Stop (or another
	group's Only this). Stopping a group leaves alone any project that another
	running group also contains.
*/

export function toView(groups: GroupRecord[], group: GroupRecord): GroupView {
	return { ...group, groupIds: group.groupIds ?? [], active: !!group.active, projectIds: expandGroup(groups, group.id) };
}

export class Groups {
	constructor(private readonly hub: Hub) {}

	private get registry() {
		return this.hub.registry;
	}

	private get groups(): GroupRecord[] {
		return this.registry.groups;
	}

	list(): GroupView[] {
		return this.groups.map((group) => toView(this.groups, group));
	}

	private checkProjects(slotIds: string[]): string[] {
		const unique = [...new Set(slotIds)];
		for (const id of unique) this.registry.get(id);
		return unique;
	}

	/** Refuses members that do not exist, the group itself, and anything that would make a loop. */
	private checkGroups(parentId: string, groupIds: string[]): string[] {
		const unique = [...new Set(groupIds)];
		const name = (id: string) => this.groups.find((group) => group.id === id)?.name ?? id;
		for (const childId of unique) {
			this.registry.group(childId);
			if (childId === parentId) throw new Conflict(`A group can't contain itself.`);
			const loop = pathBetween(this.groups, childId, parentId);
			if (loop) {
				throw new Conflict(
					`Can't add ${name(childId)} to ${name(parentId)}: ${name(childId)} already contains ${name(parentId)} (${loop.map(name).join(" → ")}), so it would loop.`,
				);
			}
		}
		return unique;
	}

	private checkName(name: string, except?: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Conflict("A group needs a name");
		const clash = this.groups.find((group) => group.id !== except && group.name.toLowerCase() === trimmed.toLowerCase());
		if (clash) throw new Conflict(`There is already a group called "${clash.name}"`);
		return trimmed;
	}

	create(name: string, slotIds: string[] = [], groupIds: string[] = []): GroupView {
		const group: GroupRecord = { id: "", name: this.checkName(name), slotIds: this.checkProjects(slotIds), groupIds: [], active: false };
		let id = slugify(group.name);
		while (this.groups.some((entry) => entry.id === id)) id += "-2";
		group.id = id;
		this.groups.push(group);
		try {
			group.groupIds = this.checkGroups(id, groupIds);
		} catch (error) {
			this.registry.groups = this.groups.filter((entry) => entry !== group);
			throw error;
		}
		this.registry.save();
		return toView(this.groups, group);
	}

	update(id: string, changes: { name?: string; slotIds?: string[]; groupIds?: string[] }): GroupView {
		const group = this.registry.group(id);
		const name = changes.name !== undefined ? this.checkName(changes.name, id) : group.name;
		const slotIds = changes.slotIds !== undefined ? this.checkProjects(changes.slotIds) : group.slotIds;
		const groupIds = changes.groupIds !== undefined ? this.checkGroups(id, changes.groupIds) : (group.groupIds ?? []);
		Object.assign(group, { name, slotIds, groupIds });
		this.registry.save();
		return toView(this.groups, group);
	}

	/** Deletes a group and takes it out of every group that contained it. */
	remove(id: string): void {
		this.registry.group(id);
		this.registry.groups = this.groups.filter((group) => group.id !== id);
		for (const group of this.groups) group.groupIds = (group.groupIds ?? []).filter((child) => child !== id);
		this.registry.save();
	}

	private serving(slotId: string): boolean {
		const state = this.hub.view(this.registry.get(slotId)).state;
		return state === "running" || state === "starting";
	}

	/*
		Starts every project the group holds (through nested groups) that is not
		already serving. With `only`, also stops every serving project outside it
		and marks every other group stopped: the group becomes the profile.
	*/
	async start(id: string, only: boolean): Promise<GroupResult> {
		const group = this.registry.group(id);
		const members = new Set(expandGroup(this.groups, id));
		const result: GroupResult = { group: toView(this.groups, group), started: [], stopped: [], kept: [], failed: [] };
		const work: Promise<void>[] = [];
		if (only) {
			for (const other of this.groups) other.active = false;
			for (const slot of this.registry.slots) {
				if (members.has(slot.id) || !this.serving(slot.id)) continue;
				work.push(this.run(result, slot.id, "stop"));
			}
		}
		for (const slotId of members) {
			if (!this.serving(slotId)) work.push(this.run(result, slotId, "start"));
		}
		group.active = true;
		this.registry.save();
		await Promise.all(work);
		result.group = toView(this.groups, group);
		return result;
	}

	/*
		Stops the group's projects, except those another running group also
		holds: that project is in use elsewhere, so its port keeps serving.
	*/
	async stop(id: string): Promise<GroupResult> {
		const group = this.registry.group(id);
		group.active = false;
		this.registry.save();
		const result: GroupResult = { group: toView(this.groups, group), started: [], stopped: [], kept: [], failed: [] };
		const heldBy = new Map<string, string>();
		for (const other of this.groups) {
			if (!other.active || other.id === id) continue;
			for (const slotId of expandGroup(this.groups, other.id)) if (!heldBy.has(slotId)) heldBy.set(slotId, other.name);
		}
		const work: Promise<void>[] = [];
		for (const slotId of expandGroup(this.groups, id)) {
			const because = heldBy.get(slotId);
			if (because) result.kept.push({ id: slotId, because });
			else if (this.serving(slotId)) work.push(this.run(result, slotId, "stop"));
		}
		await Promise.all(work);
		return result;
	}

	private async run(result: GroupResult, slotId: string, action: "start" | "stop"): Promise<void> {
		try {
			if (action === "start") await this.hub.start(slotId);
			else await this.hub.stop(slotId);
			(action === "start" ? result.started : result.stopped).push(slotId);
		} catch (error) {
			if (error instanceof NotFound) return;
			result.failed.push({ id: slotId, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
