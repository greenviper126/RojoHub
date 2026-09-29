import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import * as vscode from "vscode";

import { MCP_URL, SERVICE_VERSION, type AgentStatus, type DisplayOrder, type GroupResult, type GroupView, type SlotView, type Snapshot, type TargetOption, type StudioPluginStatus, type StudioPlaceView } from "../common/api";
import { pathBetween } from "../common/groups";
import { pathKey } from "../common/paths";
import { defaultProjectFile, DEFAULT_PROJECT_FILE, isProjectFileName, listProjectFiles } from "../common/projectFiles";
import { compareVersions } from "../common/version";
import type { Candidate, FromPanel, GroupMember, WorkspaceInfo } from "../common/panel";
import { actedOn, askOnce, changedWishes, copySetup, reconcileAgents, registerVsCodeAgents, setAgentBox, trackAgentBoxes, vscodeAgentsOn } from "./agents";
import { hideAgentNudge, showAgentNudge } from "./nudge";
import { client, ensureService, expectedHome } from "./client";
import { savedState } from "./saved";
import { findWorkspaces } from "./workspaces";
import { HubPanel } from "./panel";

/*
	The front end. All state lives in the background service; this follows it
	(its GET /events stream, else polling), draws it in the sidebar panel
	(panel.ts, src/webview) and the status bar, and sends it commands.
	"Rojo-Hub: Open Menu" offers the same actions as quick picks for keyboard
	use.
*/

/** How often the service is polled while its event stream is not connected. */
const POLL_MS = 2000;
/*
	While the stream is connected it carries projects, groups and order the
	moment they change; the rest (the service's health and version, agents,
	workspace files) is read this often.
*/
const SLOW_POLL_MS = 10000;
/** No bytes on the stream for this long (the service sends a keep-alive every 15 s) means the connection died unnoticed. */
const STREAM_SILENCE_MS = 40000;
const WINDOWS_ONLY = "Rojo-Hub supports Windows only for now.";

let panel: HubPanel;
let extensionContext: vscode.ExtensionContext;
let serviceScript = "";
let serviceHealth: { running: boolean; version: string | null; error: string | null } = { running: false, version: null, error: null };
/** A start of the service already under way, so concurrent callers wait for the same one. */
let starting: Promise<void> | null = null;
/** The service's state folder: from its /health once seen, else where it puts it by default. */
let hubHome = expectedHome();
let statusItem: vscode.StatusBarItem;
let workspaceRepos: string[] = [];
let lastSlots: SlotView[] = [];
let lastGroups: GroupView[] = [];
/** The Studio plugin's install, from the last snapshot (spec 007). */
let lastStudioPlugin: StudioPluginStatus | null = null;
/** Open Studio places, from the last snapshot (spec 007). */
let lastStudioPlaces: StudioPlaceView[] = [];
/** rojoHub.openPlaces as the service has it (spec 009). */
let lastOpenPlaces = false;
let lastOrder: DisplayOrder = { projects: [], groups: [] };
let lastAgents: AgentStatus[] = [];
/** The event stream is connected and has sent a snapshot, so projects, groups and order need no polling. */
let streaming = false;
/** Snapshots applied so far, so a slower poll that started before one never overwrites it. */
let snapshots = 0;
let lastFullRefresh = 0;
let disposed = false;
/** Every project's branch-picker list, fetched ahead so a picker opens with it drawn; with the targetsAt it was fetched for. */
const targetLists = new Map<string, TargetOption[]>();
const targetStamps = new Map<string, number>();
/** The adder's folders and Orca repos, worked out ahead so it opens with them listed. */
let lastCandidates: Candidate[] | null = null;
let candidatesSignature = "";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));


/** Primary checkouts by folder; a folder's repo does not change while the window is open. */
const primaries = new Map<string, Promise<string | null>>();

function primaryOf(folder: string): Promise<string | null> {
	const key = pathKey(folder);
	let found = primaries.get(key);
	if (!found) {
		found = new Promise((done) => {
			execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, windowsHide: true }, (error, stdout) => {
				done(error ? null : resolve(dirname(stdout.trim())));
			});
		});
		primaries.set(key, found);
	}
	return found;
}

let lastWorkspaces: WorkspaceInfo[] = [];
let workspaceSignature = "";

/*
	Re-reads the workspace files when the set of projects or the window's
	workspace changes, or when forced (Refresh, after adding). The files are
	small, but there is no reason to read them every two seconds.
*/
async function refreshWorkspaces(force = false): Promise<void> {
	const windowFile = vscode.workspace.workspaceFile?.scheme === "file" ? vscode.workspace.workspaceFile.fsPath : null;
	const signature = JSON.stringify([windowFile, lastSlots.map((slot) => [slot.id, slot.repoPath])]);
	if (!force && signature === workspaceSignature) return;
	workspaceSignature = signature;
	lastWorkspaces = await findWorkspaces({ windowFile, slots: lastSlots, primaryOf }).catch(() => []);
}

/*
	The service is plumbing the user never manages: whenever it is not running
	it is started, here. A failure is kept in serviceHealth.error for the panel
	and retried on the next action or Refresh, not on every poll, so a broken
	install does not spawn a process every two seconds.
*/
async function ensureRunning(): Promise<void> {
	if (await client.health()) return;
	starting ??= (async () => {
		try {
			if (process.platform !== "win32") throw new Error(WINDOWS_ONLY);
			await ensureService(serviceScript);
			await pushSettings();
			serviceHealth.error = null;
		} catch (error) {
			serviceHealth.error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			starting = null;
		}
	})();
	await starting;
}

const TOLD_TO_RELOAD = "rojoHub.toldToReload";

/*
	A newer service than this window's extension means Rojo-Hub was updated,
	either in another VS Code profile or without this window being reloaded.
	It keeps working against the newer service, but its panel code is old, so
	it says so once per service version. That is remembered per profile: in a
	profile that still has the old version installed, reloading cannot help,
	so asking again in every window would only nag.
*/
function checkOutdated(serviceVersion: string | undefined): void {
	if (!serviceVersion || compareVersions(serviceVersion, SERVICE_VERSION) <= 0) return;
	if (extensionContext.globalState.get<string>(TOLD_TO_RELOAD) === serviceVersion) return;
	void extensionContext.globalState.update(TOLD_TO_RELOAD, serviceVersion);
	void vscode.window
		.showInformationMessage(
			`Rojo-Hub ${serviceVersion} is running, but this window has ${SERVICE_VERSION}. Reload the window; if this VS Code profile still has ${SERVICE_VERSION} installed, install the update in this profile too.`,
			"Reload Window",
		)
		.then((choice) => {
			if (choice) void vscode.commands.executeCommand("workbench.action.reloadWindow");
		});
}

async function refresh(): Promise<void> {
	let health = await client.health();
	if (!health && !serviceHealth.error) {
		await ensureRunning().catch(() => undefined);
		health = await client.health();
	}
	serviceHealth = { running: !!health, version: health?.version ?? null, error: health ? null : serviceHealth.error };
	checkOutdated(health?.version);
	if (health?.home) hubHome = health.home;
	lastFullRefresh = Date.now();
	/*
		No health while the stream still looks open means the service stalled or
		went away: drop the stream, so its reconnect starts with a whole snapshot
		instead of this window waiting for a change that may never be sent.
	*/
	if (!health && streaming) stopFollowing();
	if (!health || !streaming) {
		// A snapshot that arrives while these are read is newer than they are; it wins.
		const generation = snapshots;
		try {
			const read: [SlotView[], GroupView[], DisplayOrder] = health ? await Promise.all([client.slots(), client.groups(), client.order()]) : [[], [], lastOrder];
			if (generation === snapshots) [lastSlots, lastGroups, lastOrder] = [read[0], read[1], read[2]];
		} catch {
			if (generation === snapshots) {
				lastSlots = [];
				lastGroups = [];
			}
		}
	}
	lastAgents = health ? await client.agents().catch(() => lastAgents) : lastAgents;
	if (!health) ({ slots: lastSlots, groups: lastGroups, order: lastOrder } = savedState(hubHome, lastSlots));
	noticeDisconnects(health ? lastSlots : []);
	if (health) {
		noticePortMoves(lastSlots);
		prefetch();
	}
	await refreshWorkspaces();
	render();
}

