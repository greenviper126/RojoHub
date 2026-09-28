import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DisplayOrder, GroupView, SlotView } from "../common/api";
import { expandGroup } from "../common/groups";

interface SavedRegistry {
	order?: { projects?: string[]; groups?: string[] };
	slots?: { id: string; projectName: string; repoPath: string; projectFile: string; port: number; target: SlotView["target"] }[];
	groups?: { id: string; name: string; slotIds: string[]; groupIds?: string[]; active?: boolean }[];
}

/*
	What the service has saved, read straight from its registry.json, for
	showing projects and groups while the service is not running. Everything is
	"offline": whether a Rojo is still serving is only known to the service.
*/
export function savedState(hubHome: string, lastSlots: SlotView[]): { slots: SlotView[]; groups: GroupView[]; order: DisplayOrder } {
	const file = join(hubHome, "registry.json");
	if (!existsSync(file)) return { slots: [], groups: [], order: { projects: [], groups: [] } };
	let saved: SavedRegistry;
	try {
		saved = JSON.parse(readFileSync(file, "utf8")) as SavedRegistry;
	} catch {
		return { slots: [], groups: [], order: { projects: [], groups: [] } };
	}
	const slots: SlotView[] = (saved.slots ?? []).map((record) => {
		const known = lastSlots.find((slot) => slot.id === record.id);
		const label = known?.targetLabel ?? (record.target.kind === "branch" ? record.target.ref.replace(/^refs\/(heads|remotes)\//, "") : basename(record.target.path));
		return {
			id: record.id,
			projectName: record.projectName,
			repoPath: record.repoPath,
			projectFile: record.projectFile,
			port: record.port,
			portSource: known?.portSource ?? "hash",
			state: "offline",
			connections: 0,
			target: record.target,
			targetLabel: label,
			branch: known?.branch ?? null,
			mode: null,
			warnings: [],
			error: null,
			sessionId: null,
			logFile: join(hubHome, "slots", record.id, "rojo.log"),
			targetsAt: 0,
		};
	});
	const records = saved.groups ?? [];
	const groups: GroupView[] = records.map((group) => ({
		id: group.id,
		name: group.name,
		slotIds: group.slotIds,
		groupIds: group.groupIds ?? [],
		active: !!group.active,
		projectIds: expandGroup(records, group.id),
	}));
	return { slots, groups, order: { projects: saved.order?.projects ?? [], groups: saved.order?.groups ?? [] } };
}
