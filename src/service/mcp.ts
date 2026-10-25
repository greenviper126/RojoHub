import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { SERVICE_VERSION, type GroupResult, type GroupView, type ListedPlace, type SlotView, type StudioPlace, type Target } from "../common/api";
import { isProjectFileName } from "../common/projectFiles";
import { git, pathKey, primaryCheckout, revParse } from "./git";
import type { Groups } from "./groups";
import { claimKey, type Hub } from "./hub";
import { OFF_MESSAGE } from "./places";
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

export const CLAIM_MS = 15 * 60 * 1000;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** How long a switch is given to reach Rojo's log before its errors are read back. */
const SETTLE_MS = 1500;
const MAX_WAIT_S = 600;
/** The first protocol version with outputSchema and structuredContent. */
const STRUCTURED_FROM = "2025-06-18";

const INSTRUCTIONS = `Rojo-Hub serves the user's Roblox Rojo projects to Roblox Studio, one fixed port per project, and switches which worktree or branch a project serves without disconnecting Studio. Its Studio plugin connects each Studio place to its project by itself. It is built for several agents working at once, each in its own worktree (Orca or git).

Before you check your changes in Studio (by hand or with a Roblox Studio tool), call serve_here with your working directory, so Studio gets the files of your worktree. Rojo applies the switch within about a second; the answer includes any error Rojo logged (an invalid project file, a bad .meta.json), and anything a Studio place could not apply; log shows more. Never stop and start a project to make Studio pick up a switch: that ends Rojo's session and disconnects every Studio synced to it. If the project is not serving, start it. If your repo is not registered, add_project it. To begin new work in a worktree of its own, use new_branch.

Which Studio to look at: serve_here, status and wait_for_studio name the Studio places synced to the project, with their place IDs. Several Studio windows may be open for different projects; use the one whose place ID is listed (Roblox Studio tools list each open Studio with its place ID). If no place is synced, wait_for_studio, or tell the user; do not inspect another project's Studio.

Rojo owns what it syncs: an edit made in Studio to a synced script or instance is overwritten by the files. Change the files in your worktree; Studio follows.

Sharing: serve_here and switch claim the project for your worktree for 15 minutes (renewed by each Rojo-Hub call you make from it). While another worktree holds it they are refused; pass wait (seconds) to take it as soon as it is free. Claims are per project, so agents in different projects never block each other. Call release when you are done with Studio.

To get ready in one call, use ensure: it starts the project, serves your worktree, opens the place and waits for Studio.

Opening Studio: when none of the project's places is open, open_place opens one in Studio (never a second copy of an open place), then wait_for_studio. It works only when the user turned on rojoHub.openPlaces; otherwise ask the user to open the place. You cannot close Studio places.

Starting projects and groups, adding projects and editing groups never disturb anyone. Stopping or removing a project another agent claimed, or that a Studio place is synced to, is refused; stop_all always is. Pass force only when the user asks. You cannot choose which project a Studio place syncs with; the user does that in the Rojo-Hub panel in VS Code.`;

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** JSON Schema of `structuredContent` (spec 011); only sent to clients of protocol 2025-06-18 or later. */
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}

/** What a tool answers: the text every client gets, and the same facts as data for clients that read `structuredContent`. */
export interface Answer {
	text: string;
	data?: Record<string, unknown>;
	/** A failure the agent should read as one (spec 011: ensure's failures are answers, so the steps done are kept). */
	isError?: boolean;
}

/* ---------- output schemas (spec 011, design 3): plain JSON Schema, extra fields allowed ---------- */

const S = { type: "string" };
const I = { type: "integer" };
const B = { type: "boolean" };
const orNull = (type: string) => ({ type: [type, "null"] });
const arrayOf = (items: Record<string, unknown>) => ({ type: "array", items });
const shape = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", properties, required });

/** One project, as `status`, `serve_here`, `switch` (and later `ensure`) describe it. */
export const PROJECT_STATE_SCHEMA = shape({
	id: S,
	name: S,
	port: I,
	repoPath: S,
	projectFile: S,
	rojo: shape({ state: { type: "string", enum: ["running", "starting", "stopped", "error"] }, error: orNull("string"), sessionId: orNull("string"), connections: I }),
	served: shape({ kind: { type: "string", enum: ["worktree", "branch"] }, label: S, path: orNull("string"), branch: orNull("string"), commit: orNull("string") }),
	claim: {
		anyOf: [{ type: "null" }, shape({ holder: S, until: S, secondsLeft: I, yours: orNull("boolean"), thenReturn: orNull("string") })],
	},
	places: arrayOf(shape({ placeId: I, name: S, pluginVersion: S, reason: orNull("string"), saved: B })),
	connecting: arrayOf(shape({ placeId: I, name: S, confirming: B })),
	listedPlaces: arrayOf(shape({ placeId: I, name: orNull("string"), open: B })),
	sourcemap: shape({ state: { type: "string", enum: ["watching", "off", "error"] }, detail: S }),
	warnings: arrayOf(S),
	yourWorktreeServed: orNull("boolean"),
});