/*
	A snapshot from the event stream: drawn at once, before anything slower.
	Workspace files are re-read (and the panel drawn again) only when the set of
	projects changed.
*/
async function applySnapshot(snapshot: Snapshot): Promise<void> {
	snapshots++;
	lastSlots = snapshot.slots;
	lastGroups = snapshot.groups;
	lastOrder = snapshot.order;
	lastStudioPlugin = snapshot.studioPlugin ?? null;
	lastStudioPlaces = snapshot.studioPlaces ?? [];
	lastOpenPlaces = snapshot.openPlaces === true;
	noticeDisconnects(lastSlots);
	noticePortMoves(lastSlots);
	render();
	prefetch();
	await refreshWorkspaces();
	render();
}

/*
	Keeps the panel's dropdowns filled before they are opened: each project's
	branch list whenever the service says it read a newer one (targetsAt), and
	the adder's candidates whenever the projects or the window's folders change.
	The panel keeps what it is sent, so opening never waits on a request.
*/
function prefetch(): void {
	for (const slot of lastSlots) {
		if (targetStamps.get(slot.id) === slot.targetsAt) continue;
		targetStamps.set(slot.id, slot.targetsAt);
		void client.targets(slot.id).then(
			(options) => {
				targetLists.set(slot.id, options);
				panel.post({ type: "targets", id: slot.id, options });
			},
			() => undefined,
		);
	}
	const signature = JSON.stringify([lastSlots.map((slot) => slot.repoPath), (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)]);
	if (signature === candidatesSignature) return;
	candidatesSignature = signature;
	void postCandidates();
}

async function postCandidates(): Promise<void> {
	lastCandidates = await candidates().catch(() => lastCandidates ?? []);
	panel.post({ type: "candidates", items: lastCandidates });
}

/*
	Follows the service's event stream for as long as this window is open, so
	a change made anywhere (another window, an agent, a crash, Studio
	connecting) shows within a fraction of a second. When the stream is down
	(the service restarting or being replaced by a newer one), polling takes
	over until it is back.
*/
async function follow(): Promise<void> {
	let delay = 250;
	while (!disposed) {
		if (serviceHealth.running) {
			const controller = new AbortController();
			let watchdog = setTimeout(() => controller.abort(), STREAM_SILENCE_MS);
			const alive = () => {
				clearTimeout(watchdog);
				watchdog = setTimeout(() => controller.abort(), STREAM_SILENCE_MS);
			};
			const stop = () => controller.abort();
			stopFollowing = stop;
			try {
				await client.events(
					(snapshot) => {
						streaming = true;
						delay = 250;
						void applySnapshot(snapshot);
					},
					alive,
					controller.signal,
				);
			} catch {
				// the service went away or was replaced; reconnect below
			}
			clearTimeout(watchdog);
			streaming = false;
		}
		if (disposed) return;
		await sleep(delay);
		delay = Math.min(delay * 2, 4000);
	}
}

let stopFollowing: () => void = () => undefined;

function render(): void {
	const config = vscode.workspace.getConfiguration("rojoHub");
	panel.update({
		service: serviceHealth,
		slots: lastSlots,
		groups: lastGroups,
		settings: { portRange: config.get<string>("portRange", ""), excludedPorts: config.get<(number | string)[]>("excludedPorts", []) },
		here: lastSlots.filter((slot) => workspaceRepos.includes(pathKey(slot.repoPath))).map((slot) => slot.id),
		workspaces: lastWorkspaces,
		order: lastOrder,
		agents: { url: MCP_URL, vscode: vscodeAgentsOn(), list: lastAgents },
		agentNudge: serviceHealth.running && showAgentNudge(hubHome, lastSlots.length, lastAgents),
		studioPlugin: serviceHealth.running ? lastStudioPlugin : null,
		studioPlaces: serviceHealth.running ? lastStudioPlaces : [],
		// The service's copy of rojoHub.openPlaces decides; a service older than 0.20.0 cannot open places.
		openPlaces: serviceHealth.running && lastOpenPlaces,
	});
	updateStatus();
}

/** Each project's port at the last poll, to notice one that moved. */
let lastPorts: Map<string, number> | null = null;

/*
	Says when a project's port moved (a removal, a servePort, the port settings,
	another project file), since Studio's Rojo plugin still has the old one. Like
	noticeDisconnects, only a window with the project open, or else the focused
	window, says it.
*/
function noticePortMoves(slots: SlotView[]): void {
	const before = lastPorts;
	lastPorts = new Map(slots.filter((slot) => slot.port > 0).map((slot) => [slot.id, slot.port]));
	if (!before) return;
	for (const slot of slots) {
		const from = before.get(slot.id);
		if (!from || slot.port <= 0 || from === slot.port) continue;
		if (!workspaceRepos.includes(pathKey(slot.repoPath)) && !vscode.window.state.focused) continue;
		void vscode.window
			.showWarningMessage(`Rojo-Hub: ${slot.projectName} moved from port ${from} to ${slot.port}. Places with Rojo-Hub's Studio plugin reconnect by themselves; with Rojo's own plugin, set its port to ${slot.port}.`, "Copy Port", "Show Project")
			.then(async (choice) => {
				if (choice === "Copy Port") await vscode.env.clipboard.writeText(String(slot.port));
				if (choice === "Show Project") void panel.focus(slot.id);
			});
	}
}

/** Each serving project's Studio connections at the last poll, to notice a drop to none. */
let lastConnections = new Map<string, number>();

/*
	rojoHub.notifyOnStudioDisconnect (off by default): says when a serving
	project's Studio connections drop to none. Every window polls, so only a
	window with the project open, or else the focused window, says it.
*/
function noticeDisconnects(slots: SlotView[]): void {
	const before = lastConnections;
	lastConnections = new Map(slots.filter((slot) => slot.state === "running").map((slot) => [slot.id, slot.connections]));
	if (!vscode.workspace.getConfiguration("rojoHub").get<boolean>("notifyOnStudioDisconnect", false)) return;
	for (const slot of slots) {
		if (!((before.get(slot.id) ?? 0) > 0 && lastConnections.get(slot.id) === 0)) continue;
		const here = workspaceRepos.includes(pathKey(slot.repoPath));
		const openElsewhere = !here && vscode.window.state.focused;
		if (!here && !openElsewhere) continue;
		void vscode.window
			.showInformationMessage(`Rojo-Hub: Studio disconnected from ${slot.projectName} (:${slot.port}). Rojo is still serving.`, "Show Project")
			.then((choice) => {
				if (choice) void panel.focus(slot.id);
			});
	}
}

