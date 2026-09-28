/*
	The shapes the background service and the VS Code extension exchange over
	the service's local HTTP API. Both sides import this file, so a change here
	is a change to the protocol.
*/

export const SERVICE_PORT = 34870;
/** The port range when rojoHub.portRange is not set; package.json's setting default must match. */
export const DEFAULT_PORT_RANGE = "34873-35872";
export const SERVICE_VERSION = "0.15.1";

/*
	Where a slot's files come from. A worktree is served in place, so edits made
	there (by an agent or by hand) reach Studio. A branch that is not checked out
	anywhere is checked out into one of the slot's Hub-owned view folders.
*/
export type Target = { kind: "worktree"; path: string } | { kind: "branch"; ref: string };

/*
	"offline" is never sent by the service: the extension uses it for projects
	it read from registry.json while the service is not running.
*/
export type SlotState = "stopped" | "starting" | "running" | "error" | "offline";

export interface SlotView {
	id: string;
	projectName: string;
	repoPath: string;
	projectFile: string;
	port: number;
	/** "servePort" when the project file sets it, otherwise "hash" (spec 001, "Ports"). */
	portSource: "servePort" | "hash";
	state: SlotState;
	/** Plugin websocket subscriptions currently open, read from Rojo's own log. */
	connections: number;
	target: Target;
	/** Human label for the target: Orca's worktree name, or the branch. */
	targetLabel: string;
	branch: string | null;
	/** "native" serves the tree's own project file; "borrowed" is a generated copy (see spec 001). */
	mode: "native" | "borrowed" | null;
	warnings: string[];
	error: string | null;
	sessionId: string | null;
	logFile: string;
	/** When the service last read this repo's branch-picker list (ms, 0 if never); a change means a newer list is ready. */
	targetsAt: number;
	/** Whether the service keeps the served worktree's sourcemap.json current, and why not (spec 003). */
	sourcemap: { state: "watching" | "off" | "error"; detail: string };
}

/** What POST /slots/:id/branch made. */
export interface BranchResult {
	slot: SlotView;
	path: string;
	branch: string;
	/** "orca" when Orca made the worktree, "git" for a git worktree beside the repo. */
	via: "orca" | "git";
}

export interface TargetOption {
	target: Target;
	label: string;
	description: string;
	/** Branch name without refs/heads/, or null for a detached worktree. */
	branch: string | null;
	isPrimary: boolean;
	committedAt: number;
}

export interface Health {
	ok: true;
	version: string;
	pid: number;
	home: string;
}

export interface ErrorBody {
	error: string;
}

/*
	The global port settings, from VS Code's user settings rojoHub.portRange and
	rojoHub.excludedPorts. Ranges are "first-last" strings.
*/
/*
	The order the user arranged things in the panel. Kept apart from
	registration order on purpose: registration order decides which project
	keeps a port when two hash to the same one, and dragging a card must never
	move a port. `projects` holds slot ids and workspace block keys
	("ws:<file>", "ws:other"); `groups` holds group ids. Unknown or missing ids
	simply fall back to the default order.
*/
export interface DisplayOrder {
	projects: string[];
	groups: string[];
}

/** The service's settings, sent from VS Code's rojoHub.* user settings. */
export interface PortSettings {
	portRange?: string;
	excludedPorts?: (number | string)[];
	/** rojoHub.sourcemaps; missing means on. */
	sourcemaps?: boolean;
}

/*
	A named set of projects and other groups, started and stopped together.
	Members keep the order they were added in.
*/
export interface GroupView {
	id: string;
	name: string;
	/** Projects directly in the group. */
	slotIds: string[];
	/** Groups directly in the group. */
	groupIds: string[];
	/** Started (Start or Singleton) and not stopped since. */
	active: boolean;
	/** Every project the group holds, through nested groups, each once. */
	projectIds: string[];
}

/** What a group action did to each project; a failure on one does not stop the others. */
export interface GroupResult {
	group: GroupView;
	started: string[];
	stopped: string[];
	/** Left serving by Stop because another running group also holds it. */
	kept: { id: string; because: string }[];
	failed: { id: string; error: string }[];
}
