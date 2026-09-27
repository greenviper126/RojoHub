import * as vscode from "vscode";

import type { SlotView } from "../common/api";

/*
	The Projects view: one row per slot, with its warnings and error as child
	rows so they are readable without hovering.
*/

export class SlotItem extends vscode.TreeItem {
	constructor(readonly slot: SlotView) {
		const details = [...(slot.error ? [slot.error.split("\n")[0]] : []), ...slot.warnings];
		super(slot.projectName, details.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		this.id = slot.id;
		this.description = `:${slot.port} · ${slot.targetLabel || "—"}`;
		this.contextValue = slot.state === "running" || slot.state === "starting" ? "slot.running" : "slot.stopped";
		this.iconPath = icon(slot);
		this.tooltip = tooltip(slot);
		this.command = { command: "rojoHub.switch", title: "Switch Branch", arguments: [this] };
	}
}

export class DetailItem extends vscode.TreeItem {
	constructor(text: string, isError: boolean) {
		super(text, vscode.TreeItemCollapsibleState.None);
		this.tooltip = text;
		this.iconPath = new vscode.ThemeIcon(isError ? "error" : "warning", new vscode.ThemeColor(isError ? "errorForeground" : "list.warningForeground"));
	}
}

function icon(slot: SlotView): vscode.ThemeIcon {
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
		`**${slot.projectName}** on \`localhost:${slot.port}\``,
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

export class SlotTree implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private slots: SlotView[] = [];
	private signature = "";

	update(slots: SlotView[]): void {
		const signature = JSON.stringify(slots);
		if (signature === this.signature) return;
		this.signature = signature;
		this.slots = slots;
		this.changed.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (!element) return this.slots.map((slot) => new SlotItem(slot));
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