/*
	The status bar shows the slot for this window's repo, so every window says
	which port and branch its project is on.
*/
function updateStatus(): void {
	const slot = lastSlots.find((entry) => workspaceRepos.includes(pathKey(entry.repoPath)));
	if (!slot) {
		statusItem.hide();
		return;
	}
	const connected = slot.state === "running" && slot.connections > 0;
	const icon =
		slot.state === "error" ? "$(error)" : slot.state === "offline" ? "$(debug-disconnect)" : slot.state !== "running" ? "$(circle-slash)" : connected ? "$(pass-filled)" : "$(circle-large-outline)";
	statusItem.text = `${icon} Rojo :${slot.port} · ${slot.targetLabel}`;
	statusItem.tooltip = `${slot.projectName}: ${slot.state}${slot.state === "running" ? `, ${slot.connections} Studio connection(s)` : ""}. Click to show it in the Rojo-Hub panel.`;
	statusItem.command = { command: "rojoHub.focusProject", title: "Rojo-Hub", arguments: [slot.id] };
	statusItem.show();
}

async function pickSlot(argument: unknown, placeholder: string): Promise<SlotView | undefined> {
	if (typeof argument === "string") return lastSlots.find((slot) => slot.id === argument);
	await refresh();
	if (lastSlots.length === 0) {
		void vscode.window.showInformationMessage("No Rojo-Hub projects yet. Add one first.");
		return undefined;
	}
	const own = lastSlots.find((slot) => workspaceRepos.includes(pathKey(slot.repoPath)));
	const items = lastSlots.map((slot) => ({ label: slot.projectName, description: `:${slot.port} · ${slot.targetLabel}`, slot }));
	if (own) items.sort((a, b) => Number(b.slot === own) - Number(a.slot === own));
	return (await vscode.window.showQuickPick(items, { placeHolder: placeholder }))?.slot;
}

/** Runs a command with a progress notification and turns failures into error messages. */
async function run<T>(title: string, work: () => Promise<T>, needsService = true): Promise<T | undefined> {
	try {
		return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
			if (needsService) await ensureRunning();
			return work();
		});
	} catch (error) {
		void vscode.window.showErrorMessage(`Rojo-Hub: ${error instanceof Error ? error.message : error}`);
		return undefined;
	} finally {
		await refresh();
	}
}

interface TargetPick extends vscode.QuickPickItem {
	option?: TargetOption;
}

interface MenuItem extends vscode.QuickPickItem {
	run?: () => unknown;
}

function stateText(slot: SlotView): string {
	if (slot.state === "running") return slot.connections > 0 ? `serving · Studio connected (${slot.connections})` : "serving · no Studio connected";
	if (slot.state === "error") return `error · ${(slot.error ?? "").split("\n")[0]}`;
	return slot.state;
}

function slotIcon(slot: SlotView): string {
	if (slot.state === "error") return "$(error)";
	if (slot.state === "starting") return "$(loading~spin)";
	if (slot.state !== "running") return "$(circle-slash)";
	return slot.connections > 0 ? "$(pass-filled)" : "$(circle-large-outline)";
}

/*
	Everything in one place, like Rojo's own "Rojo: Open Menu": the projects,
	then Hub-wide actions. Picking a project opens its actions.
*/
async function openMenu(): Promise<void> {
	await refresh();
	const items: MenuItem[] = lastSlots.map((slot) => ({
		label: `${slotIcon(slot)} ${slot.projectName}`,
		description: `:${slot.port} · ${slot.targetLabel}`,
		detail: stateText(slot),
		run: () => projectMenu(slot.id),
	}));
	if (lastGroups.length > 0) items.push({ label: "Groups", kind: vscode.QuickPickItemKind.Separator });
	for (const group of lastGroups) {
		const members = groupMembers(group);
		const serving = members.filter((slot) => slot.state === "running").length;
		items.push({
			label: `$(layers) ${group.name}`,
			description: members.map((slot) => slot.projectName).join(", ") || "empty",
			detail: `${serving}/${members.length} serving`,
			run: () => groupMenu(group.id),
		});
	}
	items.push(
		{ label: "Rojo-Hub", kind: vscode.QuickPickItemKind.Separator },
		{ label: "$(add) Add Project", run: () => addProject() },
		{ label: "$(new-folder) New Group", description: "a set of projects to start together", run: () => newGroup() },
		{ label: "$(gear) Port Settings", description: "range and globally excluded ports", run: () => vscode.commands.executeCommand("workbench.action.openSettings", "rojoHub") },
		{ label: "$(robot) Agent Access", description: "which AI agents can use Rojo-Hub's tools", run: () => vscode.commands.executeCommand("workbench.action.openSettings", "rojoHub.agents") },
		{ label: "$(debug-stop) Stop All", description: "stop every serving project", run: () => vscode.commands.executeCommand("rojoHub.stopAll") },
	);
	const picked = await vscode.window.showQuickPick(items, { title: "Rojo-Hub", placeHolder: "Pick a project, or an action", matchOnDescription: true });
	await picked?.run?.();
}

async function projectMenu(id: string): Promise<void> {
	await refresh();
	const slot = lastSlots.find((entry) => entry.id === id);
	if (!slot) return openMenu();
	const serving = slot.state === "running" || slot.state === "starting";
	const stopItem: MenuItem = { label: "$(debug-stop) Stop Serving", run: () => vscode.commands.executeCommand("rojoHub.stop", slot.id) };
	const startItem: MenuItem = { label: "$(play) Start Serving", description: `on port ${slot.port}`, run: () => vscode.commands.executeCommand("rojoHub.start", slot.id) };
	const items: MenuItem[] = [
		{ label: "$(git-branch) Switch Branch…", description: `now ${slot.targetLabel}`, run: () => switchSlot(slot.id) },
		// A project in error can be started again, or stopped so it stops retrying.
		...(serving ? [stopItem] : slot.state === "error" ? [startItem, stopItem] : [startItem]),
		{ label: "$(copy) Copy Port", description: `${slot.port}`, run: () => vscode.commands.executeCommand("rojoHub.copyAddress", slot.id) },
		fileLocked(slot)
			? { label: "$(lock) Project File", description: `${slot.projectFile} · stop the project to change it` }
			: { label: "$(file-code) Project File…", description: `now ${slot.projectFile}`, run: () => changeProjectFile(slot, null) },
		{ label: "$(output) Show Rojo Log", run: () => vscode.commands.executeCommand("rojoHub.showLog", slot.id) },
		{ label: "$(trash) Remove Project", run: () => vscode.commands.executeCommand("rojoHub.removeProject", slot.id) },
		{ label: "", kind: vscode.QuickPickItemKind.Separator },
		{ label: "$(arrow-left) All Projects", run: () => openMenu() },
	];
	const warnings = [...(slot.error ? [slot.error.split("\n")[0]] : []), ...slot.warnings];
	const picked = await vscode.window.showQuickPick(items, {
		title: `${slot.projectName} · :${slot.port} · ${stateText(slot)}`,
		placeHolder: warnings.length > 0 ? `⚠ ${warnings[0]}` : "What should this project do?",
	});
	await picked?.run?.();
}

