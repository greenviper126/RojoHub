import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { SERVICE_VERSION, type SlotView, type Target } from "../common/api";
import { git, pathKey, primaryCheckout } from "./git";
import { claimKey, type Hub } from "./hub";
import { Conflict, NotFound } from "./registry";

/*
	Rojo-Hub for agents (spec 004): the Model Context Protocol over streamable
	HTTP, answered with plain JSON (no event streams, no sessions). Agents get
	the same switching the panel has, but not starting, stopping, adding or
	removing projects: starting rojo is a new Studio session, and that stays the
	user's call.

	Several agents can work in worktrees of one repo while one Studio shows one
	of them, so switching claims the project for the switcher's target for
	CLAIM_MS. Another target is refused until the claim runs out, is released,
	or is overridden with `force`. A switch made by the user clears the claim.
*/

export const CLAIM_MS = 10 * 60 * 1000;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Rojo-Hub serves the user's Roblox Rojo projects to Roblox Studio, one fixed port per project, and switches which worktree or branch a project serves without disconnecting Studio.

Before you check your changes in Studio (by hand or with a Roblox Studio tool), call serve_here with your working directory, so Studio gets the files of your worktree. Several agents may share one Studio: serve_here claims the project for your worktree for 10 minutes (renewed by each Rojo-Hub call you make from it) and is refused while another worktree holds it; do not pass force unless the user asks. Call release when you are done with Studio.

