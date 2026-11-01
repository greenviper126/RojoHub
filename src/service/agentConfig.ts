import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { AGENT_CLIS, SERVER_NAME, type Launch } from "../common/agents";
import { MCP_URL, type AgentId, type AgentStatus, type AgentWishes } from "../common/api";
import { hubHome, launcherDir, launcherScript } from "../common/launcher";
import { pathKey } from "../common/paths";

/*
	Adds Rojo-Hub's MCP server to Claude Code's and Codex's user config, and
	takes it out again (spec 004). Changes go through each agent's own CLI, the
	documented way; state is read from their config files, because the CLIs'
	own `get` health-checks every server and is far too slow to poll.

	The entry is the stdio launcher (spec 011). An old URL entry of Rojo-Hub's is
	rewritten to it, as is a launcher entry whose program is gone. An entry
	named rojohub of any other shape is the user's own and is never changed or
	removed. Also used by the uninstall hook (dist/uninstall.js).
*/

interface Agent {
	id: AgentId;
	label: string;
	cli: string;
	/** The agent's user-config entry named rojohub, or null when there is none. Throws when the file cannot be parsed. */
	readEntry(): Entry | null | undefined;
	add(launch: Launch): string[];
	remove: string[];
}

/** What an agent's config holds under rojohub: a URL, or a command with its arguments. */
export interface Entry {
	url?: string;
	command?: string;
	args?: string[];
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

function entryOf(servers: unknown): Entry | null {
	const entry = (servers as Record<string, { url?: unknown; command?: unknown; args?: unknown }> | undefined)?.[SERVER_NAME];
	if (!entry || typeof entry !== "object") return null;
	return {
		url: typeof entry.url === "string" ? entry.url : undefined,
		command: typeof entry.command === "string" ? entry.command : undefined,
		args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : undefined,
	};
}

/*
	Claude Code's user config: with CLAUDE_CONFIG_DIR set it keeps .claude.json
	there instead of in the home folder. Checked on every read, since a Claude
	Code run with the variable set may only just have made that file.
*/
function claudeConfigFile(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	if (dir) {
		const file = join(dir, ".claude.json");
		if (existsSync(file)) return file;
	}
	return join(homedir(), ".claude.json");
}

export const AGENTS: Agent[] = [
	{
		id: "claudeCode",
		...AGENT_CLIS.claudeCode,
		// User-scope servers are the top-level mcpServers of ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json).
		readEntry: () => entryOf((readCached(claudeConfigFile(), JSON.parse) as { mcpServers?: unknown } | undefined)?.mcpServers),
	},
	{
		id: "codex",
		...AGENT_CLIS.codex,
		readEntry: () =>
			entryOf((readCached(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), parseToml) as { mcp_servers?: unknown } | undefined)?.mcp_servers),
	},
];

/*
	"connected" (the launcher entry, its program and script present), "stale"
	(a launcher entry whose program or script is gone), "legacy" (the old URL
	entry), "absent", "other" (someone else's rojohub entry), or "unknown" when
	the config file exists but cannot be read or parsed, as when the agent is
	writing it at that moment. Unknown is never taken for absent: nothing is
	added, removed or reconciled on it.
*/
export function agentState(agent: Agent): AgentStatus["state"] {
	let entry: Entry | null | undefined;
	try {
		entry = agent.readEntry();
	} catch {
		return "unknown";
	}
	if (!entry) return "absent";
	if (entry.command !== undefined) {
		const script = entry.args?.[entry.args.length - 1];
		if (script === undefined || pathKey(script) !== pathKey(launcherScript(hubHome()))) return "other";
		const programGone = isAbsolute(entry.command) && !existsSync(entry.command);
		return programGone || !existsSync(script) ? "stale" : "connected";
	}
	return entry.url !== undefined && entry.url.replace(/\/+$/, "") === MCP_URL ? "legacy" : "other";
}

/** What the service writes: its own program run as Node, and the launcher it keeps current. */
export function currentLaunch(): Launch {
	return { command: process.execPath, script: launcherScript(hubHome()) };
}

/** Whether the entry is Rojo-Hub's own, in any of the shapes it has had. */
const ours = (state: AgentStatus["state"]): boolean => state === "connected" || state === "legacy" || state === "stale";

