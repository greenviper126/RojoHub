/*
	Group nesting rules, shared by the service (which enforces them) and the
	panel (which greys out choices that would break them). Works on anything
	with an id, direct project ids and direct group ids.
*/

interface Nestable {
	id: string;
	slotIds: string[];
	groupIds?: string[];
}

/** Every project a group holds, through nested groups, each once, in first-seen order. */
export function expandGroup(groups: Nestable[], id: string): string[] {
	const byId = new Map(groups.map((group) => [group.id, group]));
	const projects: string[] = [];
	const seenProjects = new Set<string>();
	const visited = new Set<string>();
	const walk = (groupId: string) => {
		if (visited.has(groupId)) return;
		visited.add(groupId);
		const group = byId.get(groupId);
		if (!group) return;
		for (const slotId of group.slotIds) {
			if (!seenProjects.has(slotId)) {
				seenProjects.add(slotId);
				projects.push(slotId);
			}
		}
		for (const child of group.groupIds ?? []) walk(child);
	};
	walk(id);
	return projects;
}

/*
	The chain of group ids from `from` down to `to` through nested groups, or
	null when `to` is not inside `from`. Adding `child` to `parent` loops exactly
	when parent is inside child (or they are the same group).
*/
export function pathBetween(groups: Nestable[], from: string, to: string): string[] | null {
	const byId = new Map(groups.map((group) => [group.id, group]));
	const visited = new Set<string>();
	const search = (current: string): string[] | null => {
		if (current === to) return [current];
		if (visited.has(current)) return null;
		visited.add(current);
		for (const child of byId.get(current)?.groupIds ?? []) {
			const rest = search(child);
			if (rest) return [current, ...rest];
		}
		return null;
	};
	return search(from);
}

