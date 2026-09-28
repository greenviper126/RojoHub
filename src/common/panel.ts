/*
	Messages between the sidebar panel (a webview, src/webview) and the
	extension (src/extension/panel.ts). The panel never talks to the service
	itself; the extension does, and sends the panel the result.
*/

import type { AgentId, AgentStatus, DisplayOrder, GroupView, SlotView, Target, TargetOption } from "./api";

/*
	Something to add to or take out of a group: a project, a nested group, or
	(adding only) a workspace, which adds each of its projects not already in
	the group. `id` is the workspace's file for a workspace.
*/
export interface GroupMember {
	kind: "project" | "group" | "workspace";
	id: string;
}

export interface Candidate {
	label: string;
	path: string;
	source: "workspace" | "orca";
}

/** A VS Code .code-workspace file that holds registered projects or addable folders. */
export interface WorkspaceInfo {
	file: string;
	/** The file name without .code-workspace. */
	name: string;
	/** Registered projects it lists, in its folder order. */
	slotIds: string[];
	/** Folders it lists that have a project file but are not registered yet. */
	addable: { label: string; path: string }[];
	/** The workspace this VS Code window has open. */
	isWindow: boolean;
}

export interface PanelState {
	/** Kept out of sight: the extension starts the service itself. `error` is set only when it could not. */
	service: { running: boolean; version: string | null; error: string | null };
	slots: SlotView[];
	groups: GroupView[];
	settings: { portRange: string; excludedPorts: (number | string)[] };
	/** Slot ids registered from this window's folders, shown first and marked. */
	here: string[];
	/** Workspaces for grouping the Projects list; purely visual. */
	workspaces: WorkspaceInfo[];
	/** The user's arrangement of projects, workspace blocks and groups. */
	order: DisplayOrder;
	/** Agent access (spec 004): VS Code's own agents' box, and Claude Code's and Codex's state read from their config. */
	agents: { url: string; vscode: boolean; list: AgentStatus[] };
	/** Show the "let agents use Studio" notice above Projects (see agentNudge in the extension). */
	agentNudge: boolean;
}

export type ToPanel =
	| { type: "state"; state: PanelState }
	| { type: "targets"; id: string; options: TargetOption[] | null; error?: string }
	| { type: "candidates"; items: Candidate[] }
	| { type: "focus"; id: string }
	/** The title bar's Collapse All: fold everything but Projects, Groups and what is running. */
	| { type: "collapse" }
	/**
	 * A foldable header's right-click menu: fold or unfold `key`, fold the rest of
	 * its `list` and unfold it ("others"), or unfold it and everything inside it ("all").
	 */
	| { type: "fold"; key: string; list: string; how: "expand" | "collapse" | "others" | "all" }
	| { type: "busy"; key: string; busy: boolean }
	/** A picker's Fetch finished; `error` when it failed (the list is unchanged then). */
	| { type: "fetched"; id: string; error?: string }
	/** A picker's New branch finished; `error` keeps the form open with the reason. */
	| { type: "branchCreated"; id: string; error?: string };

export type FromPanel =
	| { type: "ready" }
	| { type: "refresh" }
	| { type: "start"; id: string }
	| { type: "stop"; id: string }
	| { type: "targets"; id: string }
	| { type: "switch"; id: string; target: Target; label: string }
	| { type: "fetch"; id: string }
	| { type: "createBranch"; id: string; name: string; base: string }
	| { type: "build"; id: string }
	| { type: "sourcemap"; id: string }
	| { type: "copy"; id: string }
	| { type: "log"; id: string }
	/** The card's Project file…: pick another *.project.json (spec 005). */
	| { type: "projectFile"; id: string }
	| { type: "remove"; id: string }
	| { type: "candidates" }
	| { type: "addProject"; path: string }
	| { type: "browse" }
	| { type: "newGroup"; name: string }
	| { type: "renameGroup"; id: string; name: string }
	| { type: "deleteGroup"; id: string }
	| { type: "addToGroup"; id: string; member: GroupMember }
	| { type: "removeFromGroup"; id: string; member: GroupMember }
	| { type: "startGroup"; id: string; only: boolean }
	| { type: "stopGroup"; id: string }
	| { type: "resetPortRange" }
	| { type: "saveSettings"; portRange: string; excludedPorts: (number | string)[] }
	| { type: "stopAll" }
	| { type: "reorder"; projects?: string[]; groups?: string[] }
	| { type: "addWorkspace"; file: string }
	| { type: "groupWorkspace"; file: string }
	| { type: "walkthrough" }
	| { type: "setAgent"; id: AgentId | "vscode"; on: boolean }
	| { type: "copyAgentSetup"; what: "commands" | "prompt" }
	/** The notice above Projects: Later hides it for a while, never for good. */
	| { type: "agentNudge"; action: "later" | "never" };
