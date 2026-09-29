import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { SERVICE_VERSION, type GroupResult, type GroupView, type SlotView, type StudioPlace, type Target } from "../common/api";
import { isProjectFileName } from "../common/projectFiles";
import { git, pathKey, primaryCheckout } from "./git";
import type { Groups } from "./groups";
import { claimKey, type Hub } from "./hub";
import { Conflict, NotFound } from "./registry";

/*
	Rojo-Hub for agents (specs 004 and 008): the Model Context Protocol over
	streamable HTTP, answered with plain JSON (no event streams, no sessions).
	Rojo-Hub is mainly for several agents working at once, in Orca worktrees or
	plain git ones, so agents get every common panel action, calling the same
	service code the panel's API does.

	What could pull Studio out from under someone else is guarded (spec 008):
	stopping or removing a project another worktree has claimed, or that a Studio
	place is synced to while the caller holds no claim, needs `force`; stopping
	everything always does. Several agents can work in worktrees of one repo while
	one Studio shows one of them, so switching claims the project for the
	switcher's target for CLAIM_MS; others are refused, or wait with `wait`. A
	switch made by the user clears the claim. What stays the user's: which
	project a Studio place syncs with, agent registration, settings.
*/

export const CLAIM_MS = 10 * 60 * 1000;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** How long a switch is given to reach Rojo's log before its errors are read back. */
const SETTLE_MS = 1500;
const MAX_WAIT_S = 600;

const INSTRUCTIONS = `Rojo-Hub serves the user's Roblox Rojo projects to Roblox Studio, one fixed port per project, and switches which worktree or branch a project serves without disconnecting Studio. Its Studio plugin connects each Studio place to its project by itself. It is built for several agents working at once, each in its own worktree (Orca or git).

Before you check your changes in Studio (by hand or with a Roblox Studio tool), call serve_here with your working directory, so Studio gets the files of your worktree. Rojo applies the switch within about a second; the answer includes any error Rojo logged (an invalid project file, a bad .meta.json), and log shows more. If the project is not serving, start it. If your repo is not registered, add_project it. To begin new work in a worktree of its own, use new_branch.

Which Studio to look at: serve_here, status and wait_for_studio name the Studio places synced to the project, with their place IDs. Several Studio windows may be open for different projects; use the one whose place ID is listed (Roblox Studio tools list each open Studio with its place ID). If no place is synced, wait_for_studio, or tell the user; do not inspect another project's Studio.

Rojo owns what it syncs: an edit made in Studio to a synced script or instance is overwritten by the files. Change the files in your worktree; Studio follows.

Sharing: serve_here and switch claim the project for your worktree for 10 minutes (renewed by each Rojo-Hub call you make from it). While another worktree holds it they are refused; pass wait (seconds) to take it as soon as it is free. Claims are per project, so agents in different projects never block each other. Call release when you are done with Studio.

Starting projects and groups, adding projects and editing groups never disturb anyone. Stopping or removing a project another agent claimed, or that a Studio place is synced to, is refused; stop_all always is. Pass force only when the user asks. You cannot choose which project a Studio place syncs with; the user does that in the Rojo-Hub panel in VS Code.`;

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}

const pathProperty = { type: "string", description: "Your working directory (absolute), or any folder inside the worktree." };
const projectProperty = { type: "string", description: "The project's name or id, as status shows it. Only needed when a repo has more than one project, or without path." };
const forceProperty = { type: "boolean", description: "Go ahead even though another agent or a synced Studio would be affected. Only when the user asks." };
const waitProperty = { type: "number", description: `Seconds to wait for another worktree's claim to end, then take the project (up to ${MAX_WAIT_S}). Waiters are served in order.` };
const groupProperty = { type: "string", description: "The group's name or id, as status shows it." };
const listProperty = (what: string) => ({ type: "array", items: { type: "string" }, description: what });
const project = (extra: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: { path: pathProperty, project: projectProperty, ...extra }, required });