/** Every project a group holds, through nested groups. */
function groupMembers(group: GroupView): SlotView[] {
	return group.projectIds.map((id) => lastSlots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
}

async function pickGroup(argument: unknown, placeholder: string): Promise<GroupView | undefined> {
	if (typeof argument === "string") return lastGroups.find((group) => group.id === argument);
	await refresh();
	if (lastGroups.length === 0) {
		void vscode.window.showInformationMessage("No Rojo-Hub groups yet. Make one with New Group.");
		return undefined;
	}
	const items = lastGroups.map((group) => ({ label: group.name, description: groupMembers(group).map((slot) => slot.projectName).join(", "), group }));
	return (await vscode.window.showQuickPick(items, { placeHolder: placeholder }))?.group;
}

/*
	Makes an empty group from just a name, then offers the add dropdown for its
	first project. More are added one at a time with the group's + button.
*/
async function newGroup(): Promise<void> {
	const taken = new Set(lastGroups.map((group) => group.name.toLowerCase()));
	let suggestion = "New Group";
	for (let n = 2; taken.has(suggestion.toLowerCase()); n++) suggestion = `New Group ${n}`;
	const name = await vscode.window.showInputBox({
		title: "New Group",
		prompt: "Name the group. Add its projects afterwards with its + button.",
		value: suggestion,
		valueSelection: [0, suggestion.length],
	});
	if (!name?.trim()) return;
	const group = await run(`Creating ${name.trim()}`, () => client.createGroup(name, []));
	if (group) await addToGroup(group.id);
}

/* The dropdown behind a group's + button: the projects not in it yet. */
async function addToGroup(argument: unknown): Promise<void> {
	const group = await pickGroup(argument, "Add a project to which group?");
	if (!group) return;
	await refresh();
	const current = lastGroups.find((entry) => entry.id === group.id) ?? group;
	type Pick = vscode.QuickPickItem & { member?: GroupMember };
	const workspaces = lastWorkspaces
		.map((workspace) => ({ workspace, missing: workspace.slotIds.filter((id) => !current.slotIds.includes(id)) }))
		.filter(({ missing }) => missing.length > 0);
	const items: Pick[] = [
		...(workspaces.length ? [{ label: "Workspaces · adds each of their projects", kind: vscode.QuickPickItemKind.Separator }] : []),
		...workspaces.map(({ workspace, missing }) => ({
			label: `$(folder-library) ${workspace.name}`,
			description: `adds ${missing.length} project${missing.length === 1 ? "" : "s"}`,
			member: { kind: "workspace" as const, id: workspace.file },
		})),
		{ label: "Projects", kind: vscode.QuickPickItemKind.Separator },
		...lastSlots
			.filter((slot) => !current.slotIds.includes(slot.id))
			.map((slot) => ({ label: `${slotIcon(slot)} ${slot.projectName}`, description: `:${slot.port} · ${slot.targetLabel}`, member: { kind: "project" as const, id: slot.id } })),
		{ label: "Groups", kind: vscode.QuickPickItemKind.Separator },
		...lastGroups
			.filter((other) => other.id !== current.id && !current.groupIds.includes(other.id) && !pathBetween(lastGroups, other.id, current.id))
			.map((other) => ({ label: `$(layers) ${other.name}`, description: `${other.projectIds.length} projects`, member: { kind: "group" as const, id: other.id } })),
	];
	if (!items.some((item) => item.member)) {
		void vscode.window.showInformationMessage(`There is nothing left to add to ${current.name}.`);
		return;
	}
	const picked = await vscode.window.showQuickPick(items, { title: `Add to ${current.name}`, placeHolder: "Pick a workspace, project or group to add" });
	if (picked?.member) await addMember(current, picked.member);
}

async function renameGroup(argument: unknown): Promise<void> {
	const group = await pickGroup(argument, "Rename which group?");
	if (!group) return;
	const name = await vscode.window.showInputBox({ title: `Rename ${group.name}`, value: group.name });
	if (name?.trim() && name.trim() !== group.name) await run(`Renaming ${group.name}`, () => client.updateGroup(group.id, { name }));
}

async function deleteGroup(argument: unknown): Promise<void> {
	const group = await pickGroup(argument, "Delete which group?");
	if (!group) return;
	const sure = await vscode.window.showWarningMessage(
		`Delete the group ${group.name}? Its projects stay registered and keep serving.`,
		{ modal: true },
		"Delete Group",
	);
	if (sure) await run(`Deleting ${group.name}`, () => client.deleteGroup(group.id));
}

/** Tells the user about projects a group action could not start or stop. */
function reportGroup(result: GroupResult | undefined): void {
	if (!result) return;
	const name = (id: string) => lastSlots.find((slot) => slot.id === id)?.projectName ?? id;
	if (result.failed.length > 0) {
		void vscode.window.showErrorMessage(`Rojo-Hub (${result.group.name}): ${result.failed.map((entry) => `${name(entry.id)}: ${entry.error.split("\n")[0]}`).join("; ")}`);
	}
	if (result.kept.length > 0) {
		void vscode.window.showInformationMessage(
			`Rojo-Hub: stopped ${result.group.name}, but kept ${result.kept.map((entry) => `${name(entry.id)} (in ${entry.because})`).join(", ")} running because another running group uses it.`,
		);
	}
}

function reportStopAll(result: { stopped: string[]; failed: { id: string; error: string }[] }): void {
	if (result.failed.length === 0) return;
	const name = (id: string) => lastSlots.find((slot) => slot.id === id)?.projectName ?? id;
	void vscode.window.showErrorMessage(`Rojo-Hub: could not stop ${result.failed.map((entry) => `${name(entry.id)} (${entry.error.split("\n")[0]})`).join(", ")}`);
}

/*
	Adds a project, a group, or every project of a workspace not already in the
	group. The service refuses group loops with the chain that would loop.
*/
async function addMember(group: GroupView, member: GroupMember): Promise<void> {
	let changes: { slotIds?: string[]; groupIds?: string[] };
	if (member.kind === "workspace") {
		const workspace = lastWorkspaces.find((entry) => entry.file === member.id);
		if (!workspace) return;
		changes = { slotIds: [...group.slotIds, ...workspace.slotIds.filter((id) => !group.slotIds.includes(id))] };
	} else {
		changes = member.kind === "project" ? { slotIds: [...group.slotIds, member.id] } : { groupIds: [...group.groupIds, member.id] };
	}
	await act(`group:${group.id}`, () => client.updateGroup(group.id, changes));
}

async function removeMember(group: GroupView, member: GroupMember): Promise<void> {
	if (member.kind === "workspace") return; // workspaces are added as their projects, never stored
	const changes =
		member.kind === "project" ? { slotIds: group.slotIds.filter((id) => id !== member.id) } : { groupIds: group.groupIds.filter((id) => id !== member.id) };
	await act(`group:${group.id}`, () => client.updateGroup(group.id, changes));
}

async function startGroup(argument: unknown): Promise<void> {
	const group = await pickGroup(argument, "Start which group?");
	if (!group) return;
	reportGroup(await run(`Starting ${group.name}`, () => client.startGroup(group.id, false)));
}

async function stopGroup(argument: unknown): Promise<void> {
	const group = await pickGroup(argument, "Stop which group?");
	if (!group) return;
	reportGroup(await run(`Stopping ${group.name}`, () => client.stopGroup(group.id)));
}

async function groupMenu(id: string): Promise<void> {
	await refresh();
	const group = lastGroups.find((entry) => entry.id === id);
	if (!group) return openMenu();
	const members = groupMembers(group);
	const items: MenuItem[] = [
		{ label: "$(play) Start Group", description: "serve every project in it", run: () => startGroup(group.id) },
		{ label: "$(debug-stop) Stop Group", run: () => stopGroup(group.id) },
		{ label: "$(add) Add Project to Group", run: () => addToGroup(group.id) },
		{ label: "$(edit) Rename Group", run: () => renameGroup(group.id) },
		{ label: "$(trash) Delete Group", run: () => deleteGroup(group.id) },
	];
	if (members.length > 0) items.push({ label: "Projects", kind: vscode.QuickPickItemKind.Separator });
	for (const slot of members) {
		items.push({ label: `${slotIcon(slot)} ${slot.projectName}`, description: `:${slot.port} · ${slot.targetLabel}`, detail: stateText(slot), run: () => projectMenu(slot.id) });
	}
	items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(arrow-left) All Projects", run: () => openMenu() });
	const serving = members.filter((slot) => slot.state === "running").length;
	const picked = await vscode.window.showQuickPick(items, { title: `${group.name} · ${serving}/${members.length} serving` });
	await picked?.run?.();
}

async function switchSlot(argument: unknown): Promise<void> {
	const slot = await pickSlot(argument, "Which project?");
	if (!slot) return;
	const picker = vscode.window.createQuickPick<TargetPick>();
	picker.title = `${slot.projectName} on :${slot.port}`;
	picker.placeholder = "Serve which worktree or branch? Studio stays connected.";
	picker.matchOnDescription = true;
	picker.busy = true;
	picker.show();
	try {
		const options = await client.targets(slot.id);
		const current = (option: TargetOption) =>
			(option.target.kind === "worktree" && slot.target.kind === "worktree" && pathKey(option.target.path) === pathKey(slot.target.path)) ||
			(option.target.kind === "branch" && slot.target.kind === "branch" && option.target.ref === slot.target.ref);
		const worktrees = options.filter((option) => option.target.kind === "worktree");
		const branches = options.filter((option) => option.target.kind === "branch");
		const item = (option: TargetOption): TargetPick => ({
			label: `${current(option) ? "$(check) " : ""}${option.target.kind === "worktree" ? "$(folder)" : "$(git-branch)"} ${option.label}`,
			description: option.description,
			option,
		});
		picker.items = [
			{ label: "Worktrees", kind: vscode.QuickPickItemKind.Separator },
			...worktrees.map(item),
			{ label: "Branches (served from a Hub view)", kind: vscode.QuickPickItemKind.Separator },
			...branches.map(item),
		];
	} catch (error) {
		picker.hide();
		void vscode.window.showErrorMessage(`Rojo-Hub: ${error instanceof Error ? error.message : error}`);
		return;
	} finally {
		picker.busy = false;
	}
	const chosen = await new Promise<TargetOption | undefined>((done) => {
		picker.onDidAccept(() => done(picker.selectedItems[0]?.option));
		picker.onDidHide(() => done(undefined));
	});
	picker.hide();
	if (!chosen) return;
	const result = await run(`Switching ${slot.projectName} to ${chosen.label}`, () => client.switch(slot.id, chosen.target));
	if (result && result.state !== "running") {
		const start = await vscode.window.showInformationMessage(`${slot.projectName} now points at ${chosen.label} but is not serving.`, "Start Serving");
		if (start) await run(`Starting ${slot.projectName}`, () => client.start(slot.id));
	}
}

/** Folders that could be added: this window's folders, then Orca's repos, minus registered ones. */
async function candidates(): Promise<Candidate[]> {
	const known = new Set(lastSlots.map((slot) => pathKey(slot.repoPath)));
	const found: Candidate[] = [];
	const seen = (path: string) => known.has(pathKey(path)) || found.some((item) => pathKey(item.path) === pathKey(path));
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const primary = await primaryOf(folder.uri.fsPath);
		if (primary && !seen(primary)) found.push({ label: folder.name, path: primary, source: "workspace" });
	}
	for (const repo of await orcaRepos()) {
		if (!seen(repo.path)) found.push({ label: repo.displayName, path: resolve(repo.path), source: "orca" });
	}
	return found;
}