You cannot start, stop, add or remove projects. If a project is not serving, or a repo is not registered, tell the user to do it in the Rojo-Hub panel in VS Code.`;

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>;
}

const pathProperty = { type: "string", description: "Your working directory (absolute), or any folder inside the worktree." };
const projectProperty = { type: "string", description: "The project's name or id, as status shows it. Only needed when a repo has more than one project." };
const forceProperty = { type: "boolean", description: "Take the project even though another worktree claimed it. Only when the user asks." };

export const TOOLS: Tool[] = [
	{
		name: "status",
		title: "Rojo-Hub status",
		description:
			"Lists the Rojo projects Rojo-Hub serves: port, whether rojo is serving, whether Studio is connected, which worktree or branch each one serves, and who claimed it. With path, also says whether your worktree is the one being served.",
		inputSchema: { type: "object", properties: { path: pathProperty } },
		annotations: { readOnlyHint: true },
	},
	{
		name: "serve_here",
		title: "Serve my worktree",
		description:
			"Makes Studio show your worktree: switches the project of the repo you are in to serve your worktree, live, without disconnecting Studio, and claims it for your worktree for 10 minutes. Call it before checking changes in Studio.",
		inputSchema: { type: "object", properties: { path: pathProperty, project: projectProperty, force: forceProperty }, required: ["path"] },
	},
	{
		name: "switch",
		title: "Serve a branch or worktree",
		description:
			"Switches a project to serve a branch (by name, e.g. main or origin/feature) or a worktree (by folder), live, and claims it. A branch checked out in a worktree is served from that worktree; any other branch from a read-only copy Rojo-Hub keeps.",
		inputSchema: {
			type: "object",
			properties: { project: projectProperty, path: pathProperty, target: { type: "string", description: "A branch name, or a worktree's folder." }, force: forceProperty },
			required: ["target"],
		},
	},
	{
		name: "release",
		title: "Release a project",
		description: "Drops your claim on a project, so other agents can switch it. The project keeps serving what it serves.",
		inputSchema: { type: "object", properties: { path: pathProperty, project: projectProperty } },
		annotations: { idempotentHint: true },
	},
	{
		name: "build",
		title: "Build a place file",
		description:
			"Builds a Roblox place file (.rbxl or .rbxlx) of exactly what a project serves right now, including packages borrowed from the main checkout. Use serve_here first to build your own worktree.",
		inputSchema: {
			type: "object",
			properties: { path: pathProperty, project: projectProperty, output: { type: "string", description: "Absolute path of the place file to write, ending in .rbxl or .rbxlx." } },
			required: ["output"],
		},
	},
	{
		name: "sourcemap",
		title: "Write sourcemap.json",
		description: "Writes sourcemap.json (for luau-lsp and other tools) into the worktree a project serves, once, now. While a worktree is served Rojo-Hub usually keeps it current by itself.",
		inputSchema: { type: "object", properties: { path: pathProperty, project: projectProperty } },
	},
];

/** A tool call the agent got wrong, or that was refused: reported to the agent as a tool error, not a protocol error. */
class Refusal extends Error {}

type Args = Record<string, unknown>;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

export class Mcp {
	constructor(private readonly hub: Hub) {}

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
			case "build":
				return this.build(args);
			default:
				return this.sourcemap(args);
		}
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
		const wanted = text(args.project)?.toLowerCase();
		if (wanted) {
			const slot = slots.find((entry) => entry.id.toLowerCase() === wanted || entry.projectName.toLowerCase() === wanted);
			if (!slot) throw new Refusal(`No project named ${args.project}. Projects: ${slots.map((entry) => entry.projectName).join(", ") || "none"}.`);
			return { slot, root };
		}
		if (!root) {
			if (slots.length === 1) return { slot: slots[0], root };
			throw new Refusal(`Say which project with path (your working directory) or project. Projects: ${slots.map((entry) => entry.projectName).join(", ") || "none"}.`);
		}
		const repo = pathKey(await primaryCheckout(root));
		const matches = slots.filter((entry) => pathKey(entry.repoPath) === repo);
		if (matches.length === 1) return { slot: matches[0], root };
		if (matches.length > 1) throw new Refusal(`This repo has several projects; pass project as one of: ${matches.map((entry) => entry.projectName).join(", ")}.`);
		throw new Refusal(
			`${basename(root)} belongs to a repo Rojo-Hub does not serve. Ask the user to add it in the Rojo-Hub panel in VS Code (Projects, +). Registered: ${slots.map((entry) => `${entry.projectName} (${entry.repoPath})`).join(", ") || "none"}.`,
		);
	}

	/** Refuses when another target holds the slot, unless forced; renews the caller's own claim. */
	private checkClaim(slot: SlotView, key: string, force: boolean): void {
		const claim = this.hub.claimOf(slot.id);
		if (!claim || claim.key === key || force) return;
		const minutes = Math.max(1, Math.ceil((claim.until - Date.now()) / 60000));
		throw new Refusal(
			`${slot.projectName} is claimed by an agent working in ${claim.label} until ${time(claim.until)} (${minutes} min). Switching now would change what Studio shows under that agent. Wait and try again, ask the user, or pass force: true if the user said to.`,
		);
	}

	private renew(slot: SlotView, root: string | null): void {
		if (!root) return;
		const claim = this.hub.claimOf(slot.id);
		if (claim && claim.key === claimKey({ kind: "worktree", path: root })) this.hub.setClaim(slot.id, { ...claim, until: Date.now() + CLAIM_MS });
	}

	private async take(slot: SlotView, target: Target, label: string, force: boolean): Promise<SlotView> {
		const key = claimKey(target);
		this.checkClaim(slot, key, force);
		// Claimed before switching, so a second agent asking at the same moment is refused rather than both switching.
		const before = this.hub.claimOf(slot.id);
		this.hub.setClaim(slot.id, { key, label, until: Date.now() + CLAIM_MS });
		if (claimKey(slot.target) === key) return this.hub.view(this.hub.registry.get(slot.id));
		try {
			return await this.hub.switch(slot.id, target);
		} catch (error) {
			this.hub.setClaim(slot.id, before);
			throw error;
		}
	}

	private async serveHere(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		if (!root) throw new Refusal("path is required: your working directory.");
		const now = await this.take(slot, { kind: "worktree", path: root }, basename(root), args.force === true);
		return `${now.projectName} now serves ${root}${now.branch ? ` (branch ${now.branch})` : ""}. ${this.health(now)}\nYou hold it until ${time(Date.now() + CLAIM_MS)}; each Rojo-Hub call from this worktree renews that. Call release when you are done with Studio.`;
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
		const now = await this.take(slot, target, label, args.force === true);
		if (root) this.renew(now, root);
		return `${now.projectName} now serves ${now.targetLabel}${target.kind === "branch" ? " from a read-only copy (edits there are not possible)" : ""}. ${this.health(now)}\nClaimed until ${time(Date.now() + CLAIM_MS)}. Call release when you are done with Studio.`;
	}

	private async release(args: Args): Promise<string> {
		const { slot, root } = await this.pick(args);
		const claim = this.hub.claimOf(slot.id);
		if (!claim) return `${slot.projectName} was not claimed.`;
		if (root && claim.key !== claimKey({ kind: "worktree", path: root })) {
			throw new Refusal(`${slot.projectName} is claimed by ${claim.label}, not by your worktree; leaving it.`);
		}
		this.hub.setClaim(slot.id, null);
		return `Released ${slot.projectName}. It keeps serving ${slot.targetLabel}.`;
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
		if (slots.length === 0) return "Rojo-Hub has no projects. Ask the user to add one in the Rojo-Hub panel in VS Code.";
		const path = text(args.path);
		const root = path ? await worktreeRoot(path).catch(() => null) : null;
		const repo = root ? pathKey(await primaryCheckout(root).catch(() => root)) : null;
		const lines: string[] = [];
		for (const slot of slots) {
			const claim = this.hub.claimOf(slot.id);
			const serves = slot.target.kind === "worktree" ? `${slot.targetLabel}${slot.branch && slot.branch !== slot.targetLabel ? ` (branch ${slot.branch})` : ""} at ${slot.target.path}` : `branch ${slot.targetLabel} (read-only copy)`;
			lines.push(`${slot.projectName} (id ${slot.id}), port ${slot.port}: ${this.health(slot)}`, `  serves ${serves}`, `  repo ${slot.repoPath}`);
			if (claim) lines.push(`  claimed by an agent in ${claim.label} until ${time(claim.until)}`);
			if (repo && pathKey(slot.repoPath) === repo) {
				this.renew(slot, root);
				const mine = slot.target.kind === "worktree" && pathKey(slot.target.path) === pathKey(root!);
				lines.push(mine ? "  -> your worktree is the one being served" : "  -> your worktree is NOT being served; call serve_here to change that");
			}
		}
		return lines.join("\n");
	}

	private health(slot: SlotView): string {
		if (slot.state === "running") {
			return slot.connections > 0
				? `Rojo is serving on port ${slot.port} and Studio is connected (${slot.connections}).`
				: `Rojo is serving on port ${slot.port}, but no Studio is connected; the user connects the Rojo plugin to localhost:${slot.port}.`;
		}
		if (slot.state === "error") return `Rojo has an error: ${(slot.error ?? "").split("\n")[0]}`;
		if (slot.state === "starting") return "Rojo is starting.";
		return "Rojo is not serving this project, so Studio gets nothing; ask the user to start it in the Rojo-Hub panel.";
	}
}
