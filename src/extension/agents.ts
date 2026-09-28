import * as vscode from "vscode";

import { AGENT_CLIS, SETUP_COMMANDS, SETUP_PROMPT } from "../common/agents";
import { MCP_URL, SERVICE_VERSION, type AgentId, type AgentStatus, type AgentWishes } from "../common/api";
import { hideAgentNudge } from "./nudge";

/*
	Agent access (spec 004), the VS Code side. rojoHub.agents holds one box per
	agent. VS Code's own agents get the service's MCP endpoint from the
	provider below, so nothing is written anywhere and it goes with the
	extension. Claude Code and Codex are changed by the service, which runs
	their CLIs one at a time for every window.
*/

const SECTION = "rojoHub";
const KEY = "agents";
const ASKED = "rojoHub.agentsAsked";

type Boxes = { vscode?: boolean } & AgentWishes;

/** Only what the user set; a missing box means "never chosen", which leaves that agent's config alone. */
function chosen(): Boxes {
	const value = vscode.workspace.getConfiguration(SECTION).inspect<Boxes>(KEY)?.globalValue;
	return value && typeof value === "object" ? value : {};
}

export function vscodeAgentsOn(): boolean {
	return chosen().vscode !== false;
}

/** What the service should do to each agent's config: only the boxes the user set. */
export function agentWishes(): AgentWishes {
	const boxes = chosen();
	const wishes: AgentWishes = {};
	for (const id of Object.keys(AGENT_CLIS) as AgentId[]) if (typeof boxes[id] === "boolean") wishes[id] = boxes[id];
	return wishes;
}

/*
	The boxes as this window last acted on them. Only a box the user changes
	since then (here, in another window, in settings.json, or through the
	first-run question) is sent to the service, never the whole setting: a
	ticked box whose entry the user removed by hand must not put it back on
	every start. See reconcileAgents.
*/
let acted: AgentWishes = {};

/** Takes the boxes as they are at activation as acted on. */
export function trackAgentBoxes(): void {
	acted = agentWishes();
}

/** The boxes that changed since this window last acted on them, marked as acted on. */
export function changedWishes(): AgentWishes {
	const now = agentWishes();
	const changed: AgentWishes = {};
	for (const id of Object.keys(AGENT_CLIS) as AgentId[]) if (now[id] !== acted[id] && typeof now[id] === "boolean") changed[id] = now[id];
	acted = now;
	return changed;
}

/** Marks one agent's wish as acted on, for the panel's switch, which sends it itself. */
export function actedOn(id: AgentId, on: boolean): void {
	acted = { ...acted, [id]: on };
}

/*
	On activation: a box that says on for an installed agent whose config has
	no rojohub entry means the user took it out by hand. The box is turned off
	to match, and marked as acted on first, so the change it makes is never
	sent back to the service as a wish to add it again.
*/
export async function reconcileAgents(statuses: AgentStatus[]): Promise<void> {
	if (!settingKnown()) return;
	const boxes = chosen();
	const removed = statuses.filter((agent) => agent.installed && agent.state === "absent" && boxes[agent.id] === true);
	if (removed.length === 0) return;
	for (const agent of removed) actedOn(agent.id, false);
	await vscode.workspace
		.getConfiguration(SECTION)
		.update(KEY, { ...chosen(), ...Object.fromEntries(removed.map((agent) => [agent.id, false])) }, vscode.ConfigurationTarget.Global)
		.then(undefined, () => undefined);
}

/*
	Whether this window knows rojoHub.agents. VS Code can restart an updated
	extension's code in a window that is not in focus without registering its
	new settings, and writing an unregistered setting fails.
*/
function settingKnown(): boolean {
	return vscode.workspace.getConfiguration(SECTION).inspect(KEY)?.defaultValue !== undefined;
}

/** Ticks or unticks one box, keeping the others as they are. False when this window must be reloaded first (it says so). */
export async function setAgentBox(id: AgentId | "vscode", on: boolean): Promise<boolean> {
	if (!settingKnown()) {
		const choice = await vscode.window.showWarningMessage(
			"Rojo-Hub was updated, but this window has not loaded its new settings yet. Reload the window, then tick the box again.",
			"Reload Window",
		);
		if (choice) void vscode.commands.executeCommand("workbench.action.reloadWindow");
		return false;
	}
	await vscode.workspace.getConfiguration(SECTION).update(KEY, { ...chosen(), [id]: on }, vscode.ConfigurationTarget.Global);
	return true;
}

/*
	Registers the service's MCP endpoint with VS Code's agents. VS Code asks
	resolve before it connects, which is where the service is started if it
	is not running.
*/
export function registerVsCodeAgents(context: vscode.ExtensionContext, ensureRunning: () => Promise<void>): void {
	const changed = new vscode.EventEmitter<void>();
	context.subscriptions.push(
		changed,
		vscode.lm.registerMcpServerDefinitionProvider("rojoHub", {
			onDidChangeMcpServerDefinitions: changed.event,
			provideMcpServerDefinitions: () => (vscodeAgentsOn() ? [new vscode.McpHttpServerDefinition("Rojo-Hub", vscode.Uri.parse(MCP_URL), {}, SERVICE_VERSION)] : []),
			resolveMcpServerDefinition: async (server) => {
				await ensureRunning();
				return server;
			},
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${SECTION}.${KEY}`)) changed.fire();
		}),
	);
}

/*
	Asks once, the first time an agent is installed that has no Rojo-Hub entry
	and no box set. The answer sets the boxes, and No also hides the notice
	above Projects for a while; closing the message asks again next time.
*/
export async function askOnce(context: vscode.ExtensionContext, home: string, statuses: AgentStatus[]): Promise<void> {
	if (context.globalState.get<boolean>(ASKED) || !settingKnown()) return;
	const boxes = chosen();
	const candidates = statuses.filter((agent) => agent.installed && agent.state === "absent" && typeof boxes[agent.id] !== "boolean");
	if (candidates.length === 0) return;
	const names = candidates.map((agent) => agent.label).join(" and ");
	const answer = await vscode.window.showInformationMessage(
		`Let ${names} use Rojo-Hub's tools? Agents could then serve their worktree to Studio themselves, without restarting Rojo. Rojo-Hub adds itself to ${candidates.length === 1 ? "its" : "their"} user config, and removes itself when uninstalled.`,
		"Yes",
		"No",
	);
	if (!answer) return;
	await context.globalState.update(ASKED, true);
	if (answer === "No") hideAgentNudge(home, "later");
	await vscode.workspace.getConfiguration(SECTION).update(KEY, { ...chosen(), ...Object.fromEntries(candidates.map((agent) => [agent.id, answer === "Yes"])) }, vscode.ConfigurationTarget.Global);
}

export async function copySetup(what: "commands" | "prompt"): Promise<void> {
	await vscode.env.clipboard.writeText(what === "commands" ? SETUP_COMMANDS : SETUP_PROMPT);
	void vscode.window.setStatusBarMessage(
		what === "commands" ? "$(copy) Copied Rojo-Hub's agent setup commands" : "$(copy) Copied a setup prompt: paste it into any agent's chat",
		4000,
	);
}

