/*
	The shapes the background service and the VS Code extension exchange over
	the service's local HTTP API. Both sides import this file, so a change here
	is a change to the protocol.
*/

export const SERVICE_PORT = 34870;
/** The port range when rojoHub.portRange is not set; package.json's setting default must match. */
export const DEFAULT_PORT_RANGE = "34873-35872";
export const SERVICE_VERSION = "0.20.2";
/** Where the service answers MCP (spec 004). */
export const MCP_URL = `http://127.0.0.1:${SERVICE_PORT}/mcp`;

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

/** A project whose port would change if another project were removed (spec 001, "Ports"). */
export interface PortMove {
	id: string;
	projectName: string;
	from: number;
	to: number;
	/** Serving now, so the move restarts its rojo and Studio has to reconnect. */
	serving: boolean;
}

export interface SlotView {
	id: string;
	projectName: string;
	repoPath: string;
	projectFile: string;
	/** The *.project.json files directly in the project's folder, default first; kept current by the service (spec 005). */
	projectFiles: string[];
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
	/** An agent that switched this project and asked to keep it for a while (spec 004); null when none. */
	claim: { label: string; until: number } | null;
	/** Studio places whose Rojo-Hub plugin is synced to this project now (spec 007). */
	places: StudioPlace[];
	/** The places its project file names (servePlaceIds, placeId; not blockedPlaceIds), for opening them (spec 009). Missing from services older than 0.20.0. */
	listedPlaces?: ListedPlace[];
}

/* One of a project's places on its card, for opening it in Studio (spec 009). */
export interface ListedPlace {
	placeId: number;
	/** From its plugin, else Roblox; null until known (the panel shows the ID). */
	placeName: string | null;
	/** Its Rojo-Hub plugin reports it open. */
	open: boolean;
	busy: "opening" | "closing" | "reopening" | null;
	/** What went wrong with the last open, close or reopen, until the next. */
	error: string | null;
}

/** What opening a place did: nothing when it was open already (Studio would open a second copy). */
export interface PlaceOpened {
	placeId: number;
	placeName: string | null;
	outcome: "opened" | "already-open";
}

/*
	The Studio plugin and the service talk over a WebSocket at
	ws://127.0.0.1:34870/studio, in JSON text messages (spec 007).
	STUDIO_PROTOCOL changes only when these messages do, so a place still
	running an older plugin (Studio loads a new one only when a place is opened)
	keeps working across ordinary updates.
*/
export const STUDIO_PATH = "/studio";
export const STUDIO_PROTOCOL = 2;

/*
	The service greets each new socket with { type: "welcome", protocol,
	serviceVersion }; the plugin answers with hello, and says hello again
	whenever the place's ID changes (a publish). IDs travel as strings, since
	Roblox's JSONEncode may round integers this large; the service reads both.
*/
export interface StudioHello {
	type: "hello";
	protocol: number;
	pluginVersion: string;
	placeId: number;
	gameId: number;
	placeName: string;
	/** PlaceId 0 or a Roblox template's ID (Rojo's ignorePlaceIds): shared by unsaved places, so never matched. */
	unsaved: boolean;
	/** The project name this place last synced with, from the plugin's own saved places. */
	remembered: string | null;
}

/** What the plugin is synced to, sent whenever that changes. */
export interface StudioState {
	type: "state";
	connected: { port: number; projectName: string; sessionId: string } | null;
	/** Rojo's first-sync confirmation is open in this place, waiting for the user (missing from older plugins). */
	confirming?: boolean;
}

export type StudioToService = StudioHello | StudioState;

export interface StudioProject {
	slotId: string;
	projectName: string;
	port: number;
	sessionId: string | null;
	branch: string | null;
	targetLabel: string;
	/** Why it is this place's project. */
	reason: "assigned" | "servePlaceIds" | "placeId" | "remembered";
	/** This place has synced with this project before, so its first-sync confirmation was already accepted. */
	accepted: boolean;
}