const UNAPPLIED_SCHEMA = arrayOf(shape({ placeId: I, placeName: S, total: I, items: arrayOf(S) }));
const STATUS_SCHEMA = shape({
	projects: arrayOf(PROJECT_STATE_SCHEMA),
	groups: arrayOf(shape({ id: S, name: S, active: B, projectIds: arrayOf(S) })),
	studioPlaces: arrayOf(shape({ placeId: I, name: S, saved: B, syncedWith: orNull("string"), pluginVersion: S })),
	yourProject: orNull("string"),
});
const SWITCH_SCHEMA = shape({ project: PROJECT_STATE_SCHEMA, switched: B, problems: arrayOf(S), unapplied: UNAPPLIED_SCHEMA });

export const ENSURE_STEPS = ["start", "serve", "open_place", "wait_for_studio"] as const;
export const ENSURE_OUTCOMES = ["done", "already", "skipped", "failed"] as const;
export const ENSURE_FAILURES = ["no_project", "start_failed", "claimed", "rojo_error", "open_places_off", "no_listed_places", "several_places", "open_failed", "studio_confirming", "timeout", "stopped"] as const;
type EnsureFailure = (typeof ENSURE_FAILURES)[number];
interface EnsureStep {
	step: (typeof ENSURE_STEPS)[number];
	outcome: (typeof ENSURE_OUTCOMES)[number];
	detail: string;
}
/** project is null only for no_project: no step ran, so there is no project to describe. */
const ENSURE_SCHEMA = shape({
	ready: B,
	steps: arrayOf(shape({ step: { type: "string", enum: [...ENSURE_STEPS] }, outcome: { type: "string", enum: [...ENSURE_OUTCOMES] }, detail: S })),
	project: { anyOf: [{ type: "null" }, PROJECT_STATE_SCHEMA] },
	placeIds: arrayOf(I),
	failure: { anyOf: [{ type: "null" }, shape({ reason: { type: "string", enum: [...ENSURE_FAILURES] }, message: S })] },
});

