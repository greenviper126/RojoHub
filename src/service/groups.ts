import type { GroupResult, GroupView } from "../common/api";
import type { Hub } from "./hub";
import { Conflict, NotFound, slugify } from "./registry";

/*
	Project groups: named sets of projects started and stopped together, like
	profiles (spec 001, "Groups"). A project can be in any number of groups.
	Groups hold membership only; each project keeps serving whatever branch it
	was last switched to.
*/
export class Groups {
	constructor(private readonly hub: Hub) {}

	private get registry() {
		return this.hub.registry;
	}

	list(): GroupView[] {
		return this.registry.groups;
	}

	private checkMembers(slotIds: string[]): string[] {
		const unique = [...new Set(slotIds)];
		for (const id of unique) this.registry.get(id);
		return unique;
	}

	private checkName(name: string, except?: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Conflict("A group needs a name");
		const clash = this.registry.groups.find((group) => group.id !== except && group.name.toLowerCase() === trimmed.toLowerCase());
		if (clash) throw new Conflict(`There is already a group called "${clash.name}"`);
		return trimmed;
	}

	create(name: string, slotIds: string[]): GroupView {
		const group: GroupView = { id: "", name: this.checkName(name), slotIds: this.checkMembers(slotIds) };
		let id = slugify(group.name);
		while (this.registry.groups.some((entry) => entry.id === id)) id += "-2";
		group.id = id;
		this.registry.groups.push(group);
		this.registry.save();
		return group;
	}

	update(id: string, changes: { name?: string; slotIds?: string[] }): GroupView {
		const group = this.registry.group(id);
		if (changes.name !== undefined) group.name = this.checkName(changes.name, id);
		if (changes.slotIds !== undefined) group.slotIds = this.checkMembers(changes.slotIds);
		this.registry.save();
		return group;
	}

	remove(id: string): void {
		this.registry.group(id);
		this.registry.groups = this.registry.groups.filter((group) => group.id !== id);
		this.registry.save();
	}

	/*
		Starts every member; with `only`, also stops every serving project outside
		the group, which is what switching to a group as a profile means. Members
		that are already serving are left alone, so their Studio sessions stay.
	*/
	async start(id: string, only: boolean): Promise<GroupResult> {
		const group = this.registry.group(id);
		const result: GroupResult = { group, started: [], stopped: [], failed: [] };
		const members = new Set(group.slotIds);
		const serving = (slotId: string) => {
			const state = this.hub.view(this.registry.get(slotId)).state;
			return state === "running" || state === "starting";
		};
		const work: Promise<void>[] = [];
		if (only) {
			for (const slot of this.registry.slots) {
				if (members.has(slot.id) || !serving(slot.id)) continue;
				work.push(this.run(result, slot.id, "stop"));
			}
		}
		for (const slotId of group.slotIds) {
			if (serving(slotId)) continue;
			work.push(this.run(result, slotId, "start"));
		}
		await Promise.all(work);
		return result;
	}

	async stop(id: string): Promise<GroupResult> {
		const group = this.registry.group(id);
		const result: GroupResult = { group, started: [], stopped: [], failed: [] };
		await Promise.all(group.slotIds.map((slotId) => this.run(result, slotId, "stop")));
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