/*
	The service's answer, sent after hello and again whenever it changes. Which
	project a place syncs with is decided in VS Code (spec 007): the plugin only
	connects to `target` and shows `message`.
	- connect: `target` is this place's project, serving; connect to it.
	- choose: several serving projects claim the place; assign one in VS Code.
	- stopped: the place's project is not serving.
	- unsupported: the place's project runs a Rojo the plugin cannot speak.
	- unsaved / none: no project for this place; assign one in VS Code.
	- incompatible: the plugin's protocol is not the service's.
*/
export interface StudioMatch {
	type: "match";
	serviceVersion: string;
	status: "connect" | "choose" | "stopped" | "unsupported" | "unsaved" | "none" | "incompatible";
	message: string;
	target: StudioProject | null;
}

/*
	An open Studio place with Rojo-Hub's plugin, as the panel lists it. `key`
	names the place for an assignment: its place ID, or for an unsaved place
	(which shares ID 0 with every other) "studio:<id>" for this one window,
	forgotten when it closes.
*/
export interface StudioPlaceView {
	key: string;
	placeId: number;
	placeName: string;
	unsaved: boolean;
	pluginVersion: string;
	status: StudioMatch["status"];
	message: string;
	/** The project it should sync with, when there is one. */
	projectId: string | null;
	/** Why that is its project. */
	reason: StudioProject["reason"] | null;
	/** The project picked for it in VS Code, if any. */
	assigned: string | null;
	/** Synced now, with this project name. */
	syncedWith: string | null;
	/** Rojo's first-sync confirmation is open in the place, waiting for the user. */
	confirming: boolean;
}

/*
	Whether Rojo-Hub's Studio plugin is in Studio's plugins folder (spec 007).
	"off": rojoHub.studioPlugin is false, so the folder is left alone.
*/
export interface StudioPluginStatus {
	state: "installed" | "off" | "no-studio" | "error";
	detail: string;
	/** Other RojoHub*.rbxm(x) copies taken out of the folder by the last install. */
	removed: string[];
	/** The official Rojo plugin (rojo plugin install) is installed too. */
	officialRojo: boolean;
}

/** An open Studio place, as the panel shows it under the project it is synced to. */
export interface StudioPlace {
	placeId: number;
	placeName: string;
	pluginVersion: string;
}

/*
	Everything the panel draws from the service, as GET /events sends it: once
	when a window subscribes, then each time any of it changes.
*/
export interface Snapshot {
	slots: SlotView[];
	groups: GroupView[];
	order: DisplayOrder;
	/** Missing from services older than 0.19.0. */
	studioPlugin?: StudioPluginStatus;
	/** Open Studio places with Rojo-Hub's plugin (spec 007); missing from services older than 0.19.0. */
	studioPlaces?: StudioPlaceView[];
	/** rojoHub.openPlaces (spec 009); missing from services older than 0.20.0, which cannot open places. */
	openPlaces?: boolean;
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
	/** rojoHub.studioPlugin: keep Rojo-Hub's Studio plugin installed (spec 007); missing means on. */
	studioPlugin?: boolean;
	/*
		rojoHub.studioAutoConnect: "listed" connects a place by itself only when a
		project file lists it (servePlaceIds, placeId) or it is assigned in the
		panel; "remembered" (missing) also reconnects a place to the project it
		last synced with.
	*/
	studioAutoConnect?: "listed" | "remembered";
	/** rojoHub.openPlaces: open, close and reopen a project's places from the panel and agents (spec 009); missing means off. */
	openPlaces?: boolean;
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
	/** Started (Start, or a start with only) and not stopped since. */
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

/* Agents whose own config Rojo-Hub can add its MCP server to (spec 004). */
export type AgentId = "claudeCode" | "codex";

export interface AgentStatus {
	id: AgentId;
	label: string;
	/** Its CLI was found on PATH. */
	installed: boolean;
	/** "connected": its user config has Rojo-Hub's entry; "other": an entry named rojohub with another URL, which is the user's own. */
	state: "connected" | "absent" | "other" | "unknown";
	/** The last add or remove that failed, until the next one. */
	error: string | null;
}

/** true adds Rojo-Hub to that agent's config, false removes it (only if it is Rojo-Hub's), missing leaves it alone. */
export type AgentWishes = Partial<Record<AgentId, boolean>>;