async function browseForProject(): Promise<string | undefined> {
	const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Add Project", title: "Pick a folder with a Rojo project file" });
	return chosen?.[0]?.fsPath;
}

/*
	The project file to add a folder with (spec 005): default.project.json
	without asking, else the folder's only *.project.json, else the user picks.
	Undefined when there is none or the user cancels.
*/
async function projectFileFor(path: string): Promise<string | undefined> {
	const files = listProjectFiles(path);
	const chosen = defaultProjectFile(files);
	if (chosen) return chosen;
	if (files.length === 0) {
		void vscode.window.showErrorMessage(`Rojo-Hub: ${path} has no ${DEFAULT_PROJECT_FILE} or other *.project.json.`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(files, { title: "Which project file should Rojo serve?", placeHolder: "You can change it later with Project file… in the project's ⋯ menu" });
	return picked;
}

/* The project's quick pick: Project File… lists the folder's *.project.json files. */
async function changeProjectFile(slot: SlotView, busyKey: string | null): Promise<void> {
	const files = listProjectFiles(slot.repoPath);
	if (files.length === 0) {
		void vscode.window.showErrorMessage(`Rojo-Hub: ${slot.repoPath} has no *.project.json files.`);
		return;
	}
	const items = files.map((file) => ({
		label: file === slot.projectFile ? `$(check) ${file}` : `$(blank) ${file}`,
		description: file === slot.projectFile ? "serving now" : file === DEFAULT_PROJECT_FILE ? "default" : undefined,
		file,
	}));
	const picked = await vscode.window.showQuickPick(items, { title: `${slot.projectName}: project file`, placeHolder: "Which project file should Rojo serve?" });
	if (picked) await useProjectFile(slot, picked.file, busyKey);
}

/*
	Browse… in the card's project file list: a file dialog that starts in the
	project's folder. Only a *.project.json directly in that folder is taken,
	since that is where the project's file must be on every branch.
*/
async function browseProjectFile(slot: SlotView): Promise<void> {
	const chosen = await vscode.window.showOpenDialog({
		defaultUri: vscode.Uri.file(slot.repoPath),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { "Rojo project files": ["json"] },
		openLabel: "Serve This File",
		title: `${slot.projectName}: pick a *.project.json in its folder`,
	});
	const path = chosen?.[0]?.fsPath;
	if (!path) return;
	const file = basename(path);
	if (pathKey(dirname(path)) !== pathKey(slot.repoPath) || !isProjectFileName(file)) {
		void vscode.window.showErrorMessage(`Rojo-Hub: pick a *.project.json directly in ${slot.repoPath}. A project serves a project file from its own folder, so every branch has it in the same place.`);
		return;
	}
	await useProjectFile(slot, file, `slot:${slot.id}`);
}

/*
	A running or starting project's project file is shown, not changed: stop it
	first (spec 005). An erroring one can change it, e.g. to a file the branch has.
*/
function fileLocked(slot: SlotView): boolean {
	return slot.state === "running" || slot.state === "starting";
}

/* Switches a project to `file`. */
async function useProjectFile(slot: SlotView, file: string, busyKey: string | null): Promise<void> {
	if (file === slot.projectFile) return;
	if (fileLocked(slot)) {
		void vscode.window.showInformationMessage(`Stop ${slot.projectName} to change its project file; it is serving ${slot.projectFile}.`);
		return;
	}
	if (busyKey) await act(busyKey, () => client.setProjectFile(slot.id, file));
	else await run(`Switching ${slot.projectName} to ${file}`, () => client.setProjectFile(slot.id, file));
}

async function addProject(): Promise<void> {
	const items: (vscode.QuickPickItem & { path?: string })[] = (await candidates()).map((item) => ({
		label: `${item.source === "orca" ? "$(repo)" : "$(folder)"} ${item.label}`,
		description: item.path,
		path: item.path,
	}));
	items.push({ label: "$(folder-opened) Browse…" });
	const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which project should get a Rojo port?" });
	if (!picked) return;
	const path = picked.path ?? (await browseForProject());
	if (!path) return;
	const file = await projectFileFor(path);
	if (!file) return;
	const added = await run("Adding project", () => client.add(path!, file));
	if (!added) return;
	const start = await vscode.window.showInformationMessage(
		`${added.projectName} has port ${added.port}. Its Studio places sync by themselves with Rojo-Hub's plugin when its project file lists them in servePlaceIds; otherwise pick it once in the place's Rojo window.`,
		"Start Serving",
	);
	if (start) await run(`Starting ${added.projectName}`, () => client.start(added.id));
}

/*
	Sends the user-level port settings to the service. They are application
	scoped, so every window sends the same values.
*/
async function pushSettings(): Promise<void> {
	const config = vscode.workspace.getConfiguration("rojoHub");
	await client
		.putSettings({
			portRange: config.get<string>("portRange", ""),
			excludedPorts: config.get<(number | string)[]>("excludedPorts", []),
			sourcemaps: config.get<boolean>("sourcemaps", true),
			studioPlugin: config.get<boolean>("studioPlugin", true),
			studioAutoConnect: config.get<string>("studioAutoConnect", "remembered") === "listed" ? "listed" : "remembered",
			openPlaces: config.get<boolean>("openPlaces", false),
		})
		.catch((error) => void vscode.window.showErrorMessage(`Rojo-Hub: could not apply port settings: ${error instanceof Error ? error.message : error}`));
}

/*
	Agent access (spec 004): sends only the boxes the user changed since this
	window last acted on them (agents.ts), never the whole setting. A failure
	shows on that agent's row in the panel.
*/
async function pushAgentChanges(): Promise<void> {
	const changed = changedWishes();
	if (Object.keys(changed).length === 0) return;
	lastAgents = await client.putAgents(changed).catch(() => lastAgents);
}

function orcaRepos():Promise<{ path: string; displayName: string }[]> {
	return new Promise((done) => {
		execFile("orca", ["repo", "list", "--json"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
			if (error) return done([]);
			try {
				const parsed = JSON.parse(stdout) as { result?: { repos?: { path: string; displayName: string }[] } };
				done(parsed.result?.repos ?? []);
			} catch {
				done([]);
			}
		});
	});
}

/*
	Runs one panel action: the panel's progress bar while it works, errors as
	a notification, then fresh state (which clears the button's busy look).
*/
async function act<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
	try {
		return await panel.progress(async () => {
			await ensureRunning();
			return work();
		});
	} catch (error) {
		void vscode.window.showErrorMessage(`Rojo-Hub: ${error instanceof Error ? error.message : error}`);
		return undefined;
	} finally {
		postIdle(key);
		await refresh();
	}
}

/*
	New branch from the picker. Errors go back to the picker's form, where the
	name was typed; success shows the project's card and offers to open the
	new worktree in a window of its own.
*/
async function createBranch(id: string, name: string, base: string): Promise<void> {
	try {
		const result = await panel.progress(async () => {
			await ensureRunning();
			return client.createBranch(id, name, base);
		});
		panel.post({ type: "branchCreated", id });
		await refresh();
		void panel.focus(id);
		const where = result.via === "orca" ? "an Orca worktree" : result.path;
		const choice = await vscode.window.showInformationMessage(
			`Rojo-Hub: made ${result.branch} from ${base} in ${where}; ${result.slot.projectName} now serves it.`,
			"Open in New Window",
		);
		if (choice) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(result.path), { forceNewWindow: true });
	} catch (error) {
		panel.post({ type: "branchCreated", id, error: error instanceof Error ? error.message : String(error) });
		await refresh();
	}
}

