import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

import * as vscode from "vscode";

import type { GroupResult, GroupView, SlotView, TargetOption } from "../common/api";
import { client, ensureService } from "./client";
import { GroupItem, SlotItem, SlotTree } from "./tree";

/*
	The front end. All state lives in the background service; this polls it and
	sends it commands.
*/

const POLL_MS = 2000;

let projectTree: SlotTree;
let groupTree: SlotTree;
let statusItem: vscode.StatusBarItem;
let workspaceRepos: string[] = [];
let lastSlots: SlotView[] = [];
let lastGroups: GroupView[] = [];

function pathKey(path: string): string {
	return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function primaryOf(folder: string): Promise<string | null> {
	return new Promise((done) => {
		execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, windowsHide: true }, (error, stdout) => {
			done(error ? null : resolve(dirname(stdout.trim())));
		});
	});
}

async function refresh(): Promise<void> {
	try {
		[lastSlots, lastGroups] = await Promise.all([client.slots(), client.groups()]);
	} catch {
		lastSlots = [];
		lastGroups = [];
	}
	projectTree.update(lastSlots, lastGroups);
	groupTree.update(lastSlots, lastGroups);
	updateStatus();
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
	const icon = slot.state === "error" ? "$(error)" : slot.state !== "running" ? "$(circle-slash)" : connected ? "$(pass-filled)" : "$(circle-large-outline)";
	statusItem.text = `${icon} Rojo :${slot.port} · ${slot.targetLabel}`;
	statusItem.tooltip = `${slot.projectName}: ${slot.state}${slot.state === "running" ? `, ${slot.connections} Studio connection(s)` : ""}. Click for its menu.`;
	statusItem.command = { command: "rojoHub.projectMenu", title: "Rojo-Hub", arguments: [slot.id] };
	statusItem.show();
}

