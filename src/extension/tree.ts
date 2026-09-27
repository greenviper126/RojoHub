import * as vscode from "vscode";

import type { GroupView, SlotView } from "../common/api";

/*
	The sidebar's two sections, Projects and Groups. Warnings and errors are
	child rows under a project, so they read without hovering.
*/

export class SlotItem extends vscode.TreeItem {
	constructor(
		readonly slot: SlotView,
		/** The group this row sits under in the Groups section, or null in Projects. */
		readonly groupId: string | null,
	) {
		const details = [...(slot.error ? [slot.error.split("\n")[0]] : []), ...slot.warnings];
		super(slot.projectName, details.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		this.id = `${groupId ?? "projects"}/${slot.id}`;
		this.description = `:${slot.port} · ${slot.targetLabel || "—"}`;
		this.contextValue = slot.state === "running" || slot.state === "starting" ? "slot.running" : "slot.stopped";
		this.iconPath = slotIcon(slot);
		this.tooltip = tooltip(slot);
		this.command = { command: "rojoHub.projectMenu", title: "Project Menu", arguments: [slot.id] };
	}
}

export class GroupItem extends vscode.TreeItem {
	constructor(
		readonly group: GroupView,
		readonly members: SlotView[],
	) {
		super(group.name, vscode.TreeItemCollapsibleState.Expanded);
		const serving = members.filter((slot) => slot.state === "running").length;
		this.id = `group/${group.id}`;
		this.description = members.length === 0 ? "empty" : `${serving}/${members.length} serving`;
		this.contextValue = serving === members.length && members.length > 0 ? "group.running" : serving > 0 ? "group.partial" : "group.stopped";
		this.iconPath = new vscode.ThemeIcon(
			"layers",
			serving > 0 && serving === members.length ? new vscode.ThemeColor("testing.iconPassed") : undefined,
		);
		this.tooltip = `${group.name}: ${members.map((slot) => slot.projectName).join(", ") || "no projects"}`;
	}
}

export class DetailItem extends vscode.TreeItem {
	constructor(text: string, isError: boolean) {
		super(text, vscode.TreeItemCollapsibleState.None);
		this.tooltip = text;
		this.iconPath = new vscode.ThemeIcon(isError ? "error" : "warning", new vscode.ThemeColor(isError ? "errorForeground" : "list.warningForeground"));
	}
}

function slotIcon(slot: SlotView): vscode.ThemeIcon {
	switch (slot.state) {
		case "running":
			return slot.connections > 0
				? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"))
				: new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("testing.iconPassed"));
		case "starting":
			return new vscode.ThemeIcon("loading~spin");
		case "error":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
		default:
			return new vscode.ThemeIcon("circle-slash");
	}
}

function tooltip(slot: SlotView): vscode.MarkdownString {
	const studio =
		slot.state !== "running" ? "—" : slot.connections === 0 ? "no plugin connected" : `${slot.connections} plugin${slot.connections === 1 ? "" : "s"} connected`;
	const lines = [
		`**${slot.projectName}** on \`localhost:${slot.port}\`${slot.portSource === "servePort" ? " (servePort)" : ""}`,
		"",
		`State: ${slot.state} · Studio: ${studio}`,
		`Serving: ${slot.targetLabel}${slot.branch && slot.branch !== slot.targetLabel ? ` (${slot.branch})` : ""}`,
		`Mode: ${slot.mode ?? "—"}`,
		`Repo: ${slot.repoPath}`,
	];
	if (slot.error) lines.push("", "**Error**", "```", slot.error, "```");
	for (const warning of slot.warnings) lines.push("", `⚠ ${warning}`);
	return new vscode.MarkdownString(lines.join("\n"));
}

/*
	Backs both sidebar sections. "projects" lists every project; "groups" lists
	the groups, each holding its projects. A project in several groups appears
	under each.
*/
export class SlotTree implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private slots: SlotView[] = [];
	private groups: GroupView[] = [];
	private signature = "";

	constructor(private readonly section: "projects" | "groups") {}

	update(slots: SlotView[], groups: GroupView[]): void {
		const signature = JSON.stringify(this.section === "projects" ? slots : [slots, groups]);
		if (signature === this.signature) return;
		this.signature = signature;
		this.slots = slots;
		this.groups = groups;
		this.changed.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (!element) {
			if (this.section === "projects") return this.slots.map((slot) => new SlotItem(slot, null));
			return this.groups.map(
				(group) => new GroupItem(group, group.slotIds.map((id) => this.slots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot)),
			);
		}
		if (element instanceof GroupItem) return element.members.map((slot) => new SlotItem(slot, element.group.id));
		if (element instanceof SlotItem) {
			const slot = element.slot;
			return [
				...(slot.error ? [new DetailItem(slot.error.split("\n")[0], true)] : []),
				...slot.warnings.map((warning) => new DetailItem(warning, false)),
			];
		}
		return [];
	}
}