const BUILD_FOLDER = "rojoHub.buildFolder";

/** A file name part with the characters Windows forbids in file names replaced. */
function fileNamePart(text: string): string {
	return text.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/[. ]+$/, "") || "build";
}

/*
	Build place file: a save dialog prefilled with <project>-<branch>.rbxl in
	the folder last built into, else Documents (never the repo, where it would
	be an untracked file), then rojo build of exactly what the project serves.
*/
async function buildPlace(slot: SlotView): Promise<void> {
	const label = fileNamePart(slot.branch ?? slot.targetLabel ?? "build");
	const documents = join(homedir(), "Documents");
	const remembered = extensionContext.globalState.get<string>(BUILD_FOLDER);
	const folder = remembered && existsSync(remembered) ? remembered : existsSync(documents) ? documents : homedir();
	const target = await vscode.window.showSaveDialog({
		title: `Build a place file of ${slot.projectName} (${slot.targetLabel})`,
		defaultUri: vscode.Uri.file(join(folder, `${fileNamePart(slot.projectName)}-${label}.rbxl`)),
		filters: { "Roblox place": ["rbxl", "rbxlx"] },
		saveLabel: "Build",
	});
	if (!target) {
		postIdle(`build:${slot.id}`);
		return;
	}
	await extensionContext.globalState.update(BUILD_FOLDER, dirname(target.fsPath));
	const built = await act(`build:${slot.id}`, () => client.build(slot.id, target.fsPath));
	if (!built) return;
	const size = built.bytes >= 1 << 20 ? `${(built.bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(built.bytes / 1024))} KB`;
	const choice = await vscode.window.showInformationMessage(`Rojo-Hub: built ${slot.projectName} (${slot.targetLabel}) into ${target.fsPath} (${size}).`, "Reveal in File Explorer");
	if (choice) await vscode.commands.executeCommand("revealFileInOS", target);
}

