/*
	Messages between the sidebar panel (a webview, src/webview) and the
	extension (src/extension/panel.ts). The panel never talks to the service
	itself; the extension does, and sends the panel the result.
*/

import type { GroupView, SlotView, Target, TargetOption } from "./api";

export interface Candidate {
	label: string;
	path: string;
	source: "workspace" | "orca";
}

export interface PanelState {
	service: { running: boolean; version: string | null };
	slots: SlotView[];
	groups: GroupView[];
	settings: { portRange: string; excludedPorts: (number | string)[] };
	/** Slot ids registered from this window's folders, shown first and marked. */
	here: string[];
}

export type ToPanel =
	| { type: "state"; state: PanelState }
	| { type: "targets"; id: string; options: TargetOption[] | null; error?: string }
	| { type: "candidates"; items: Candidate[] }
	| { type: "focus"; id: string }
	| { type: "busy"; key: string; busy: boolean };

export type FromPanel =
	| { type: "ready" }
	| { type: "refresh" }
	| { type: "start"; id: string }
	| { type: "stop"; id: string }
	| { type: "targets"; id: string }
	| { type: "switch"; id: string; target: Target; label: string }
	| { type: "copy"; id: string }
	| { type: "log"; id: string }
	| { type: "remove"; id: string }
	| { type: "candidates" }
	| { type: "addProject"; path: string }
	| { type: "browse" }
	| { type: "newGroup"; name: string }
	| { type: "renameGroup"; id: string; name: string }
	| { type: "deleteGroup"; id: string }
	| { type: "addToGroup"; id: string; slotId: string }
	| { type: "removeFromGroup"; id: string; slotId: string }
	| { type: "startGroup"; id: string; only: boolean }
	| { type: "stopGroup"; id: string }
	| { type: "saveSettings"; portRange: string; excludedPorts: (number | string)[] }
	| { type: "startService" }
	| { type: "stopService" }
	| { type: "walkthrough" };