export const TOOLS: Tool[] = [
	{
		name: "status",
		title: "Rojo-Hub status",
		description:
			"Lists the projects: port, whether Rojo is serving, the Studio places synced to each (name, place ID, and why), what worktree or branch each serves, who claimed it, warnings; then the groups and every open Studio place. With path, also says whether your worktree is the one being served.",
		inputSchema: { type: "object", properties: { path: pathProperty } },
		annotations: { readOnlyHint: true },
	},
	{
		name: "serve_here",
		title: "Serve my worktree",
		description:
			"Makes Studio show your worktree: switches the project of the repo you are in to your worktree, live, without disconnecting Studio, and claims it for 10 minutes. Says which Studio places show it and any error Rojo logged. Call it before checking changes in Studio.",
		inputSchema: { type: "object", properties: { path: pathProperty, project: projectProperty, wait: waitProperty, force: forceProperty }, required: ["path"] },
	},
	{
		name: "switch",
		title: "Serve a branch or worktree",
		description:
			"Switches a project to serve a branch (by name, e.g. main or origin/feature) or a worktree (by folder), live, and claims it. A branch checked out in a worktree is served from that worktree; any other branch from a read-only copy Rojo-Hub keeps.",
		inputSchema: project({ target: { type: "string", description: "A branch name, or a worktree's folder." }, wait: waitProperty, force: forceProperty }, ["target"]),
	},
	{
		name: "release",
		title: "Release a project",
		description: "Drops your claim on a project, so other agents can switch it. Pass path (your working directory) so it is your claim that is dropped. The project keeps serving what it serves.",
		inputSchema: project({ force: { type: "boolean", description: "Drop the claim without a path, whoever holds it. Only when the user asks." } }),
		annotations: { idempotentHint: true },
	},
	{
		name: "start",
		title: "Start a project",
		description: "Starts serving a project that is stopped (or in error). Studio places listed in its servePlaceIds sync by themselves. Never disturbs anyone.",
		inputSchema: project(),
	},
	{
		name: "stop",
		title: "Stop a project",
		description: "Stops serving a project; its Studio places disconnect. Refused while another agent claimed it or a Studio place is synced to it and you hold no claim, unless force.",
		inputSchema: project({ force: forceProperty }),
		annotations: { destructiveHint: true },
	},
	{
		name: "stop_all",
		title: "Stop every project",
		description: "Stops every serving project and marks every group stopped. Always needs force: only when the user asks.",
		inputSchema: { type: "object", properties: { force: forceProperty }, required: ["force"] },
		annotations: { destructiveHint: true },
	},
	{
		name: "add_project",
		title: "Add a project",
		description: "Registers the repo a folder is in as a project, with its default.project.json (or project_file). Does not start it. Adding the primary checkout or any worktree of it is the same.",
		inputSchema: { type: "object", properties: { path: pathProperty, project_file: { type: "string", description: "A *.project.json directly in the repo's folder, when not default.project.json." } }, required: ["path"] },
	},
	{
		name: "remove_project",
		title: "Remove a project",
		description: "Unregisters a project and stops it; never deletes files. Guarded like stop.",
		inputSchema: project({ force: forceProperty }),
		annotations: { destructiveHint: true },
	},
	{
		name: "project_files",
		title: "List project files",
		description: "Lists the *.project.json files in a project's folder, and which one it serves.",
		inputSchema: project(),
		annotations: { readOnlyHint: true },
	},
	{
		name: "set_project_file",
		title: "Serve another project file",
		description: "Makes a project serve another *.project.json in its folder. Only while the project is stopped (a new file is a new Rojo session); stop it first.",
		inputSchema: project({ file: { type: "string", description: "The file name, e.g. test.project.json." } }, ["file"]),
	},
	{
		name: "branches",
		title: "List branches",
		description: "Lists what a project can switch to: worktrees and branches, newest first. fetch: true runs git fetch first.",
		inputSchema: project({ fetch: { type: "boolean", description: "git fetch --all --prune first." } }),
		annotations: { readOnlyHint: true },
	},
	{
		name: "new_branch",
		title: "New branch in its own worktree",
		description:
			"Makes a new branch in a worktree of its own (through Orca when Orca manages the repo), switches the project to it and claims it for that worktree. Returns the worktree's folder: work there.",
		inputSchema: project({ name: { type: "string", description: "The new branch's name." }, base: { type: "string", description: "Branch to start from (default: the branch the project serves)." }, wait: waitProperty, force: forceProperty }, ["name"]),
	},
	{
		name: "log",
		title: "Rojo log",
		description: "The last lines of a project's Rojo log: why a change did not reach Studio, sync errors, connections.",
		inputSchema: project({ lines: { type: "number", description: "How many lines (default 40, up to 400)." } }),
		annotations: { readOnlyHint: true },
	},
	{
		name: "wait_for_studio",
		title: "Wait for Studio",
		description: "Waits until a Studio place is synced to the project's current Rojo session, and says which (name and place ID). Use after starting a project or before using a Roblox Studio tool.",
		inputSchema: project({ timeout: { type: "number", description: "Seconds to wait (default 30, up to 300)." } }),
		annotations: { readOnlyHint: true },
	},
	{
		name: "start_group",
		title: "Start a group",
		description: "Starts every project in a group. only: true also stops every serving project outside it (guarded like stop).",
		inputSchema: { type: "object", properties: { group: groupProperty, only: { type: "boolean", description: "Also stop every project outside the group." }, force: forceProperty }, required: ["group"] },
	},
	{
		name: "stop_group",
		title: "Stop a group",
		description: "Stops a group's projects, except those another running group also holds. Guarded like stop.",
		inputSchema: { type: "object", properties: { group: groupProperty, force: forceProperty }, required: ["group"] },
		annotations: { destructiveHint: true },
	},
	{
		name: "create_group",
		title: "Create a group",
		description: "Makes a group of projects (and other groups), to start and stop together.",
		inputSchema: { type: "object", properties: { name: { type: "string" }, projects: listProperty("Project names or ids."), groups: listProperty("Group names or ids to nest.") }, required: ["name"] },
	},
	{
		name: "edit_group",
		title: "Edit a group",
		description: "Renames a group, or adds and removes its projects and nested groups.",
		inputSchema: {
			type: "object",
			properties: {
				group: groupProperty,
				name: { type: "string", description: "A new name." },
				add_projects: listProperty("Project names or ids to add."),
				remove_projects: listProperty("Project names or ids to take out."),
				add_groups: listProperty("Group names or ids to nest."),
				remove_groups: listProperty("Nested group names or ids to take out."),
			},
			required: ["group"],
		},
	},
	{
		name: "delete_group",
		title: "Delete a group",
		description: "Deletes a group. Its projects are left as they are (not stopped, not removed).",
		inputSchema: { type: "object", properties: { group: groupProperty }, required: ["group"] },
	},
	{
		name: "build",
		title: "Build a place file",
		description:
			"Builds a Roblox place file (.rbxl or .rbxlx) of exactly what a project serves right now, including packages borrowed from the main checkout. Use serve_here first to build your own worktree.",
		inputSchema: project({ output: { type: "string", description: "Absolute path of the place file to write, ending in .rbxl or .rbxlx." } }, ["output"]),
	},
	{
		name: "sourcemap",
		title: "Write sourcemap.json",
		description: "Writes sourcemap.json (for luau-lsp and other tools) into the worktree a project serves, once, now. While a worktree is served Rojo-Hub usually keeps it current by itself.",
		inputSchema: project(),
	},
];

