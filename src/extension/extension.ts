import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import * as vscode from "vscode";

import { MCP_URL, SERVICE_VERSION, type AgentStatus, type DisplayOrder, type GroupResult, type GroupView, type SlotView, type TargetOption } from "../common/api";
import { pathBetween } from "../common/groups";
import { defaultProjectFile, DEFAULT_PROJECT_FILE, isProjectFileName, listProjectFiles } from "../common/projectFiles";
import { compareVersions } from "../common/version";
import type { Candidate, FromPanel, GroupMember, WorkspaceInfo } from "../common/panel";
import { agentWishes, askOnce, copySetup, registerVsCodeAgents, setAgentBox, vscodeAgentsOn } from "./agents";
import { hideAgentNudge, showAgentNudge } from "./nudge";
import { client, ensureService } from "./client";
import { savedState } from "./saved";
import { findWorkspaces } from "./workspaces";
import { HubPanel } from "./panel";

/*
	The front end. All state lives in the background service; this polls it,
	draws it in the sidebar panel (panel.ts, src/webview) and the status bar,
	and sends it commands. "Rojo-Hub: Open Menu" offers the same actions as
	quick picks for keyboard use.
*/

const POLL_MS = 2000;

let panel: HubPanel;
let serviceScript = "";
let serviceHealth: { running: boolean; version: string | null; error: string | null } = { running: false, version: null, error: null };
/** A start of the service already under way, so concurrent callers wait for the same one. */
let starting: Promise<void> | null = null;
/** The service's state folder: from its /health once seen, else where it puts it by default. */
let hubHome = join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "RojoHub");
let statusItem: vscode.StatusBarItem;
let workspaceRepos: string[] = [];
let lastSlots: SlotView[] = [];
let lastGroups: GroupView[] = [];
let lastOrder: DisplayOrder = { projects: [], groups: [] };
let lastAgents: AgentStatus[] = [];