async function pickSlot(argument: unknown, placeholder: string): Promise<SlotView | undefined> {
	if (argument instanceof SlotItem) return argument.slot;
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
async function run<T>(title: string, work: () => Promise<T>): Promise<T | undefined> {
	try {
		return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work);
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
		{ label: "$(refresh) Reconnect to Service", run: () => vscode.commands.executeCommand("rojoHub.refresh") },
		{ label: "$(debug-stop) Stop Background Service", run: () => vscode.commands.executeCommand("rojoHub.stopService") },
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

function groupMembers(group: GroupView): SlotView[] {
	return group.slotIds.map((id) => lastSlots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
}

async function pickGroup(argument: unknown, placeholder: string): Promise<GroupView | undefined> {
	if (argument instanceof GroupItem) return argument.group;
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
	const candidates = lastSlots.filter((slot) => !current.slotIds.includes(slot.id));
	if (lastSlots.length === 0) {
		void vscode.window.showInformationMessage("Add a project first; groups are made of projects.");
		return;
	}
	if (candidates.length === 0) {
		void vscode.window.showInformationMessage(`Every project is already in ${current.name}.`);
		return;
	}
	const picked = await vscode.window.showQuickPick(
		candidates.map((slot) => ({ label: `${slotIcon(slot)} ${slot.projectName}`, description: `:${slot.port} · ${slot.targetLabel}`, id: slot.id })),
		{ title: `Add to ${current.name}`, placeHolder: "Pick a project to add" },
	);
	if (picked) await run(`Adding to ${current.name}`, () => client.updateGroup(current.id, { slotIds: [...current.slotIds, picked.id] }));
}

/* The ✕ on a project inside a group: takes it out of that group only. */
async function removeFromGroup(argument: unknown): Promise<void> {
	if (!(argument instanceof SlotItem) || !argument.groupId) return;
	const group = lastGroups.find((entry) => entry.id === argument.groupId);
	if (!group) return;
	const slotId = argument.slot.id;
	await run(`Removing ${argument.slot.projectName} from ${group.name}`, () =>
		client.updateGroup(group.id, { slotIds: group.slotIds.filter((id) => id !== slotId) }),
	);
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
	if (!result || result.failed.length === 0) return;
	const name = (id: string) => lastSlots.find((slot) => slot.id === id)?.projectName ?? id;
	void vscode.window.showErrorMessage(`Rojo-Hub (${result.group.name}): ${result.failed.map((entry) => `${name(entry.id)}: ${entry.error.split("\n")[0]}`).join("; ")}`);
}

async function startGroup(argument: unknown, only: boolean): Promise<void> {
	const group = await pickGroup(argument, only ? "Serve only which group?" : "Start which group?");
	if (!group) return;
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
		{ label: "$(target) Serve Only This Group", description: "start these, stop every other project", run: () => startGroup(group.id, true) },
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

async function addProject(): Promise<void> {
	const known = new Set(lastSlots.map((slot) => pathKey(slot.repoPath)));
	const items: (vscode.QuickPickItem & { path?: string })[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const primary = await primaryOf(folder.uri.fsPath);
		if (primary && !known.has(pathKey(primary))) items.push({ label: `$(folder) ${folder.name}`, description: primary, path: primary });
	}
	for (const repo of await orcaRepos()) {
		if (!known.has(pathKey(repo.path)) && !items.some((item) => item.path && pathKey(item.path) === pathKey(repo.path))) {
			items.push({ label: `$(repo) ${repo.displayName}`, description: repo.path, path: repo.path });
		}
	}
	items.push({ label: "$(folder-opened) Browse…" });
	const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which project should get a Rojo port?" });
	if (!picked) return;
	let path = picked.path;
	if (!path) {
		const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Add Project" });
		path = chosen?.[0]?.fsPath;
	}
	if (!path) return;
	const added = await run("Adding project", () => client.add(path!));
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
		.putSettings({ portRange: config.get<string>("portRange", ""), excludedPorts: config.get<(number | string)[]>("excludedPorts", []) })
		.catch((error) => void vscode.window.showErrorMessage(`Rojo-Hub: could not apply port settings: ${error instanceof Error ? error.message : error}`));
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	projectTree = new SlotTree("projects");
	groupTree = new SlotTree("groups");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("rojoHub.slots", projectTree),
		vscode.window.registerTreeDataProvider("rojoHub.groups", groupTree), statusItem);

	const serviceScript = context.asAbsolutePath("dist/service.js");
	const commands: Record<string, (argument?: unknown) => unknown> = {
		"rojoHub.openMenu": () => openMenu(),
		"rojoHub.projectMenu": (argument) => (typeof argument === "string" ? projectMenu(argument) : openMenu()),
		"rojoHub.addProject": () => addProject(),
		"rojoHub.newGroup": () => newGroup(),
		"rojoHub.editGroup": (argument) => renameGroup(argument),
		"rojoHub.addToGroup": (argument) => addToGroup(argument),
		"rojoHub.removeFromGroup": (argument) => removeFromGroup(argument),
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
		"rojoHub.stopService": async () => {
			const choice = await vscode.window.showWarningMessage(
				"Stop the Rojo-Hub background service?",
				{ modal: true, detail: "Leaving Rojo running keeps Studio connected; the next service adopts it." },
				"Stop Service, Keep Rojo Running",
				"Stop Service and Rojo",
			);
			if (choice) await run("Stopping service", () => client.shutdown(choice === "Stop Service and Rojo"));
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
	await refresh();

	/*
		The first time Rojo-Hub runs in a VS Code profile, open its sidebar so a
		new user sees where it lives and the Add Project button.
	*/
	if (!context.globalState.get<boolean>("rojoHub.revealed")) {
		await context.globalState.update("rojoHub.revealed", true);
		void vscode.commands.executeCommand("workbench.view.extension.rojoHub");
	}

	const timer = setInterval(() => void refresh(), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
	// The service and its rojo processes keep running on purpose.
}