const pathProperty = { type: "string", description: "Your working directory (absolute), or any folder inside the worktree." };
const projectProperty = { type: "string", description: "The project's name or id, as status shows it. Only needed when a repo has more than one project, or without path." };
const forceProperty = { type: "boolean", description: "Go ahead even though another agent or a synced Studio would be affected. Only when the user asks." };
const thenReturnProperty = { type: "boolean", description: "When you release, or your hold runs out, switch the project back to what it served before you took it (only if nobody else has taken it since, it is still serving, and that worktree's folder still exists). For borrowing a project the user or another agent was using." };
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
		outputSchema: STATUS_SCHEMA,
		annotations: { readOnlyHint: true },
	},
	{
		name: "serve_here",
		title: "Serve my worktree",
		description:
			"Makes Studio show your worktree: switches the project of the repo you are in to your worktree, live, without disconnecting Studio, and claims it for 15 minutes. Says which Studio places show it and any error Rojo logged. Call it before checking changes in Studio.",
		inputSchema: { type: "object", properties: { path: pathProperty, project: projectProperty, wait: waitProperty, then_return: thenReturnProperty, force: forceProperty }, required: ["path"] },
		outputSchema: SWITCH_SCHEMA,
	},
	{
		name: "switch",
		title: "Serve a branch or worktree",
		description:
			"Switches a project to serve a branch (by name, e.g. main or origin/feature) or a worktree (by folder), live, and claims it. A branch checked out in a worktree is served from that worktree; any other branch from a read-only copy Rojo-Hub keeps.",
		inputSchema: project({ target: { type: "string", description: "A branch name, or a worktree's folder." }, wait: waitProperty, then_return: thenReturnProperty, force: forceProperty }, ["target"]),
		outputSchema: SWITCH_SCHEMA,
	},
	{
		name: "ensure",
		title: "Get ready for Studio",
		description:
			"Gets Studio showing your worktree in one call: starts the project if stopped, serves your worktree (claims it for 15 minutes), opens the place when none is open (if the user allowed rojoHub.openPlaces), waits for the sync. Done steps are skipped, so a second call only renews the claim. Says why it could not finish and what to do; ready: true means a place is synced.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProperty,
				project: projectProperty,
				place: { type: "number", description: "Which place to open, when the project lists several (status lists them)." },
				timeout: { type: "number", description: "Seconds to wait for Studio to sync (default 60, 5 to 300)." },
				wait: waitProperty,
				then_return: thenReturnProperty,
				force: forceProperty,
			},
			required: ["path"],
		},
		outputSchema: ENSURE_SCHEMA,
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
		description: "Starts serving a project that is stopped (or in error). Studio places listed in its servePlaceIds sync by themselves. Never disturbs anyone. Never needed after serve_here or switch: they apply over the running session.",
		inputSchema: project(),
	},
	{
		name: "stop",
		title: "Stop a project",
		description: "Stops serving a project; its Studio places disconnect. Do not stop and start a project to make Studio pick up a switch: that ends Rojo's session, and serve_here and switch already say what Studio could not apply. Refused while another agent claimed it or a Studio place is synced to it and you hold no claim, unless force.",
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
		name: "open_place",
		title: "Open a place in Studio",
		description:
			"Opens one of a project's places (from its project file's servePlaceIds or placeId) in Roblox Studio, unless it is already open: then it does nothing and says so. Then call wait_for_studio. Only works when the user turned on rojoHub.openPlaces.",
		inputSchema: project({ placeId: { type: "number", description: "Which of the project's places; may be left out when it has only one. status lists them." } }),
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
	async handle(message: unknown, protocol?: string): Promise<object | null> {
		// Only a client that sent MCP-Protocol-Version 2025-06-18 or later understands outputSchema and structuredContent.
		const structured = typeof protocol === "string" && /^\d{4}-\d{2}-\d{2}$/.test(protocol.trim()) && protocol.trim() >= STRUCTURED_FROM;
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
				return reply({ tools: structured ? TOOLS : TOOLS.map(({ outputSchema: _outputSchema, ...tool }) => tool) });
			case "tools/call": {
				const name = params?.name;
				if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
				const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Args;
				try {
					const answer = await this.call(name, args);
					return reply({ content: [{ type: "text", text: answer.text }], ...(structured && answer.data ? { structuredContent: answer.data } : {}), ...(answer.isError ? { isError: true } : {}) });
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

	/** Runs a tool. Those without data answer plain text. */
	private async call(name: string, args: Args): Promise<Answer> {
		const result = await this.run(name, args);
		return typeof result === "string" ? { text: result } : result;
	}

	private run(name: string, args: Args): Promise<string | Answer> {
		switch (name) {
			case "status":
				return this.status(args);
			case "serve_here":
				return this.serveHere(args);
			case "switch":
				return this.switchTo(args);
			case "ensure":
				return this.ensure(args);
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
			case "open_place":
				return this.openPlace(args);
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
		const current = this.hub.view(this.hub.registry.get(slot.id));
		// What to give back (spec 013): kept from this agent's earlier call, else what is served now.
		let returnTo = before?.key === key ? before.returnTo : undefined;
		if (!returnTo && args.then_return === true && claimKey(current.target) !== key) returnTo = { target: current.target, label: current.targetLabel };
		this.hub.setClaim(slot.id, { key, label, until: Date.now() + CLAIM_MS, ...(returnTo ? { returnTo } : {}) });
		if (claimKey(current.target) === key) return current;
		try {
			return await this.hub.switch(slot.id, target);
		} catch (error) {
			this.hub.setClaim(slot.id, before);
			throw error;
		}
	}

	/** One line on then_return for the answer of a call that took the project (spec 013). */
	private returnNote(slot: SlotView, args: Args): string {
		const back = this.hub.claimOf(slot.id)?.returnTo;
		if (back) return `\nWhen you release, or your hold runs out, it switches back to ${back.label}${args.then_return === true ? "" : " (as you asked earlier)"}.`;
		return args.then_return === true ? "\nthen_return: there was nothing to return to (the project already served this)." : "";
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

	/*
		What synced places said they could not apply since the call began (spec
		010): the honest answer to "why is it not in Studio", so the agent does
		not restart rojo, which would end Studio's session.
	*/
	private unapplied(slot: SlotView, since: number): string {
		const reports = this.hub.studio.unappliedOn(slot.port, since);
		if (reports.length === 0) return "";
		const lines = reports.map((report) => `${report.placeName} (place ${report.placeId}) could not apply ${report.total} change${report.total === 1 ? "" : "s"}: ${report.items.join("; ")}${report.total > report.items.length ? "; …" : ""}.`);
		return `\n${lines.join("\n")}\nDo not stop and start the project for this: that ends Studio's session. Tell the user what is missing.`;
	}

	/** Said when the Hub restarted a crashed rojo since the call began: a new session, so the agent waits for Studio. */
	private crashed(slot: SlotView, since: number): string {
		if (this.hub.crashedAt(slot.id) < since) return "";
		return "\nRojo crashed meanwhile and Rojo-Hub restarted it. That is a new Rojo session: Studio reconnects through the plugin. Call wait_for_studio before checking Studio.";
	}

	/* ---------- the same facts as data (spec 011, design 3) ---------- */

	/*
		One project as PROJECT_STATE_SCHEMA says. `root` is the caller's worktree
		(null without a path): it decides claim.yours and yourWorktreeServed. The
		served commit is read here, so build several at once with Promise.all.
	*/
	async projectState(slot: SlotView, root: string | null): Promise<Record<string, unknown>> {
		const claim = this.hub.claimOf(slot.id);
		const open = this.hub.studio.places();
		const onWorktree = slot.target.kind === "worktree" ? slot.target.path : null;
		const commit = slot.target.kind === "worktree" ? await revParse(slot.target.path, "HEAD") : await revParse(slot.repoPath, slot.target.ref);
		const mine = root !== null && onWorktree !== null && pathKey(onWorktree) === pathKey(root);
		return {
			id: slot.id,
			name: slot.projectName,
			port: slot.port,
			repoPath: slot.repoPath,
			projectFile: slot.projectFile,
			rojo: {
				state: slot.state === "offline" ? "stopped" : slot.state,
				error: slot.error,
				sessionId: slot.sessionId,
				connections: slot.connections,
			},
			served: { kind: slot.target.kind, label: slot.targetLabel, path: onWorktree, branch: slot.branch, commit },
			claim: claim
				? {
						holder: claim.label,
						until: new Date(claim.until).toISOString(),
						secondsLeft: Math.max(0, Math.round((claim.until - Date.now()) / 1000)),
						yours: root === null ? null : claim.key === claimKey({ kind: "worktree", path: root }),
						thenReturn: claim.returnTo?.label ?? null,
					}
				: null,
			places: (slot.state === "running" ? (slot.places ?? []) : []).map((place) => ({
				placeId: place.placeId,
				name: place.placeName,
				pluginVersion: place.pluginVersion,
				reason: open.find((entry) => entry.placeId === place.placeId && entry.syncedWith === slot.projectName)?.reason ?? null,
				saved: place.placeId > 0,
			})),
			connecting: open
				.filter((place) => place.projectId === slot.id && place.syncedWith !== slot.projectName)
				.map((place) => ({ placeId: place.unsaved ? 0 : place.placeId, name: place.placeName, confirming: place.confirming })),
			listedPlaces: (slot.listedPlaces ?? []).map((place) => ({ placeId: place.placeId, name: place.placeName, open: place.open })),
			sourcemap: { state: slot.sourcemap.state, detail: slot.sourcemap.detail },
			warnings: [...slot.warnings],
			yourWorktreeServed: root === null ? null : mine,
		};
	}

	/** Rojo's error lines and the card's warnings, for `problems`. */
	private problemLines(slot: SlotView): string[] {
		return [...(slot.error ? slot.error.split("\n").slice(0, 6).filter((line) => line.trim() !== "") : []), ...slot.warnings];
	}

	private unappliedData(slot: SlotView, since: number): { placeId: number; placeName: string; total: number; items: string[] }[] {
		return this.hub.studio.unappliedOn(slot.port, since).map((report) => ({ placeId: report.placeId, placeName: report.placeName, total: report.total, items: [...report.items] }));
	}

	/** The `data` of serve_here and switch. */
	private async switchData(before: SlotView, now: SlotView, root: string | null, since: number): Promise<Record<string, unknown>> {
		return {
			project: await this.projectState(now, root),
			switched: claimKey(before.target) !== claimKey(now.target),
			problems: this.problemLines(now),
			unapplied: this.unappliedData(now, since),
		};
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

	private async serveHere(args: Args): Promise<Answer> {
		const { slot, root } = await this.pick(args);
		if (!root) throw new Refusal("path is required: your working directory.");
		const since = Date.now();
		const switched = await this.take(slot, { kind: "worktree", path: root }, basename(root), args);
		const now = await this.settled(switched);
		return {
			text: `${now.projectName} now serves ${root}${now.branch ? ` (branch ${now.branch})` : ""}. ${this.health(now)}${this.problems(now)}${this.unapplied(now, since)}${this.crashed(now, since)}\nYou hold it until ${time(Date.now() + CLAIM_MS)}; each Rojo-Hub call from this worktree renews that. Call release when you are done with Studio.${this.returnNote(slot, args)}`,
			data: await this.switchData(slot, now, root, since),
		};
	}

	private async switchTo(args: Args): Promise<Answer> {
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
		const since = Date.now();
		const switched = await this.take(slot, target, label, args);
		if (root) this.renew(switched, root);
		const now = await this.settled(switched);
		return {
			text: `${now.projectName} now serves ${now.targetLabel}${target.kind === "branch" ? " from a read-only copy (edits there are not possible)" : ""}. ${this.health(now)}${this.problems(now)}${this.unapplied(now, since)}${this.crashed(now, since)}\nClaimed until ${time(Date.now() + CLAIM_MS)}. Call release when you are done with Studio.${this.returnNote(slot, args)}`,
			data: await this.switchData(slot, now, root, since),
		};
	}

	private async release(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const claim = this.hub.claimOf(slot.id);
		if (!claim) {
			const lapsed = this.hub.lapsedClaim(slot.id);
			if (lapsed && (!root || lapsed.key === claimKey({ kind: "worktree", path: root }))) {
				const back = lapsed.returnTo ? await this.hub.handBack(slot.id, lapsed, "expiry") : null;
				this.hub.setClaim(slot.id, null);
				const now = this.hub.view(this.hub.registry.get(slot.id));
				return `${root ? "Your" : `${lapsed.label}'s`} claim on ${slot.projectName} had already run out; ${back?.returned ? `it went back to ${back.label}.` : `it still serves ${now.targetLabel}${back ? ` (not switched back: ${back.why})` : ""}.`}`;
			}
			return `${slot.projectName} was not claimed.`;
		}
		// Without a path there is no telling whose claim it is; another agent's is only dropped with force.
		if (!root && args.force !== true) throw new Refusal(`${slot.projectName} is claimed by ${claim.label}. Pass path (your worktree) to release your own claim.`);
		if (root && claim.key !== claimKey({ kind: "worktree", path: root })) {
			throw new Refusal(`${slot.projectName} is claimed by ${claim.label}, not by your worktree; leaving it.`);
		}
		// Switched back before the claim is dropped, so an agent waiting for the project cannot interleave.
		const back = claim.returnTo ? await this.hub.handBack(slot.id, claim, "release") : null;
		this.hub.setClaim(slot.id, null);
		if (back?.returned) return `Released ${slot.projectName}. It switched back to ${back.label}, which it served before you took it.`;
		const now = this.hub.view(this.hub.registry.get(slot.id));
		return `Released ${slot.projectName}. It keeps serving ${now.targetLabel}${back ? ` (not switched back: ${back.why})` : ""}.`;
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
		const notes = made.notes.length ? ` (${made.notes.join("; ")})` : "";
		return `Made branch ${made.branch} from ${made.from}${notes} in ${made.path} (${made.via === "orca" ? "an Orca worktree" : "a git worktree"}); ${now.projectName} now serves it and you hold it until ${time(Date.now() + CLAIM_MS)}. Work in ${made.path}. ${this.health(now)}${this.problems(now)}`;
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
		const waited = await this.awaitStudio(slot, clamp(args.timeout, 30, 300));
		const now = waited.slot;
		switch (waited.outcome) {
			case "synced":
				return this.health(now);
			case "stopped":
				return `${now.projectName} is not serving, so no Studio can sync to it. ${this.health(now)}`;
			case "timeout":
				return `No Studio place synced to ${now.projectName} in time. ${this.health(now)}`;
			default:
				return `A Studio place is waiting for the user to accept its first sync with ${now.projectName}. ${this.health(now)}`;
		}
	}

	/*
		The wait of wait_for_studio and ensure: until a place is synced, a place
		waits for the user to accept the first sync, the project stopped, or the
		time ran out.
	*/
	private async awaitStudio(slot: SlotView, seconds: number): Promise<{ outcome: "synced" | "stopped" | "timeout" | "confirming"; slot: SlotView }> {
		const deadline = Date.now() + seconds * 1000;
		for (;;) {
			const now = this.hub.view(this.hub.registry.get(slot.id));
			if (now.state === "running" && (now.places ?? []).length > 0) return { outcome: "synced", slot: now };
			if (now.state === "stopped" || now.state === "error") return { outcome: "stopped", slot: now };
			if (Date.now() >= deadline) return { outcome: "timeout", slot: now };
			if (this.hub.studio.places().some((place) => place.projectId === now.id && place.confirming)) return { outcome: "confirming", slot: now };
			await sleep(500);
		}
	}

	/*
		Gets the caller ready for Studio in one call (spec 011, design 2). Each step
		runs only when its condition holds, nothing is rolled back, and failures are
		answers (isError, with data) so the steps done are kept.
	*/
	private async ensure(args: Args): Promise<Answer> {
		const steps: EnsureStep[] = [];
		const since = Date.now();
		let slot: SlotView;
		let root: string | null;
		try {
			if (!text(args.path)) throw new Refusal("path is required: your working directory.");
			({ slot, root } = await this.pick(args));
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			return this.ensureAnswer(null, null, steps, { reason: "no_project", message: error.message }, since);
		}
		const fresh = () => this.hub.view(this.hub.registry.get(slot.id));
		const fail = (reason: EnsureFailure, message: string) => this.ensureAnswer(fresh(), root, steps, { reason, message }, since);
		const raw = args.place === undefined || args.place === null || args.place === "" ? null : typeof args.place === "string" ? args.place.trim() : args.place;
		const wantedPlace = raw === null ? null : typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
		if (wantedPlace !== null && (!Number.isSafeInteger(wantedPlace) || wantedPlace <= 0)) return fail("no_listed_places", `place must be a positive integer place ID (a number or digits), not ${JSON.stringify(args.place)}. Call ensure again with place as one of the project's places.`);
		const placeCount = (view: SlotView) => (view.state === "running" ? (view.places ?? []).length : 0);

		// An error nothing above turned into an answer still keeps the steps done.
		let stage: EnsureStep["step"] = "start";
		const failed: Record<EnsureStep["step"], EnsureFailure> = { start: "start_failed", serve: "rojo_error", open_place: "open_failed", wait_for_studio: "timeout" };
		try {
			// 2. start
			stage = "start";
			if (slot.state === "stopped" || slot.state === "error" || slot.state === "offline") {
				try {
					await this.hub.start(slot.id);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					steps.push({ step: "start", outcome: "failed", detail: message });
					return fail("start_failed", `${slot.projectName} did not start: ${message.split("\n")[0]} Nothing was served. Fix that, then call ensure again.`);
				}
				const started = await this.settled(slot);
				if (started.state === "error") {
					const lines = this.problemLines(started).join(" ");
					steps.push({ step: "start", outcome: "failed", detail: lines });
					return fail("start_failed", `${started.projectName} is in error after starting: ${lines || "see log"} Nothing was served. Fix that, then call ensure again.`);
				}
				steps.push({ step: "start", outcome: "done", detail: `started ${started.projectName} on port ${started.port}` });
				slot = started;
			} else {
				steps.push({ step: "start", outcome: "already", detail: `${slot.projectName} is ${slot.state}` });
				if (slot.state === "starting") slot = await this.settled(slot);
			}

			// 3. claim and serve
			stage = "serve";
			const beforeKey = claimKey(slot.target);
			let now: SlotView;
			try {
				now = await this.take(slot, { kind: "worktree", path: root! }, basename(root!), args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!(error instanceof Refusal) && !(error instanceof Conflict) && !(error instanceof NotFound)) throw error;
				steps.push({ step: "serve", outcome: "failed", detail: message });
				return fail(error instanceof Refusal ? "claimed" : "rojo_error", `${message} ${error instanceof Refusal ? "The project was not switched." : "Nothing was switched."}`);
			}
			const switched = beforeKey !== claimKey(now.target);
			now = await this.settled(now);
			steps.push({ step: "serve", outcome: switched ? "done" : "already", detail: switched ? `${now.projectName} now serves ${root}` : `${now.projectName} already served ${root}; claim renewed` });
			const returnLine = this.returnNote(now, args).trim();
			if (returnLine) steps[steps.length - 1].detail += `; ${returnLine.replace(/^then_return: /, "")}`;
			if (now.error || now.state === "error") {
				const lines = this.problemLines(now).join(" ");
				steps[steps.length - 1].detail += `; Rojo reports: ${lines}`;
				return fail("rojo_error", `The switch was made, but Rojo reports: ${lines} Fix the files in your worktree (log shows more); do not restart the project.`);
			}

			// 4. open_place
			stage = "open_place";
			const listed = now.listedPlaces ?? [];
			const wanted = args.place === undefined || args.place === null || args.place === "" ? null : wantedPlace;
			const connecting = this.hub.studio.places().filter((place) => place.projectId === now.id && place.syncedWith !== now.projectName);
			const hadPlace = placeCount(now) > 0;
			if (hadPlace) {
				steps.push({ step: "open_place", outcome: "already", detail: `${this.placeList(now.places ?? [])} synced` });
			} else if (connecting.length > 0) {
				steps.push({ step: "open_place", outcome: "skipped", detail: `${this.placeList(connecting)} already connecting` });
			} else {
				const chosen = wanted === null ? (listed.length === 1 ? listed[0] : null) : (listed.find((place) => place.placeId === wanted) ?? null);
				const openOnes = wanted === null ? listed.filter((place) => place.open) : chosen?.open ? [chosen] : [];
				if (listed.length === 0) {
					steps.push({ step: "open_place", outcome: "skipped", detail: "the project file names no places" });
					return fail("no_listed_places", `${now.projectName}'s project file names no places (servePlaceIds, placeId), so none can be opened. Ask the user to open the place in Studio, then call wait_for_studio.`);
				}
				if (wanted !== null && !chosen) {
					steps.push({ step: "open_place", outcome: "skipped", detail: `place ${wanted} is not listed` });
					return fail("no_listed_places", `${wanted} is not one of ${now.projectName}'s places: ${this.listedText(listed)}. Call ensure again with place as one of them.`);
				}
				if (openOnes.length > 0) {
					steps.push({ step: "open_place", outcome: "already", detail: `${this.listedText(openOnes)} already open in Studio` });
				} else if (!this.hub.openPlacesOn) {
					steps.push({ step: "open_place", outcome: "skipped", detail: "rojoHub.openPlaces is off" });
					return fail("open_places_off", `${OFF_MESSAGE} The project is started and serves your worktree; ask the user to open one of its places in Studio (${this.listedText(listed)}), then call wait_for_studio.`);
				} else if (!chosen) {
					steps.push({ step: "open_place", outcome: "skipped", detail: "several places and none chosen" });
					return fail("several_places", `${now.projectName} has several places and none was opened: ${this.listedText(listed)}. Call ensure again with place as one of them.`);
				} else {
					try {
						const opened = await this.hub.openPlace(now.id, chosen.placeId);
						steps.push({ step: "open_place", outcome: opened.outcome === "opened" ? "done" : "already", detail: `${opened.outcome === "opened" ? "opening" : "already open:"} place ${chosen.placeId}${opened.placeName ? ` (${opened.placeName})` : ""}` });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						steps.push({ step: "open_place", outcome: "failed", detail: message });
						const open = listed.filter((place) => place.open);
						return fail("open_failed", `Opening place ${chosen.placeId} failed: ${message.split("\n")[0]} Places open already: ${open.length ? this.listedText(open) : "none"}. Ask the user to open it in Studio.`);
					}
				}
			}

			// 5. wait_for_studio
			stage = "wait_for_studio";
			if (hadPlace) {
				steps.push({ step: "wait_for_studio", outcome: "already", detail: "a place is synced" });
			} else {
				const waited = await this.awaitStudio(now, Math.max(5, clamp(args.timeout, 60, 300)));
				now = waited.slot;
				if (waited.outcome === "synced") {
					steps.push({ step: "wait_for_studio", outcome: "done", detail: `${this.placeList(now.places ?? [])} synced` });
				} else {
					const connectingNow = this.hub.studio.places().filter((place) => place.projectId === now.id && place.syncedWith !== now.projectName);
					const detail = waited.outcome === "stopped" ? "the project stopped" : waited.outcome === "confirming" ? "a place waits for the user to accept the first sync" : `nothing synced in time${connectingNow.length ? `; connecting: ${this.placeList(connectingNow)}` : ""}`;
					steps.push({ step: "wait_for_studio", outcome: "failed", detail });
					if (waited.outcome === "stopped") return fail("stopped", `${now.projectName} was stopped while waiting, by someone else; the files were switched to your worktree. Start it again with ensure.`);
					if (waited.outcome === "confirming") return fail("studio_confirming", `A Studio place is waiting for the user to accept its first sync with ${now.projectName} (Rojo asks once per place and project). Ask the user to accept it in Studio, then call wait_for_studio.`);
					return fail("timeout", `No Studio place synced to ${now.projectName} in time${connectingNow.length ? `; connecting: ${this.placeList(connectingNow)}` : ""}. Call wait_for_studio to keep waiting.`);
				}
			}
			return this.ensureAnswer(fresh(), root, steps, null, since);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			steps.push({ step: stage, outcome: "failed", detail: message });
			return fail(failed[stage], `${message.split("\n")[0]} (step ${stage}); the steps above were done.`);
		}
	}

	/** The answer of ensure: the steps, then why it stopped or how Studio looks. ready: running, serving this worktree, a place synced. */
	private async ensureAnswer(slot: SlotView | null, root: string | null, steps: EnsureStep[], failure: { reason: EnsureFailure; message: string } | null, since: number): Promise<Answer> {
		const project = slot ? await this.projectState(slot, root) : null;
		const places = slot && slot.state === "running" ? (slot.places ?? []) : [];
		const ready = failure === null && slot !== null && slot.state === "running" && project?.yourWorktreeServed === true && places.length > 0;
		const lines = steps.map((step) => `${step.step}: ${step.outcome}, ${step.detail}`);
		const tail = failure ? failure.message : slot ? `${this.health(slot)}${this.problems(slot)}${this.unapplied(slot, since)}${this.crashed(slot, since)}` : "";
		return {
			text: `${failure ? "Not ready." : ready ? "Ready." : "Not ready: your worktree is not the one served."}${lines.length ? `\n${lines.join("\n")}` : ""}\n${tail}`,
			data: { ready, steps, project, placeIds: places.map((place) => place.placeId).filter((id) => id > 0), failure },
			...(failure ? { isError: true } : {}),
		};
	}

	private async openPlace(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		this.renew(slot, root);
		if (!this.hub.openPlacesOn) throw new Refusal(`${OFF_MESSAGE} Ask the user to open the place in Studio instead.`);
		const listed = slot.listedPlaces ?? [];
		if (listed.length === 0) throw new Refusal(`${slot.projectName}'s project file names no places (servePlaceIds, placeId), so there is nothing to open. Ask the user to open the place in Studio.`);
		let placeId: number;
		if (args.placeId === undefined || args.placeId === null || args.placeId === "") {
			if (listed.length > 1) throw new Refusal(`${slot.projectName} has several places; pass placeId as one of: ${this.listedText(listed)}.`);
			placeId = listed[0].placeId;
		} else {
			placeId = Number(args.placeId);
			if (!listed.some((place) => place.placeId === placeId)) throw new Refusal(`${String(args.placeId)} is not one of ${slot.projectName}'s places: ${this.listedText(listed)}.`);
		}
		const result = await this.hub.openPlace(slot.id, placeId);
		const name = result.placeName ? `${result.placeName} (place ${placeId})` : `Place ${placeId}`;
		if (result.outcome === "already-open") return `${name} is already open in Studio; nothing was opened. ${this.health(this.hub.view(this.hub.registry.get(slot.id)))}`;
		return `Opening ${name} in Studio. Studio takes a while to load; call wait_for_studio to know when it is synced with ${slot.projectName}${slot.state === "running" ? "" : " (the project is not serving: start it)"}.`;
	}

	/** `Lobby (place 111, open), place 222` */
	private listedText(places: ListedPlace[]): string {
		return places
			.map((place) => {
				const state = place.open ? "open" : "not open";
				return place.placeName ? `${place.placeName} (place ${place.placeId}, ${state})` : `place ${place.placeId} (${state})`;
			})
			.join(", ");
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

	private async status(args: Args): Promise<Answer> {
		const slots = this.hub.list();
		const path = text(args.path);
		const root = path ? await worktreeRoot(path).catch(() => null) : null;
		const repo = root ? pathKey(await primaryCheckout(root).catch(() => root)) : null;
		const mineOf = (slot: SlotView) => (repo !== null && pathKey(slot.repoPath) === repo ? root : null);
		const groups = this.groups?.list() ?? [];
		const data = {
			projects: await Promise.all(slots.map((slot) => this.projectState(slot, mineOf(slot)))),
			groups: groups.map((group) => ({ id: group.id, name: group.name, active: group.active, projectIds: [...group.projectIds] })),
			studioPlaces: this.hub.studio.places().map((place) => ({ placeId: place.unsaved ? 0 : place.placeId, name: place.placeName, saved: !place.unsaved, syncedWith: place.syncedWith, pluginVersion: place.pluginVersion })),
			yourProject: slots.find((slot) => mineOf(slot) !== null)?.id ?? null,
		};
		return { text: await this.statusText(slots, root, repo), data };
	}

	private async statusText(slots: SlotView[], root: string | null, repo: string | null): Promise<string> {
		if (slots.length === 0) return "Rojo-Hub has no projects. Add one with add_project (path: a folder in the repo).";
		const lines: string[] = [];
		for (const slot of slots) {
			const claim = this.hub.claimOf(slot.id);
			if (lines.length > 0) lines.push("");
			const serves = slot.target.kind === "worktree" ? `${slot.targetLabel}${slot.branch && slot.branch !== slot.targetLabel ? ` (branch ${slot.branch})` : ""} at ${slot.target.path}` : `branch ${slot.targetLabel} (read-only copy)`;
			lines.push(`${slot.projectName} (id ${slot.id}), port ${slot.port}: ${this.health(slot)}`, `  serves ${serves}, project file ${slot.projectFile}`, `  repo ${slot.repoPath}`);
			if (claim) lines.push(`  claimed by an agent in ${claim.label} until ${time(claim.until)}`);
			if (slot.listedPlaces?.length) lines.push(`  places: ${this.listedText(slot.listedPlaces)}${this.hub.openPlacesOn ? " (open_place opens one)" : ""}`);
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