function pathKey(path: string): string {
	return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

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

let toldToReload = false;

/*
	A newer service than this window's extension means Rojo-Hub was updated and
	this window has not been reloaded. It keeps working against the newer
	service, but its panel code is old, so it asks once to reload.
*/
function checkOutdated(serviceVersion: string | undefined): void {
	if (toldToReload || !serviceVersion || compareVersions(serviceVersion, SERVICE_VERSION) <= 0) return;
	toldToReload = true;
	void vscode.window
		.showInformationMessage(`Rojo-Hub was updated to ${serviceVersion}; this window still runs ${SERVICE_VERSION}. Reload it to use the new version.`, "Reload Window")
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
	try {
		[lastSlots, lastGroups, lastOrder] = health ? await Promise.all([client.slots(), client.groups(), client.order()]) : [[], [], lastOrder];
	} catch {
		lastSlots = [];
		lastGroups = [];
	}
	lastAgents = health ? await client.agents().catch(() => lastAgents) : lastAgents;
	if (!health) ({ slots: lastSlots, groups: lastGroups, order: lastOrder } = savedState(hubHome, lastSlots));
	noticeDisconnects(health ? lastSlots : []);
	await refreshWorkspaces();
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
		agentNudge: !!health && showAgentNudge(hubHome, lastSlots.length, lastAgents),
	});
	updateStatus();
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
	const items: MenuItem[] = [
		{ label: "$(git-branch) Switch Branch…", description: `now ${slot.targetLabel}`, run: () => switchSlot(slot.id) },
		serving
			? { label: "$(debug-stop) Stop Serving", run: () => vscode.commands.executeCommand("rojoHub.stop", slot.id) }
			: { label: "$(play) Start Serving", description: `on port ${slot.port}`, run: () => vscode.commands.executeCommand("rojoHub.start", slot.id) },
		{ label: "$(copy) Copy Address", description: `localhost:${slot.port}`, run: () => vscode.commands.executeCommand("rojoHub.copyAddress", slot.id) },
		{ label: "$(file-code) Project File…", description: `now ${slot.projectFile}`, run: () => changeProjectFile(slot, null) },
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

/** Serving projects that Singleton would stop for this group. */
function wouldStop(group: GroupView): SlotView[] {
	return lastSlots.filter((slot) => (slot.state === "running" || slot.state === "starting") && !group.projectIds.includes(slot.id));
}

/*
	Singleton stops everything outside the group, so it always asks first and
	says exactly what it will stop.
*/
async function confirmOnly(group: GroupView): Promise<boolean> {
	const stopping = wouldStop(group);
	const detail =
		stopping.length === 0
			? "Nothing outside this group is serving, so this only starts the group."
			: `This stops: ${stopping.map((slot) => slot.projectName).join(", ")}. Studio places connected to them disconnect.`;
	const answer = await vscode.window.showWarningMessage(`Singleton: serve only ${group.name}?`, { modal: true, detail }, "Singleton");
	return answer === "Singleton";
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

async function startGroup(argument: unknown, only: boolean): Promise<void> {
	const group = await pickGroup(argument, only ? "Singleton: serve only which group?" : "Start which group?");
	if (!group) return;
	if (only && !(await confirmOnly(group))) return;
	reportGroup(await run(only ? `Serving only ${group.name}` : `Starting ${group.name}`, () => client.startGroup(group.id, only)));
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
		{ label: "$(play) Start Group", description: "serve every project in it", run: () => startGroup(group.id, false) },
		{ label: "$(target) Singleton", description: "serve only this group: stop every other project", run: () => startGroup(group.id, true) },
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

/* Switches a project to `file`, asking first when it is serving, since that restarts Rojo. */
async function useProjectFile(slot: SlotView, file: string, busyKey: string | null): Promise<void> {
	if (file === slot.projectFile) return;
	if (slot.state !== "stopped") {
		const sure = await vscode.window.showWarningMessage(
			`Serve ${file} for ${slot.projectName}?`,
			{
				modal: true,
				detail: "Rojo restarts on the new file, so Studio disconnects. With the plugin's Auto Reconnect on it reconnects by itself, unless the file has a different project name; then connect Studio by hand once.",
			},
			"Restart on It",
		);
		if (sure !== "Restart on It") return;
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
		`${added.projectName} has port ${added.port}. Connect its Studio places to localhost:${added.port} once; with the plugin's Auto Reconnect on, they reconnect by themselves.`,
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
		})
		.catch((error) => void vscode.window.showErrorMessage(`Rojo-Hub: could not apply port settings: ${error instanceof Error ? error.message : error}`));
	// Agent access (spec 004); a failure shows on that agent's row in the panel.
	lastAgents = await client.putAgents(agentWishes()).catch(() => lastAgents);
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
		panel.post({ type: "busy", key, busy: false });
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

/*
	Build place file: a save dialog prefilled with build/<project>-<branch>.rbxl
	in the repo, then rojo build of exactly what the project serves.
*/
async function buildPlace(slot: SlotView): Promise<void> {
	const label = (slot.branch ?? slot.targetLabel ?? "build").replace(/[\\/:*?"<>|]+/g, "-");
	const target = await vscode.window.showSaveDialog({
		title: `Build a place file of ${slot.projectName} (${slot.targetLabel})`,
		defaultUri: vscode.Uri.file(join(slot.repoPath, "build", `${slot.projectName}-${label}.rbxl`)),
		filters: { "Roblox place": ["rbxl", "rbxlx"] },
		saveLabel: "Build",
	});
	if (!target) {
		panel.post({ type: "busy", key: `build:${slot.id}`, busy: false });
		return;
	}
	const built = await act(`build:${slot.id}`, () => client.build(slot.id, target.fsPath));
	if (!built) return;
	const size = built.bytes >= 1 << 20 ? `${(built.bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(built.bytes / 1024))} KB`;
	const choice = await vscode.window.showInformationMessage(`Rojo-Hub: built ${slot.projectName} (${slot.targetLabel}) into ${target.fsPath} (${size}).`, "Reveal in File Explorer");
	if (choice) await vscode.commands.executeCommand("revealFileInOS", target);
}

async function confirmRemove(slot: SlotView): Promise<boolean> {
	const sure = await vscode.window.showWarningMessage(
		`Remove ${slot.projectName} from Rojo-Hub? Its Rojo stops and port ${slot.port} is freed; the project's files are not touched.`,
		{ modal: true },
		"Remove",
	);
	return sure === "Remove";
}

async function onPanel(message: FromPanel): Promise<void> {
	const slot = "id" in message ? lastSlots.find((entry) => entry.id === message.id) : undefined;
	switch (message.type) {
		case "ready":
			return refresh();
		case "refresh":
			serviceHealth.error = null;
			workspaceSignature = "";
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
				panel.post({ type: "targets", id: message.id, options: await client.targets(message.id) });
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
			await vscode.env.clipboard.writeText(`localhost:${slot.port}`);
			void vscode.window.setStatusBarMessage(`$(copy) Copied localhost:${slot.port}`, 2500);
			return;
		case "log":
			if (slot) await vscode.window.showTextDocument(vscode.Uri.file(slot.logFile), { preview: true });
			return;
		case "projectFiles":
			if (slot) panel.post({ type: "projectFiles", id: slot.id, files: listProjectFiles(slot.repoPath) });
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
			panel.post({ type: "candidates", items: await candidates() });
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
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", "greenviper126.rojo-hub#rojoHub.start", false);
			return;
		case "setAgent":
			await act(`agent:${message.id}`, async () => {
				if ((await setAgentBox(message.id, message.on)) && message.id !== "vscode") lastAgents = await client.putAgents(agentWishes());
			});
			return;
		case "copyAgentSetup":
			return copySetup(message.what);
		case "agentNudge":
			hideAgentNudge(hubHome, message.action);
			return refresh();
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	panel = new HubPanel(context.extensionUri, onPanel);
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(HubPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }), statusItem);

	serviceScript = context.asAbsolutePath("dist/service.js");
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
		"rojoHub.startGroup": (argument) => startGroup(argument, false),
		"rojoHub.soloGroup": (argument) => startGroup(argument, true),
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
			if (!slot) return;
			const sure = await vscode.window.showWarningMessage(
				`Remove ${slot.projectName} from Rojo-Hub? Its Rojo stops and port ${slot.port} is freed; the project's files are not touched.`,
				{ modal: true },
				"Remove",
			);
			if (sure) await run(`Removing ${slot.projectName}`, () => client.remove(slot.id));
		},
		"rojoHub.showLog": async (argument) => {
			const slot = await pickSlot(argument, "Show whose log?");
			if (slot) await vscode.window.showTextDocument(vscode.Uri.file(slot.logFile), { preview: true });
		},
		"rojoHub.copyAddress": async (argument) => {
			const slot = await pickSlot(argument, "Copy whose address?");
			if (!slot) return;
			await vscode.env.clipboard.writeText(`localhost:${slot.port}`);
			void vscode.window.setStatusBarMessage(`Copied localhost:${slot.port}`, 2000);
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
			const serving = lastSlots.filter((slot) => slot.state === "running" || slot.state === "starting");
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

	try {
		await ensureService(serviceScript);
		await pushSettings();
	} catch (error) {
		void vscode.window.showErrorMessage(`Rojo-Hub: ${error instanceof Error ? error.message : error}`);
	}
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("rojoHub")) void pushSettings().then(refresh);
		}),
	);
	registerVsCodeAgents(context, ensureRunning);
	await refresh();
	void askOnce(context, hubHome, lastAgents);

	/*
		The first time Rojo-Hub runs in a VS Code profile, open its sidebar so a
		new user sees where it lives and the Add Project button.
	*/
	if (!context.globalState.get<boolean>("rojoHub.revealed")) {
		await context.globalState.update("rojoHub.revealed", true);
		void vscode.commands.executeCommand(`${HubPanel.viewId}.focus`);
	}

	const timer = setInterval(() => void refresh(), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
	// The service and its rojo processes keep running on purpose.
}
