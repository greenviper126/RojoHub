import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { AGENT_CLIS, SERVER_NAME } from "../common/agents";
import { MCP_URL, type AgentId, type AgentStatus, type AgentWishes } from "../common/api";

/*
	Adds Rojo-Hub's MCP server to Claude Code's and Codex's user config, and
	takes it out again (spec 004). Changes go through each agent's own CLI, the
	documented way; state is read from their config files, because the CLIs'
	own `get` health-checks every server and is far too slow to poll.

	An entry named rojohub with another URL is the user's own and is never
	changed or removed. Also used by the uninstall hook (dist/uninstall.js).
*/

interface Agent {
	id: AgentId;
	label: string;
	cli: string;
	/** The URL of the agent's user-config entry named rojohub ("" when it has none), or null when there is no such entry. Throws when the file cannot be parsed. */
	readUrl(): string | null | undefined;
	add: string[];
	remove: string[];
}

/*
	Parsed config files by path, reused while their size and time are unchanged:
	~/.claude.json is tens of kilobytes and the panel asks every two seconds.
*/
const cache = new Map<string, { stamp: string; value: unknown }>();

function readCached(file: string, parse: (text: string) => unknown): unknown {
	let stamp: string;
	try {
		const info = statSync(file);
		stamp = `${info.size}:${info.mtimeMs}`;
	} catch {
		return undefined;
	}
	const hit = cache.get(file);
	if (hit?.stamp === stamp) return hit.value;
	const value = parse(readFileSync(file, "utf8"));
	cache.set(file, { stamp, value });
	return value;
}

function entryUrl(servers: unknown): string | null {
	const entry = (servers as Record<string, { url?: unknown }> | undefined)?.[SERVER_NAME];
	if (!entry) return null;
	return typeof entry.url === "string" ? entry.url : "";
}

export const AGENTS: Agent[] = [
	{
		id: "claudeCode",
		...AGENT_CLIS.claudeCode,
		// User-scope servers are the top-level mcpServers of ~/.claude.json.
		readUrl: () => entryUrl((readCached(join(homedir(), ".claude.json"), JSON.parse) as { mcpServers?: unknown } | undefined)?.mcpServers),
	},
	{
		id: "codex",
		...AGENT_CLIS.codex,
		readUrl: () =>
			entryUrl((readCached(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), parseToml) as { mcp_servers?: unknown } | undefined)?.mcp_servers),
	},
];

/** "connected", "absent" or "other" (someone else's rojohub entry). */
export function agentState(agent: Agent): AgentStatus["state"] {
	let url: string | null | undefined;
	try {
		url = agent.readUrl();
	} catch {
		return "absent";
	}
	if (url === null || url === undefined) return "absent";
	return url.replace(/\/+$/, "") === MCP_URL ? "connected" : "other";
}

/*
	Runs an agent's CLI. npm installs them as .cmd shims on Windows, which only
	a shell can start; every argument here is a constant.
*/
export function runCli(cli: string, args: string[], timeout = 30000): Promise<void> {
	return new Promise((done, fail) => {
		execFile(cli, args, { windowsHide: true, timeout, shell: process.platform === "win32", encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) fail(new Error(`${cli} ${args.slice(0, 2).join(" ")}: ${(stderr || stdout || error.message).trim().split(/\r?\n/)[0]}`));
			else done();
		});
	});
}

function onPath(cli: string): Promise<boolean> {
	return new Promise((done) => {
		execFile(process.platform === "win32" ? "where" : "which", [cli], { windowsHide: true, timeout: 5000 }, (error) => done(!error));
	});
}

/*
	The service's registrar: status for the panel, and wishes from VS Code's
	setting applied one at a time, so windows that send them at once never run
	two CLIs against the same config file.
*/
export class AgentRegistrar {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly errors = new Map<AgentId, string>();
	private installed = new Map<AgentId, boolean>();
	private checkedAt = 0;

	private async detect(): Promise<void> {
		if (Date.now() - this.checkedAt < 60000) return;
		this.checkedAt = Date.now();
		const found = await Promise.all(AGENTS.map((agent) => onPath(agent.cli)));
		this.installed = new Map(AGENTS.map((agent, index) => [agent.id, found[index]]));
	}

	async status(): Promise<AgentStatus[]> {
		await this.detect();
		return AGENTS.map((agent) => ({
			id: agent.id,
			label: agent.label,
			installed: this.installed.get(agent.id) ?? false,
			state: agentState(agent),
			error: this.errors.get(agent.id) ?? null,
		}));
	}

	apply(wishes: AgentWishes): Promise<AgentStatus[]> {
		const work = async () => {
			await this.detect();
			for (const agent of AGENTS) {
				const wish = wishes[agent.id];
				if (wish === undefined || !this.installed.get(agent.id)) continue;
				const state = agentState(agent);
				try {
					if (wish && state === "absent") await runCli(agent.cli, agent.add);
					else if (!wish && state === "connected") await runCli(agent.cli, agent.remove);
					else continue;
					this.errors.delete(agent.id);
				} catch (error) {
					this.errors.set(agent.id, error instanceof Error ? error.message : String(error));
				}
			}
			return this.status();
		};
		const next = this.queue.then(work, work);
		this.queue = next.catch(() => undefined);
		return next;
	}
}
