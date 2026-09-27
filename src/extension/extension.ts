import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

import * as vscode from "vscode";

import type { SlotView, TargetOption } from "../common/api";
import { client, ensureService } from "./client";
import { SlotItem, SlotTree } from "./tree";

/*
	The front end. All state lives in the background service; this polls it and
	sends it commands.
*/

const POLL_MS = 2000;

let tree: SlotTree;
let statusItem: vscode.StatusBarItem;
let workspaceRepos: string[] = [];
let lastSlots: SlotView[] = [];

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
		lastSlots = await client.slots();
	} catch {
		lastSlots = [];
	}
	tree.update(lastSlots);
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
	statusItem.tooltip = `${slot.projectName}: ${slot.state}${slot.state === "running" ? `, ${slot.connections} Studio connection(s)` : ""}. Click to switch branch.`;
	statusItem.command = { command: "rojoHub.switch", title: "Switch Branch", arguments: [slot.id] };
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
	tree = new SlotTree();
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("rojoHub.slots", tree), statusItem);

	const serviceScript = context.asAbsolutePath("dist/service.js");
	const commands: Record<string, (argument?: unknown) => unknown> = {
		"rojoHub.addProject": () => addProject(),
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
	const timer = setInterval(() => void refresh(), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
	// The service and its rojo processes keep running on purpose.
}