/** A tool call the agent got wrong, or that was refused: reported to the agent as a tool error, not a protocol error. */
class Refusal extends Error {}

type Args = Record<string, unknown>;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : [];
}

function clamp(value: unknown, fallback: number, max: number): number {
	const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.min(max, number));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The root of the git worktree `path` is in. */
async function worktreeRoot(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Refusal(`path must be absolute; got ${path}`);
	if (!existsSync(path)) throw new Refusal(`${path} does not exist`);
	const folder = statSync(path).isDirectory() ? path : resolve(path, "..");
	try {
		return resolve((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
	} catch {
		throw new Refusal(`${path} is not inside a git repository`);
	}
}

function time(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const REASONS: Record<string, string> = {
	assigned: "assigned in VS Code",
	servePlaceIds: "in its servePlaceIds",
	placeId: "its placeId",
	remembered: "synced here before",
};

export class Mcp {
	/** Agents waiting for a project's claim to end, per project, in the order they asked. */
	private readonly queues = new Map<string, symbol[]>();

	constructor(
		private readonly hub: Hub,
		private readonly groups?: Groups,
	) {}

	/*
		Handles one JSON-RPC message: the response to send, or null for a
		notification (which gets 202 and no body).
	*/
	async handle(message: unknown): Promise<object | null> {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Expected one JSON-RPC request object" } };
		}
		const { id, method, params } = message as { id?: string | number | null; method?: unknown; params?: Args };
		if (id === undefined || id === null) return null;
		const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
		const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
		switch (method) {
			case "initialize": {
				const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
				return reply({
					protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "rojo-hub", title: "Rojo-Hub", version: SERVICE_VERSION },
					instructions: INSTRUCTIONS,
				});
			}
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: TOOLS });
			case "tools/call": {
				const name = params?.name;
				if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
				const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Args;
				try {
					return reply({ content: [{ type: "text", text: await this.call(name, args) }] });
				} catch (error) {
					const known = error instanceof Refusal || error instanceof Conflict || error instanceof NotFound;
					const detail = error instanceof Error ? error.message : String(error);
					return reply({ content: [{ type: "text", text: known ? detail : `Rojo-Hub failed: ${detail}` }], isError: true });
				}
			}
			default:
				return fail(-32601, `Method not found: ${String(method)}`);
		}
	}

	private call(name: string, args: Args): Promise<string> {
		switch (name) {
			case "status":
				return this.status(args);
			case "serve_here":
				return this.serveHere(args);
			case "switch":
				return this.switchTo(args);
			case "release":
				return this.release(args);
			case "start":
				return this.start(args);
			case "stop":
				return this.stop(args);
			case "stop_all":
				return this.stopAll(args);
			case "add_project":
				return this.addProject(args);
			case "remove_project":
				return this.removeProject(args);
			case "project_files":
				return this.projectFiles(args);
			case "set_project_file":
				return this.setProjectFile(args);
			case "branches":
				return this.branches(args);
			case "new_branch":
				return this.newBranch(args);
			case "log":
				return this.log(args);
			case "wait_for_studio":
				return this.waitForStudio(args);
			case "start_group":
				return this.startGroup(args);
			case "stop_group":
				return this.stopGroup(args);
			case "create_group":
				return this.createGroup(args);
			case "edit_group":
				return this.editGroup(args);
			case "delete_group":
				return this.deleteGroup(args);
			case "build":
				return this.build(args);
			default:
				return this.sourcemap(args);
		}
	}

	/* ---------- picking what the agent means ---------- */

	private findProject(wanted: string): SlotView {
		const slots = this.hub.list();
		const key = wanted.toLowerCase();
		const slot = slots.find((entry) => entry.id.toLowerCase() === key || entry.projectName.toLowerCase() === key);
		if (!slot) throw new Refusal(`No project named ${wanted}. Projects: ${slots.map((entry) => entry.projectName).join(", ") || "none"}.`);
		return slot;
	}

	/*
		The project an agent means: by `project` (name or id) when given, else the
		one registered for the repo `path` is in. The worktree root comes along
		when there is a path, for claims.
	*/
	private async pick(args: Args): Promise<{ slot: SlotView; root: string | null }> {
		const slots = this.hub.list();
		const path = text(args.path);
		const root = path ? await worktreeRoot(path) : null;
		const wanted = text(args.project);
		if (wanted) return { slot: this.findProject(wanted), root };
		if (!root) {
			if (slots.length === 1) return { slot: slots[0], root };
			throw new Refusal(`Say which project with path (your working directory) or project. Projects: ${slots.map((entry) => entry.projectName).join(", ") || "none"}.`);
		}
		const repo = pathKey(await primaryCheckout(root));
		const matches = slots.filter((entry) => pathKey(entry.repoPath) === repo);
		if (matches.length === 1) return { slot: matches[0], root };
		if (matches.length > 1) throw new Refusal(`This repo has several projects; pass project as one of: ${matches.map((entry) => entry.projectName).join(", ")}.`);
		throw new Refusal(
			`${basename(root)} belongs to a repo Rojo-Hub does not serve. Add it with add_project (path: your working directory). Registered: ${slots.map((entry) => `${entry.projectName} (${entry.repoPath})`).join(", ") || "none"}.`,
		);
	}

	private groupsOrFail(): Groups {
		if (!this.groups) throw new Refusal("Groups are not available.");
		return this.groups;
	}

	private findGroup(wanted: unknown): GroupView {
		const name = text(wanted);
		if (!name) throw new Refusal("group is required: a group's name or id.");
		const groups = this.groupsOrFail().list();
		const key = name.toLowerCase();
		const group = groups.find((entry) => entry.id.toLowerCase() === key || entry.name.toLowerCase() === key);
		if (!group) throw new Refusal(`No group named ${name}. Groups: ${groups.map((entry) => entry.name).join(", ") || "none"}.`);
		return group;
	}

	/* ---------- claims and guards ---------- */

	private claimRefusal(slot: SlotView, claim: { label: string; until: number }, how: string): Refusal {
		const minutes = Math.max(1, Math.ceil((claim.until - Date.now()) / 60000));
		return new Refusal(
			`${slot.projectName} is claimed by an agent working in ${claim.label} until ${time(claim.until)} (${minutes} min). ${how} Wait (pass wait: seconds to take it when it is free), ask the user, or pass force: true if the user said to.`,
		);
	}

	/** Refuses when another target holds the slot, unless forced. */
	private checkClaim(slot: SlotView, key: string, force: boolean): void {
		const claim = this.hub.claimOf(slot.id);
		if (!claim || claim.key === key || force) return;
		throw this.claimRefusal(slot, claim, "Switching now would change what Studio shows under that agent.");
	}

	/*
		Before stopping or removing a project: refused while another target holds
		its claim, or while a Studio place is synced to it and the caller holds no
		claim on it (someone is using it), unless forced.
	*/
	private guardStop(slot: SlotView, root: string | null, force: boolean, doing: string): void {
		if (force) return;
		const claim = this.hub.claimOf(slot.id);
		const mine = claim !== null && root !== null && claim.key === claimKey({ kind: "worktree", path: root });
		if (claim && !mine) throw this.claimRefusal(slot, claim, `${doing} would pull Studio out from under that agent.`);
		const synced = slot.state === "running" ? (slot.places ?? []) : [];
		if (!mine && synced.length > 0) {
			throw new Refusal(`${slot.projectName} is synced to ${this.placeList(synced)} in Studio; ${doing.toLowerCase()} would disconnect it. Ask the user, or pass force: true if the user said to.`);
		}
	}

	private renew(slot: SlotView, root: string | null): void {
		if (!root) return;
		const claim = this.hub.claimOf(slot.id);
		if (claim && claim.key === claimKey({ kind: "worktree", path: root })) this.hub.setClaim(slot.id, { ...claim, until: Date.now() + CLAIM_MS });
	}

	/*
		Waits, up to `seconds`, until nobody else holds the slot's claim and every
		agent that asked earlier has had its turn. Returns at once when free.
	*/
	private async waitTurn(slot: SlotView, key: string, seconds: number, force: boolean): Promise<void> {
		if (force || seconds <= 0) return;
		const queue = this.queues.get(slot.id) ?? [];
		this.queues.set(slot.id, queue);
		const me = Symbol(key);
		queue.push(me);
		const deadline = Date.now() + seconds * 1000;
		try {
			for (;;) {
				const claim = this.hub.claimOf(slot.id);
				const free = !claim || claim.key === key;
				if (free && queue[0] === me) return;
				if (Date.now() >= deadline) {
					if (claim && claim.key !== key) throw this.claimRefusal(slot, claim, `Waited ${seconds} s.`);
					throw new Refusal(`Waited ${seconds} s; other agents asked for ${slot.projectName} first.`);
				}
				await sleep(500);
			}
		} finally {
			const at = queue.indexOf(me);
			if (at >= 0) queue.splice(at, 1);
			if (queue.length === 0) this.queues.delete(slot.id);
		}
	}

	private async take(slot: SlotView, target: Target, label: string, args: Args): Promise<SlotView> {
		const key = claimKey(target);
		const force = args.force === true;
		await this.waitTurn(slot, key, clamp(args.wait, 0, MAX_WAIT_S), force);
		this.checkClaim(slot, key, force);
		// Claimed before switching, so a second agent asking at the same moment is refused rather than both switching.
		const before = this.hub.claimOf(slot.id);
		this.hub.setClaim(slot.id, { key, label, until: Date.now() + CLAIM_MS });
		const current = this.hub.view(this.hub.registry.get(slot.id));
		if (claimKey(current.target) === key) return current;
		try {
			return await this.hub.switch(slot.id, target);
		} catch (error) {
			this.hub.setClaim(slot.id, before);
			throw error;
		}
	}

	/* ---------- Rojo's side of things ---------- */

	/** Gives Rojo a moment, then the project as it is, with whatever it logged meanwhile. */
	private async settled(slot: SlotView): Promise<SlotView> {
		await sleep(SETTLE_MS);
		return this.hub.view(this.hub.registry.get(slot.id));
	}

	/** Rojo's errors and the card's warnings, as lines for an answer. */
	private problems(slot: SlotView): string {
		const lines: string[] = [];
		if (slot.error) lines.push(`Rojo reports: ${slot.error.split("\n").slice(0, 6).join("\n  ")}`);
		for (const warning of slot.warnings) lines.push(`Note: ${warning}`);
		return lines.length ? `\n${lines.join("\n")}` : "";
	}

	/** `Lobby (place 111), Match (place 222)` */
	private placeList(places: Pick<StudioPlace, "placeName" | "placeId">[]): string {
		return places.map((place) => `${place.placeName} (${place.placeId ? `place ${place.placeId}` : "not saved to Roblox"})`).join(", ");
	}

	private health(slot: SlotView): string {
		const open = this.hub.studio.places();
		const waiting = open.filter((place) => place.projectId === slot.id && place.syncedWith !== slot.projectName);
		const waitingText = waiting.length > 0 ? ` Waiting for it: ${this.placeList(waiting)}.` : "";
		const confirming = waiting.filter((place) => place.confirming);
		const confirmText = confirming.length > 0 ? ` ${this.placeList(confirming)} ${confirming.length === 1 ? "waits" : "wait"} for the user to accept the first sync in Studio (Rojo asks once per place and project); ask the user to accept it.` : "";
		if (slot.state === "running") {
			const synced = slot.places ?? [];
			if (synced.length > 0) {
				const why = (place: StudioPlace) => {
					const reason = open.find((entry) => entry.placeId === place.placeId && entry.syncedWith === slot.projectName)?.reason;
					return reason ? `, ${REASONS[reason] ?? reason}` : "";
				};
				const names = synced.map((place) => `${place.placeName} (${place.placeId ? `place ${place.placeId}` : "not saved to Roblox"}${why(place)}, plugin ${place.pluginVersion})`).join(", ");
				return `Rojo is serving on port ${slot.port}. Studio places synced to it: ${names}; look at the Studio with that place ID.${waiting.length > 0 ? ` Connecting: ${this.placeList(waiting)}.${confirmText}` : ""}`;
			}
			if (waiting.length > 0) return `Rojo is serving on port ${slot.port}. Studio places connecting to it: ${this.placeList(waiting)}.${confirmText}`;
			if (slot.connections > 0) return `Rojo is serving on port ${slot.port} and Studio is connected (${slot.connections}), through Rojo's own plugin, so which place is not known.`;
			return `Rojo is serving on port ${slot.port}, but no Studio place is synced to it. The user opens a place listed in the project's servePlaceIds (it syncs by itself), or assigns an open place in the Rojo-Hub panel's Studio places.`;
		}
		if (slot.state === "error") return `Rojo has an error: ${(slot.error ?? "").split("\n")[0]}${waitingText}`;
		if (slot.state === "starting") return `Rojo is starting.${waitingText}`;
		return `Rojo is not serving this project, so Studio gets nothing; start it with start.${waitingText}`;
	}

	private describeGroupResult(result: GroupResult, verb: string): string {
		const name = (id: string) => this.hub.registry.slots.find((slot) => slot.id === id)?.projectName ?? id;
		const lines = [`${verb} ${result.group.name || "every project"}.`];
		if (result.started.length) lines.push(`Started: ${result.started.map(name).join(", ")}.`);
		if (result.stopped.length) lines.push(`Stopped: ${result.stopped.map(name).join(", ")}.`);
		for (const kept of result.kept) lines.push(`Kept serving ${name(kept.id)}: ${kept.because} also holds it.`);
		for (const failed of result.failed) lines.push(`${name(failed.id)} failed: ${failed.error.split("\n")[0]}`);
		return lines.join("\n");
	}

	/* ---------- tools ---------- */

	private async serveHere(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		if (!root) throw new Refusal("path is required: your working directory.");
		const switched = await this.take(slot, { kind: "worktree", path: root }, basename(root), args);
		const now = await this.settled(switched);
		return `${now.projectName} now serves ${root}${now.branch ? ` (branch ${now.branch})` : ""}. ${this.health(now)}${this.problems(now)}\nYou hold it until ${time(Date.now() + CLAIM_MS)}; each Rojo-Hub call from this worktree renews that. Call release when you are done with Studio.`;
	}

	private async switchTo(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const wanted = text(args.target);
		if (!wanted) throw new Refusal("target is required: a branch name or a worktree folder.");
		let target: Target;
		let label: string;
		if (isAbsolute(wanted) && existsSync(wanted)) {
			const tree = await worktreeRoot(wanted);
			if (pathKey(await primaryCheckout(tree)) !== pathKey(slot.repoPath)) throw new Refusal(`${tree} is not a worktree of ${slot.projectName}'s repo (${slot.repoPath}).`);
			target = { kind: "worktree", path: tree };
			label = basename(tree);
		} else {
			const options = await this.hub.targets(slot.id);
			const plain = wanted.replace(/^refs\/(heads|remotes)\//, "");
			const option =
				options.find((entry) => entry.target.kind === "worktree" && entry.branch === plain) ??
				options.find((entry) => entry.target.kind === "branch" && (entry.branch === plain || entry.target.ref === wanted || entry.label === plain));
			if (!option) throw new Refusal(`${slot.projectName}'s repo has no branch ${wanted}. Branches: ${options.map((entry) => entry.branch ?? entry.label).slice(0, 30).join(", ")}.`);
			target = option.target;
			label = option.branch ?? option.label;
		}
		const switched = await this.take(slot, target, label, args);
		if (root) this.renew(switched, root);
		const now = await this.settled(switched);
		return `${now.projectName} now serves ${now.targetLabel}${target.kind === "branch" ? " from a read-only copy (edits there are not possible)" : ""}. ${this.health(now)}${this.problems(now)}\nClaimed until ${time(Date.now() + CLAIM_MS)}. Call release when you are done with Studio.`;
	}

	private async release(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const claim = this.hub.claimOf(slot.id);
		if (!claim) return `${slot.projectName} was not claimed.`;
		// Without a path there is no telling whose claim it is; another agent's is only dropped with force.
		if (!root && args.force !== true) throw new Refusal(`${slot.projectName} is claimed by ${claim.label}. Pass path (your worktree) to release your own claim.`);
		if (root && claim.key !== claimKey({ kind: "worktree", path: root })) {
			throw new Refusal(`${slot.projectName} is claimed by ${claim.label}, not by your worktree; leaving it.`);
		}
		this.hub.setClaim(slot.id, null);
		return `Released ${slot.projectName}. It keeps serving ${slot.targetLabel}.`;
	}

	private async start(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		if (slot.state === "running") return `${slot.projectName} is already serving. ${this.health(slot)}`;
		const started = await this.hub.start(slot.id);
		const now = await this.settled(started);
		return `Started ${now.projectName}. ${this.health(now)}${this.problems(now)}`;
	}

	private async stop(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		if (slot.state === "stopped") return `${slot.projectName} is not serving.`;
		this.guardStop(slot, root, args.force === true, "Stopping it");
		await this.hub.stop(slot.id);
		return `Stopped ${slot.projectName}.`;
	}

	private async stopAll(args: Args): Promise<string> {
		if (args.force !== true) throw new Refusal("stop_all stops every project, under every agent and the user. Pass force: true only if the user asked for it.");
		const result = await this.groupsOrFail().stopAll();
		return this.describeGroupResult({ group: { id: "", name: "", slotIds: [], groupIds: [], active: false, projectIds: [] }, started: [], stopped: result.stopped, kept: [], failed: result.failed }, "Stopped");
	}

	private async addProject(args: Args): Promise<string> {
		const path = text(args.path);
		if (!path) throw new Refusal("path is required: a folder in the repo to add.");
		const root = await worktreeRoot(path);
		const file = text(args.project_file);
		if (file && !isProjectFileName(file)) throw new Refusal("project_file must be a *.project.json file name, not a path.");
		const added = await this.hub.add(root, file);
		return `Added ${added.projectName} (id ${added.id}) from ${added.repoPath}, serving ${added.projectFile}, port ${added.port}. It is stopped; start it with start.`;
	}

	private async removeProject(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.guardStop(slot, root, args.force === true, "Removing it");
		await this.hub.remove(slot.id);
		return `Removed ${slot.projectName} from Rojo-Hub (its files are untouched).`;
	}

	private async projectFiles(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		return `${slot.projectName} serves ${slot.projectFile}. Project files in ${slot.repoPath}: ${slot.projectFiles.join(", ") || "none"}.`;
	}

	private async setProjectFile(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const file = text(args.file);
		if (!file || !isProjectFileName(file)) throw new Refusal("file must be a *.project.json file name in the project's folder.");
		if (slot.state === "running" || slot.state === "starting") {
			throw new Refusal(`${slot.projectName} is serving; a new project file is a new Rojo session, so stop it first (stop), then set the file, then start it.`);
		}
		this.renew(slot, root);
		const now = await this.hub.setProjectFile(slot.id, file);
		return `${now.projectName} now uses ${now.projectFile}.${this.problems(now)}`;
	}

	private async branches(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		const options = args.fetch === true ? await this.hub.fetch(slot.id) : await this.hub.targets(slot.id);
		const lines = options.slice(0, 60).map((option) => {
			const where = option.target.kind === "worktree" ? `worktree ${option.target.path}` : "no worktree (served from a read-only copy)";
			const served =
				(slot.target.kind === "worktree" && option.target.kind === "worktree" && pathKey(slot.target.path) === pathKey(option.target.path)) ||
				(slot.target.kind === "branch" && option.target.kind === "branch" && slot.target.ref === option.target.ref);
			return `${served ? "* " : "  "}${option.branch ?? option.label}: ${where}`;
		});
		return `${slot.projectName} can serve (* = now):\n${lines.join("\n")}${options.length > 60 ? `\n… and ${options.length - 60} more` : ""}`;
	}

	private async newBranch(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const name = text(args.name);
		if (!name) throw new Refusal("name is required: the new branch's name.");
		const base = text(args.base) ?? slot.branch ?? "HEAD";
		const force = args.force === true;
		// It switches the project, so it waits its turn and respects another worktree's claim like serve_here; the caller's own claim is no obstacle.
		const mine = root ? claimKey({ kind: "worktree", path: root }) : "new-branch";
		await this.waitTurn(slot, mine, clamp(args.wait, 0, MAX_WAIT_S), force);
		const claim = this.hub.claimOf(slot.id);
		if (claim && claim.key !== mine && !force) throw this.claimRefusal(slot, claim, "A new branch switches the project, which would change what Studio shows under that agent.");
		const made = await this.hub.createBranch(slot.id, name, base);
		this.hub.setClaim(slot.id, { key: claimKey({ kind: "worktree", path: made.path }), label: basename(made.path), until: Date.now() + CLAIM_MS });
		const now = await this.settled(made.slot);
		return `Made branch ${made.branch} from ${base} in ${made.path} (${made.via === "orca" ? "an Orca worktree" : "a git worktree"}); ${now.projectName} now serves it and you hold it until ${time(Date.now() + CLAIM_MS)}. Work in ${made.path}. ${this.health(now)}${this.problems(now)}`;
	}

	private async log(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		const lines = Math.round(clamp(args.lines, 40, 400)) || 40;
		const tail = this.hub.logTail(slot.id, lines);
		return tail ? `${slot.projectName}'s Rojo log (last ${lines} lines):\n${tail}` : `${slot.projectName} has no Rojo log yet (it has not been started).`;
	}

	private async waitForStudio(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		const deadline = Date.now() + clamp(args.timeout, 30, 300) * 1000;
		for (;;) {
			const now = this.hub.view(this.hub.registry.get(slot.id));
			if (now.state === "running" && (now.places ?? []).length > 0) return this.health(now);
			if (now.state === "stopped" || now.state === "error") return `${now.projectName} is not serving, so no Studio can sync to it. ${this.health(now)}`;
			if (Date.now() >= deadline) return `No Studio place synced to ${now.projectName} in time. ${this.health(now)}`;
			if (this.hub.studio.places().some((place) => place.projectId === now.id && place.confirming)) {
				return `A Studio place is waiting for the user to accept its first sync with ${now.projectName}. ${this.health(now)}`;
			}
			await sleep(500);
		}
	}

	private async startGroup(args: Args): Promise<string> {
		const group = this.findGroup(args.group);
		const groups = this.groupsOrFail();
		if (args.only === true && args.force !== true) {
			const members = new Set(group.projectIds);
			for (const slot of this.hub.list()) {
				if (members.has(slot.id) || slot.state !== "running") continue;
				this.guardStop(slot, null, false, `Stopping ${slot.projectName} (only: true)`);
			}
		}
		return this.describeGroupResult(await groups.start(group.id, args.only === true), "Started");
	}

	private async stopGroup(args: Args): Promise<string> {
		const group = this.findGroup(args.group);
		if (args.force !== true) {
			for (const id of group.projectIds) {
				const slot = this.hub.list().find((entry) => entry.id === id);
				if (slot && slot.state === "running") this.guardStop(slot, null, false, `Stopping ${slot.projectName}`);
			}
		}
		return this.describeGroupResult(await this.groupsOrFail().stop(group.id), "Stopped");
	}

	private async createGroup(args: Args): Promise<string> {
		const name = text(args.name);
		if (!name) throw new Refusal("name is required.");
		const slotIds = list(args.projects).map((entry) => this.findProject(entry).id);
		const groupIds = list(args.groups).map((entry) => this.findGroup(entry).id);
		const made = this.groupsOrFail().create(name, slotIds, groupIds);
		return `Made group ${made.name} (id ${made.id}) with ${made.projectIds.length} project(s). Start it with start_group.`;
	}

	private async editGroup(args: Args): Promise<string> {
		const group = this.findGroup(args.group);
		const add = list(args.add_projects).map((entry) => this.findProject(entry).id);
		const drop = new Set(list(args.remove_projects).map((entry) => this.findProject(entry).id));
		const addGroups = list(args.add_groups).map((entry) => this.findGroup(entry).id);
		const dropGroups = new Set(list(args.remove_groups).map((entry) => this.findGroup(entry).id));
		const slotIds = [...new Set([...group.slotIds, ...add])].filter((id) => !drop.has(id));
		const groupIds = [...new Set([...group.groupIds, ...addGroups])].filter((id) => !dropGroups.has(id));
		const updated = this.groupsOrFail().update(group.id, { name: text(args.name), slotIds, groupIds });
		const names = updated.projectIds.map((id) => this.hub.registry.slots.find((slot) => slot.id === id)?.projectName ?? id);
		return `${updated.name} now holds ${names.join(", ") || "no projects"}.`;
	}

	private async deleteGroup(args: Args): Promise<string> {
		const group = this.findGroup(args.group);
		this.groupsOrFail().remove(group.id);
		return `Deleted group ${group.name}. Its projects are as they were.`;
	}

	private async build(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const output = text(args.output);
		if (!output || !isAbsolute(output) || !/\.rbxlx?$/i.test(output)) throw new Refusal("output must be an absolute path ending in .rbxl or .rbxlx.");
		this.renew(slot, root);
		const built = await this.hub.build(slot.id, output);
		const mine = root && slot.target.kind === "worktree" && pathKey(slot.target.path) === pathKey(root);
		return `Built ${slot.projectName} (${slot.targetLabel}) into ${built.output}, ${built.bytes} bytes.${root && !mine ? " Note: that is what the project serves, not your worktree; call serve_here first to build yours." : ""}`;
	}

	private async sourcemap(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		const written = await this.hub.writeSourcemap(slot.id);
		return `Wrote ${written.path}.`;
	}

	private async status(args: Args): Promise<string> {
		const slots = this.hub.list();
		if (slots.length === 0) return "Rojo-Hub has no projects. Add one with add_project (path: a folder in the repo).";
		const path = text(args.path);
		const root = path ? await worktreeRoot(path).catch(() => null) : null;
		const repo = root ? pathKey(await primaryCheckout(root).catch(() => root)) : null;
		const lines: string[] = [];
		for (const slot of slots) {
			const claim = this.hub.claimOf(slot.id);
			if (lines.length > 0) lines.push("");
			const serves = slot.target.kind === "worktree" ? `${slot.targetLabel}${slot.branch && slot.branch !== slot.targetLabel ? ` (branch ${slot.branch})` : ""} at ${slot.target.path}` : `branch ${slot.targetLabel} (read-only copy)`;
			lines.push(`${slot.projectName} (id ${slot.id}), port ${slot.port}: ${this.health(slot)}`, `  serves ${serves}, project file ${slot.projectFile}`, `  repo ${slot.repoPath}`);
			if (claim) lines.push(`  claimed by an agent in ${claim.label} until ${time(claim.until)}`);
			for (const warning of slot.warnings) lines.push(`  note: ${warning}`);
			if (slot.state === "running") lines.push(`  sourcemap.json: ${slot.sourcemap.detail}`);
			if (repo && pathKey(slot.repoPath) === repo) {
				this.renew(slot, root);
				const mine = slot.target.kind === "worktree" && pathKey(slot.target.path) === pathKey(root!);
				lines.push(mine ? "  -> your worktree is the one being served" : "  -> your worktree is NOT being served; call serve_here to change that");
			}
		}
		const groups = this.groups?.list() ?? [];
		if (groups.length > 0) {
			lines.push("", "Groups:");
			const name = (id: string) => slots.find((slot) => slot.id === id)?.projectName ?? id;
			for (const group of groups) lines.push(`  ${group.name} (id ${group.id})${group.active ? ", running" : ""}: ${group.projectIds.map(name).join(", ") || "no projects"}`);
		}
		const places = this.hub.studio.places();
		if (places.length > 0) {
			lines.push("", "Open Studio places (with Rojo-Hub's plugin):");
			for (const place of places) {
				const project = place.syncedWith ? `synced with ${place.syncedWith}${place.reason ? ` (${REASONS[place.reason] ?? place.reason})` : ""}` : place.message;
				lines.push(`  ${place.placeName} (${place.unsaved ? "not saved to Roblox" : `place ${place.placeId}`}, plugin ${place.pluginVersion}): ${project}`);
			}
		}
		return lines.join("\n");
	}
}
