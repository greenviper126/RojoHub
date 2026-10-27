/*
	The shapes the background service and the VS Code extension exchange over
	the service's local HTTP API. Both sides import this file, so a change here
	is a change to the protocol.
*/

export const SERVICE_PORT = 34870;
/** The port range when rojoHub.portRange is not set; package.json's setting default must match. */
export const DEFAULT_PORT_RANGE = "34873-35872";
/** rojoHub.claimMinutes when unset or invalid (spec 004). */
export const DEFAULT_CLAIM_MINUTES = 15;
/*
	A claim's `until` when rojoHub.claimMinutes is 0: a time no clock reaches, so
	every "has it run out" check, and claims.json, work unchanged. Only wording
	and the panel need to know it.
*/
export const CLAIM_NEVER = Number.MAX_SAFE_INTEGER;
export const SERVICE_VERSION = "0.22.12";
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
	/** An agent that switched this project and asked to keep it for a while (spec 004); null when none. `until` is CLAIM_NEVER when rojoHub.claimMinutes is 0. */
	claim: { label: string; until: number } | null;
	/** Studio places whose Rojo-Hub plugin is synced to this project now (spec 007). */
	places: StudioPlace[];
	/** The places its project file names (servePlaceIds, placeId; not blockedPlaceIds), for opening them (spec 009). Missing from services older than 0.20.0. */
	listedPlaces?: ListedPlace[];
	/** The Rojo that serves it, once it has answered; null when it has not (the `version` tool reads it). Missing from services older than 0.22.3. */
	rojoVersion?: string | null;
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
	/** For already-open: what said so. A plugin is connected; a process only means a Studio's command line names the place (it may be loading, closing or on its start page). */
	evidence?: "plugin" | "process";
	/** For process evidence: the Studio process IDs. */
	pids?: number[];
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

/*
	Changes the plugin got over its session but could not apply (spec 010):
	sent after each patch that left some, so an agent that switched learns what
	Studio is missing instead of restarting rojo. Missing from older plugins.
*/
export interface StudioUnapplied {
	type: "unapplied";
	sessionId: string;
	/** How many instances or property changes were left out. */
	total: number;
	/** The first few, as Studio paths ("StarterPlayer.StarterCharacterScripts (added)"). */
	items: string[];
}

export type StudioToService = StudioHello | StudioState | StudioUnapplied;

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
	/*
		Set when the user handed this place to this project on purpose (Move on a
		request, the panel's Studio places, request_place's own assignment, yolo): a
		number that is new for each handoff. A plugin that is synced with another
		project then switches once, by itself, and remembers the number; without
		one it never takes over a live session (spec 014). Optional, so older
		plugins, which skip unknown fields, need no protocol bump.
	*/
	handoff?: number;
}

/*
	The service's answer, sent after hello and again whenever it changes. Which
	project a place syncs with is decided in VS Code (spec 007): the plugin only
	connects to `target` and shows `message`.
	- connect: `target` is this place's project, serving; connect to it.
	- choose: several serving projects claim the place; assign one in VS Code.
	- stopped: the place's project is not serving. `restarting` says it is
	  coming back by itself (a crash, a port move), so a plugin that just lost
	  its session waits for the new one without showing the disconnect (spec 010).
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
	restarting?: boolean;
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
	/** The names of the registered projects whose project files list this place; more than one makes it shared (spec 014). Missing from services older than 0.22.2. */
	listedBy?: string[];
}

/*
	An agent's ask to move a Studio place to its project, waiting for the user
	(spec 014). Move saves the assignment the panel makes; Decline ends the ask.
	Kept in the service's memory only.
*/
export interface PlaceRequestView {
	id: string;
	placeId: number;
	/** From the open place or the project's file; null until known. */
	placeName: string | null;
	askerId: string;
	asker: string;
	/** The project that holds the place now; null when none does (the place closed meanwhile). */
	holderId: string | null;
	holder: string | null;
	/** Another agent has claimed the holding project. */
	holderClaimed: boolean;
	since: number;
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
	/** rojoHub.closePlaces: Close and Reopen; missing from services older than 0.22.6. */
	closePlaces?: boolean;
	/** Agents' pending asks for Studio places (spec 014); missing from services older than 0.22.2. */
	placeRequests?: PlaceRequestView[];
}

/** What POST /slots/:id/branch made. */
export interface BranchResult {
	slot: SlotView;
	path: string;
	branch: string;
	/** "orca" when Orca made the worktree, "git" for a git worktree beside the repo. */
	via: "orca" | "git";
	/** The start point actually used: the base, or its remote ref when the local base was behind. */
	from: string;
	/** Fetch or divergence notes for the answer. */
	notes: string[];
	/** False when the worktree's setup commands are still running (the MCP call waits only so long): nothing was switched (spec 012). */
	switched: boolean;
	/** One line per setup command that ran, or the note that setup is still running. */
	setupNotes: string[];
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
	/** rojoHub.openPlaces: open a project's places from the panel and agents (spec 009); missing means off. */
	openPlaces?: boolean;
	/** rojoHub.closePlaces: close and reopen them (Studio still asks about unsaved changes); missing keeps the saved value. */
	closePlaces?: boolean;
	/** rojoHub.claimMinutes (spec 004): how long an agent's claim lasts after its last call; 0 never runs out. Missing keeps the saved value; invalid means 15. */
	claimMinutes?: number;
	/** rojoHub.placeMoves (spec 014): "auto" moves a place an agent asks for at once when no other agent claimed the project holding it; "ask" (missing) asks the user. Missing keeps the saved value. */
	placeMoves?: "ask" | "auto";
	/** rojoHub.yolo (spec 012, design 4): the user lifted the guards. Only pushed once the user accepted the warning; missing means off. */
	yolo?: boolean;
	/** rojoHub.setupCommands: repo path -> commands run in a new worktree before it is first served (spec 012); the service validates it. */
	setupCommands?: unknown;
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
	/**
	 * "connected": its user config has Rojo-Hub's launcher entry; "legacy": the old URL entry, rewritten to the launcher by the service;
	 * "stale": a launcher entry whose program or script is gone, rewritten likewise; "other": an entry named rojohub that is
	 * neither, which is the user's own.
	 */
	state: "connected" | "legacy" | "stale" | "absent" | "other" | "unknown";
	/** The last add or remove that failed, until the next one. */
	error: string | null;
}

/** true adds Rojo-Hub to that agent's config, false removes it (only if it is Rojo-Hub's), missing leaves it alone. */
export type AgentWishes = Partial<Record<AgentId, boolean>>;