/*
	Asks before removing a project, naming every other project that takes a
	different port because of it (one it had pushed off its own port moves
	back), and which of those Studio has to reconnect to.
*/
async function confirmRemove(slot: SlotView): Promise<boolean> {
	const moves = await client.portMovesOnRemove(slot.id).catch(() => []);
	const detail = moves
		.map((move) => `${move.projectName} moves from port ${move.from} to ${move.to}${move.serving ? `; it is serving, so Studio disconnects (places with Rojo-Hub's plugin reconnect by themselves)` : ""}.`)
		.join("\n");
	const sure = await vscode.window.showWarningMessage(
		`Remove ${slot.projectName} from Rojo-Hub? Its Rojo stops and port ${slot.port} is freed; the project's files are not touched.`,
		{ modal: true, detail: detail || undefined },
		"Remove",
	);
	return sure === "Remove";
}

/* A project that was never started has no rojo.log yet; say so instead of a file-not-found error. */
async function showLog(slot: SlotView): Promise<void> {
	if (!existsSync(slot.logFile)) {
		void vscode.window.showInformationMessage(`${slot.projectName} has no Rojo log yet; it appears once the project has been started.`);
		return;
	}
	await vscode.window.showTextDocument(vscode.Uri.file(slot.logFile), { preview: true });
}

/** busy:false messages sent per key, so onPanel can tell whether an action already said it is over. */
const idleSent = new Map<string, number>();

function postIdle(key: string): void {
	idleSent.set(key, (idleSent.get(key) ?? 0) + 1);
	panel.post({ type: "busy", key, busy: false });
}

/*
	The busy key the panel waits on for a message, and how many busy:false it
	expects (Add all adds each folder as an action of its own). The same keys as
	sendTracked in src/webview/main.ts.
*/
function trackedKey(message: FromPanel): { key: string; count: number } | null {
	switch (message.type) {
		case "start":
		case "stop":
		case "switch":
		case "setProjectFile":
		case "sourcemap":
			return { key: `slot:${message.id}`, count: 1 };
		case "build":
			return { key: `build:${message.id}`, count: 1 };
		case "startGroup":
		case "stopGroup":
		case "renameGroup":
		case "deleteGroup":
		case "addToGroup":
		case "removeFromGroup":
			return { key: `group:${message.id}`, count: 1 };
		case "newGroup":
		case "groupWorkspace":
			return { key: "group:new", count: 1 };
		case "stopAll":
			return { key: "stop-all", count: 1 };
		case "reorder":
			return { key: "reorder", count: 1 };
		case "setAgent":
			return { key: `agent:${message.id}`, count: 1 };
		case "placeAction":
			return { key: `place:${message.id}:${message.placeId}`, count: 1 };
		case "openAllPlaces":
			return { key: `places:${message.id}`, count: 1 };
		case "addProject":
			return { key: "add", count: 1 };
		case "addWorkspace":
			return { key: "add", count: lastWorkspaces.find((entry) => entry.file === message.file)?.addable.length ?? 0 };
		default:
			return null;
	}
}

/*
	The panel draws some actions ahead of the service (src/webview/pending.ts)
	and ends that look on the action's busy:false. An action that stops early
	(a quick pick or dialog cancelled, a group or workspace that is gone) must
	still send it, exactly as many times as the panel waits for, or the look
	would stay until it times out.
*/
async function onPanel(message: FromPanel): Promise<void> {
	const tracked = trackedKey(message);
	const before = tracked ? (idleSent.get(tracked.key) ?? 0) : 0;
	try {
		await handlePanel(message);
	} finally {
		if (tracked) for (let sent = (idleSent.get(tracked.key) ?? 0) - before; sent < tracked.count; sent++) postIdle(tracked.key);
	}
}

async function handlePanel(message: FromPanel): Promise<void> {
	const slot = "id" in message ? lastSlots.find((entry) => entry.id === message.id) : undefined;
	switch (message.type) {
		case "ready":
			// A panel that was just drawn (or redrawn) gets the lists fetched ahead at once.
			for (const [id, options] of targetLists) panel.post({ type: "targets", id, options });
			if (lastCandidates) panel.post({ type: "candidates", items: lastCandidates });
			return refresh();
		case "refresh":
			serviceHealth.error = null;
			workspaceSignature = "";
			candidatesSignature = "";
			targetStamps.clear();
			await act("service", async () => undefined);
			return;
		case "addWorkspace": {
			const workspace = lastWorkspaces.find((entry) => entry.file === message.file);
			if (!workspace) return;
			for (const folder of workspace.addable) {
				const file = await projectFileFor(folder.path);
				if (file) await act("add", () => client.add(folder.path, file));
			}
			workspaceSignature = "";
			await refresh();
			return;
		}
		case "groupWorkspace": {
			const workspace = lastWorkspaces.find((entry) => entry.file === message.file);
			if (!workspace || workspace.slotIds.length === 0) return;
			const taken = new Set(lastGroups.map((group) => group.name.toLowerCase()));
			let name = workspace.name;
			for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${workspace.name} ${n}`;
			await act("group:new", () => client.createGroup(name, workspace.slotIds));
			return;
		}
		case "reorder":
			await act("reorder", () => client.putOrder({ projects: message.projects, groups: message.groups }));
			return;
		case "stopAll":
			await act("stop-all", async () => reportStopAll(await client.stopAll()));
			return;
		case "start":
			await act(`slot:${message.id}`, () => client.start(message.id));
			return;
		case "stop":
			await act(`slot:${message.id}`, () => client.stop(message.id));
			return;
		case "targets":
			try {
				await ensureRunning();
				const options = await client.targets(message.id);
				targetLists.set(message.id, options);
				panel.post({ type: "targets", id: message.id, options });
			} catch (error) {
				panel.post({ type: "targets", id: message.id, options: null, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		case "switch":
			await act(`slot:${message.id}`, () => client.switch(message.id, message.target));
			return;
		case "fetch":
			try {
				await ensureRunning();
				panel.post({ type: "targets", id: message.id, options: await client.fetch(message.id) });
				panel.post({ type: "fetched", id: message.id });
			} catch (error) {
				panel.post({ type: "fetched", id: message.id, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		case "createBranch":
			return createBranch(message.id, message.name, message.base);
		case "build":
			if (slot) await buildPlace(slot);
			return;
		case "sourcemap": {
			const written = await act(`slot:${message.id}`, () => client.sourcemap(message.id));
			if (written) void vscode.window.setStatusBarMessage(`$(check) Rojo-Hub wrote ${written.path}`, 4000);
			return;
		}
		case "copy":
			if (!slot) return;
			await vscode.env.clipboard.writeText(String(slot.port));
			void vscode.window.setStatusBarMessage(`$(copy) Copied port ${slot.port}`, 2500);
			return;
		case "log":
			if (slot) await showLog(slot);
			return;
		case "setProjectFile":
			if (slot) await useProjectFile(slot, message.file, `slot:${slot.id}`);
			return;
		case "browseProjectFile":
			if (slot) await browseProjectFile(slot);
			return;
		case "remove":
			if (slot && (await confirmRemove(slot))) await act(`slot:${slot.id}`, () => client.remove(slot.id));
			return;
		case "candidates":
			// What is known now at once, then a fresh look (Orca's repos can take a moment).
			if (lastCandidates) panel.post({ type: "candidates", items: lastCandidates });
			await postCandidates();
			return;
		case "addProject":
		case "browse": {
			const path = message.type === "addProject" ? message.path : await browseForProject();
			const file = path ? await projectFileFor(path) : undefined;
			if (!path || !file) return;
			const added = await act("add", () => client.add(path, file));
			workspaceSignature = "";
			if (added) await panel.focus(added.id);
			return;
		}
		case "newGroup":
			await act("group:new", () => client.createGroup(message.name, []));
			return;
		case "renameGroup":
			await act(`group:${message.id}`, () => client.updateGroup(message.id, { name: message.name }));
			return;
		case "deleteGroup":
			await act(`group:${message.id}`, () => client.deleteGroup(message.id));
			return;
		case "addToGroup":
		case "removeFromGroup": {
			const group = lastGroups.find((entry) => entry.id === message.id);
			if (!group) return;
			if (message.type === "addToGroup") await addMember(group, message.member);
			else await removeMember(group, message.member);
			return;
		}
		case "startGroup":
			reportGroup(await act(`group:${message.id}`, () => client.startGroup(message.id, message.only)));
			return;
		case "stopGroup":
			reportGroup(await act(`group:${message.id}`, () => client.stopGroup(message.id)));
			return;
		case "resetPortRange":
			// Removing the key from settings.json brings back the built-in default range.
			await vscode.workspace.getConfiguration("rojoHub").update("portRange", undefined, vscode.ConfigurationTarget.Global);
			return;
		case "saveSettings": {
			const config = vscode.workspace.getConfiguration("rojoHub");
			await config.update("portRange", message.portRange, vscode.ConfigurationTarget.Global);
			await config.update("excludedPorts", message.excludedPorts, vscode.ConfigurationTarget.Global);
			return;
		}
		case "walkthrough":
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${extensionContext.extension.id}#rojoHub.start`, false);
			return;
		case "setAgent":
			await act(`agent:${message.id}`, async () => {
				if (!(await setAgentBox(message.id, message.on)) || message.id === "vscode") return;
				// Sent even when the box already said so: ticking an agent whose entry was removed by hand adds it again.
				actedOn(message.id, message.on);
				lastAgents = await client.putAgents({ [message.id]: message.on });
			});
			return;
		case "copyAgentSetup":
			return copySetup(message.what);
		case "agentNudge":
			hideAgentNudge(hubHome, message.action);
			return refresh();
		case "placeAction": {
			const name = slot?.listedPlaces?.find((place) => place.placeId === message.placeId)?.placeName ?? `place ${message.placeId}`;
			await act(`place:${message.id}:${message.placeId}`, async () => {
				if (message.action === "open") {
					const opened = await client.openPlace(message.id, message.placeId);
					if (opened.outcome === "already-open") void vscode.window.showInformationMessage(`Rojo-Hub: ${opened.placeName ?? name} is already open in Studio.`);
					else void vscode.window.setStatusBarMessage(`$(device-desktop) Rojo-Hub is opening ${opened.placeName ?? name} in Studio`, 5000);
				} else if (message.action === "close") {
					await client.closePlace(message.id, message.placeId);
				} else {
					await client.reopenPlace(message.id, message.placeId);
				}
			});
			return;
		}
		case "openAllPlaces":
			await act(`places:${message.id}`, async () => {
				const results = await client.openAllPlaces(message.id);
				const failed = results.filter((result): result is { placeId: number; error: string } => "error" in result);
				const opened = results.filter((result) => "outcome" in result && result.outcome === "opened").length;
				if (failed.length > 0) void vscode.window.showErrorMessage(`Rojo-Hub: ${failed.map((result) => result.error).join(" ")}`);
				void vscode.window.setStatusBarMessage(opened > 0 ? `$(device-desktop) Rojo-Hub is opening ${opened} place${opened === 1 ? "" : "s"} in Studio` : "Rojo-Hub: every place is already open", 5000);
			});
			return;
		case "assignPlace":
			await act(`place:${message.key}`, async () => {
				lastStudioPlaces = await client.assignPlace(message.key, message.slotId);
				render();
			});
			return;
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionContext = context;
	panel = new HubPanel(context.extensionUri, onPanel);
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(HubPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }), statusItem);

	serviceScript = context.asAbsolutePath("dist/service.js");

	/*
		Rojo-Hub is Windows-only for now: the service starts rojo from Rokit's
		Windows tool storage and relies on Windows paths throughout. Elsewhere the
		panel says so and nothing is started.
	*/
	if (process.platform !== "win32") {
		const message = WINDOWS_ONLY;
		serviceHealth = { running: false, version: null, error: message };
		panel.update({
			service: serviceHealth,
			slots: [],
			groups: [],
			settings: { portRange: "", excludedPorts: [] },
			here: [],
			workspaces: [],
			order: lastOrder,
			agents: { url: MCP_URL, vscode: false, list: [] },
			agentNudge: false,
			studioPlugin: null,
			studioPlaces: [],
			openPlaces: false,
		});
		void vscode.window.showWarningMessage(message);
		return;
	}

	const postFold = (argument: unknown, how: "expand" | "collapse" | "others" | "all") => {
		const { rojoHubFoldKey: key, rojoHubFoldList: list } = (argument ?? {}) as { rojoHubFoldKey?: unknown; rojoHubFoldList?: unknown };
		if (typeof key === "string" && typeof list === "string") panel.post({ type: "fold", key, list, how });
	};
	const commands: Record<string, (argument?: unknown) => unknown> = {
		"rojoHub.openMenu": () => openMenu(),
		"rojoHub.projectMenu": (argument) => (typeof argument === "string" ? projectMenu(argument) : openMenu()),
		"rojoHub.addProject": () => addProject(),
		"rojoHub.newGroup": () => newGroup(),
		"rojoHub.editGroup": (argument) => renameGroup(argument),
		"rojoHub.addToGroup": (argument) => addToGroup(argument),
		"rojoHub.focusProject": (argument) => (typeof argument === "string" ? panel.focus(argument) : vscode.commands.executeCommand(`${HubPanel.viewId}.focus`)),
		"rojoHub.deleteGroup": (argument) => deleteGroup(argument),
		"rojoHub.startGroup": (argument) => startGroup(argument),
		"rojoHub.stopGroup": (argument) => stopGroup(argument),
		"rojoHub.groupMenu": (argument) => (typeof argument === "string" ? groupMenu(argument) : openMenu()),
		"rojoHub.switch": (argument) => switchSlot(argument),
		"rojoHub.start": async (argument) => {
			const slot = await pickSlot(argument, "Start which project?");
			if (slot) await run(`Starting ${slot.projectName}`, () => client.start(slot.id));
		},
		"rojoHub.stop": async (argument) => {
			const slot = await pickSlot(argument, "Stop which project?");
			if (slot) await run(`Stopping ${slot.projectName}`, () => client.stop(slot.id));
		},
		"rojoHub.removeProject": async (argument) => {
			const slot = await pickSlot(argument, "Remove which project?");
			if (slot && (await confirmRemove(slot))) await run(`Removing ${slot.projectName}`, () => client.remove(slot.id));
		},
		"rojoHub.showLog": async (argument) => {
			const slot = await pickSlot(argument, "Show whose log?");
			if (slot) await showLog(slot);
		},
		"rojoHub.copyAddress": async (argument) => {
			const slot = await pickSlot(argument, "Copy whose port?");
			if (!slot) return;
			await vscode.env.clipboard.writeText(String(slot.port));
			void vscode.window.setStatusBarMessage(`Copied port ${slot.port}`, 2000);
		},
		"rojoHub.refresh": async () => {
			await run("Connecting to Rojo-Hub", async () => {
				await ensureService(serviceScript);
				await pushSettings();
			});
		},
		"rojoHub.collapseAll": () => panel.post({ type: "collapse" }),
		// The panel's right-click menu on a foldable header; the argument is that header's data-vscode-context.
		"rojoHub.fold.expand": (argument) => postFold(argument, "expand"),
		"rojoHub.fold.collapse": (argument) => postFold(argument, "collapse"),
		"rojoHub.fold.collapseOthers": (argument) => postFold(argument, "others"),
		"rojoHub.fold.expandAll": (argument) => postFold(argument, "all"),
		"rojoHub.copyAgentCommands": () => copySetup("commands"),
		"rojoHub.copyAgentPrompt": () => copySetup("prompt"),
		"rojoHub.stopAll": async () => {
			await refresh();
			// A project in error counts: stopping it ends its retries.
			const serving = lastSlots.filter((slot) => slot.state === "running" || slot.state === "starting" || slot.state === "error");
			if (serving.length === 0) {
				void vscode.window.showInformationMessage("Rojo-Hub: nothing is serving.");
				return;
			}
			const sure = await vscode.window.showWarningMessage(
				`Stop all ${serving.length} serving project${serving.length === 1 ? "" : "s"}?`,
				{ modal: true, detail: `This stops ${serving.map((slot) => slot.projectName).join(", ")}. Studio places connected to them disconnect.` },
				"Stop All",
			);
			if (sure === "Stop All") await run("Stopping everything", async () => reportStopAll(await client.stopAll()));
		},
	};
	for (const [id, handler] of Object.entries(commands)) {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	}

	const locateRepos = async () => {
		const found = await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => primaryOf(folder.uri.fsPath)));
		workspaceRepos = found.filter((path): path is string => !!path).map(pathKey);
		updateStatus();
	};
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void locateRepos()));
	await locateRepos();

	trackAgentBoxes();
	try {
		await ensureService(serviceScript);
		await pushSettings();
	} catch (error) {
		serviceHealth.error = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Rojo-Hub: ${serviceHealth.error}`);
	}
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration("rojoHub")) return;
			void pushSettings()
				.then(() => (event.affectsConfiguration("rojoHub.agents") ? pushAgentChanges() : undefined))
				.then(refresh);
		}),
	);
	registerVsCodeAgents(context, ensureRunning);
	await refresh();
	// Agent entries are not re-added on start; a box whose entry was removed by hand is turned off instead.
	if (serviceHealth.running) await reconcileAgents(lastAgents);
	void askOnce(context, hubHome, lastAgents);

	/*
		The first time Rojo-Hub runs in a VS Code profile, open its sidebar so a
		new user sees where it lives and the Add Project button.
	*/
	if (!context.globalState.get<boolean>("rojoHub.revealed")) {
		await context.globalState.update("rojoHub.revealed", true);
		void vscode.commands.executeCommand(`${HubPanel.viewId}.focus`);
	}

	void follow();
	const timer = setInterval(() => {
		if (streaming && Date.now() - lastFullRefresh < SLOW_POLL_MS) return;
		void refresh();
	}, POLL_MS);
	context.subscriptions.push({
		dispose: () => {
			clearInterval(timer);
			disposed = true;
			stopFollowing();
		},
	});
}

export function deactivate(): void {
	// The service and its rojo processes keep running on purpose.
}