/*
	Runs an agent's CLI. npm installs them as .cmd shims on Windows, which only
	a shell can start; every argument here is a constant.
*/
export function runCli(cli: string, args: string[], timeout = 30000): Promise<void> {
	// A shell joins the arguments with spaces, so one with a space in it (Code.exe under "Microsoft VS Code") is quoted.
	const words = process.platform === "win32" ? args.map((arg) => (/[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg)) : args;
	return new Promise((done, fail) => {
		execFile(cli, words, { windowsHide: true, timeout, shell: process.platform === "win32", encoding: "utf8" }, (error, stdout, stderr) => {
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
	Agents whose entry was removed for a rewrite and could not be added back.
	Kept in the hub home, so the next reconcile adds it again instead of seeing
	an absent entry with no wish.
*/
const pendingFile = () => join(launcherDir(hubHome()), "pending-add.json");

function readPending(): AgentId[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(pendingFile(), "utf8"));
		return Array.isArray(parsed) ? parsed.filter((id): id is AgentId => AGENTS.some((agent) => agent.id === id)) : [];
	} catch {
		return [];
	}
}

function writePending(ids: AgentId[]): void {
	try {
		mkdirSync(launcherDir(hubHome()), { recursive: true });
		writeFileSync(pendingFile(), JSON.stringify(ids));
	} catch {
		// the marker is a safety net; the error is reported either way
	}
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

	/** `run` and `launch` are replaced by tests, so no real agent CLI is ever run by them. */
	constructor(
		private readonly run: (cli: string, args: string[]) => Promise<void> = runCli,
		private readonly launch: () => Launch = currentLaunch,
		private readonly onPathCheck: (cli: string) => Promise<boolean> = onPath,
	) {}

	private async detect(): Promise<void> {
		if (Date.now() - this.checkedAt < 60000) return;
		this.checkedAt = Date.now();
		const found = await Promise.all(AGENTS.map((agent) => this.onPathCheck(agent.cli)));
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

	/*
		Wishes from the setting (true adds, false removes, a missing one leaves
		the agent alone), and every old (legacy) or stale entry of Rojo-Hub's
		rewritten to the current launcher, unless the wish is to remove it.
	*/
	apply(wishes: AgentWishes): Promise<AgentStatus[]> {
		return this.queued(wishes);
	}

	/** The rewrite alone: at service start. Only entries that are Rojo-Hub's own and out of date are touched. */
	reconcile(): Promise<AgentStatus[]> {
		return this.queued({});
	}

	private queued(wishes: AgentWishes): Promise<AgentStatus[]> {
		const work = async () => {
			await this.detect();
			const pending = new Set(readPending());
			const setPending = (id: AgentId, on: boolean) => {
				if (pending.has(id) === on) return;
				if (on) pending.add(id);
				else pending.delete(id);
				writePending([...pending]);
			};
			for (const agent of AGENTS) {
				// An entry taken out for a rewrite whose add failed is added again, unless the wish is to have it gone.
				const wish = wishes[agent.id] ?? (pending.has(agent.id) && agentState(agent) === "absent" ? true : undefined);
				if (wishes[agent.id] === false) setPending(agent.id, false);
				const state = agentState(agent);
				const outdated = state === "legacy" || state === "stale";
				if (wish === undefined && !outdated) continue;
				if (!this.installed.get(agent.id)) {
					// Its CLI is gone, so the entry cannot be taken out the documented way; say so instead of doing nothing.
					if (wish === false && ours(state)) this.errors.set(agent.id, `${agent.cli} is not on PATH, so Rojo-Hub cannot take its rojohub entry out. Remove it from ${agent.label}'s config by hand.`);
					continue;
				}
				try {
					if (wish === true && state === "absent") await this.run(agent.cli, agent.add(this.launch()));
					else if (wish === false && ours(state)) await this.run(agent.cli, agent.remove);
					else if (outdated) {
						// Remove, then add: both CLIs refuse to add a name that exists.
						await this.run(agent.cli, agent.remove);
						try {
							await this.run(agent.cli, agent.add(this.launch()));
						} catch {
							try {
								await this.run(agent.cli, agent.add(this.launch()));
							} catch (error) {
								// Removed but not added: remember it, so the next reconcile adds it again.
								setPending(agent.id, true);
								throw error;
							}
						}
					} else continue;
					setPending(agent.id, false);
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
