import { MCP_URL, type AgentId } from "./api";

/*
	How each agent's own CLI adds and removes Rojo-Hub's MCP server (spec 004,
	011). The service runs these, the uninstall hook runs `remove`, and the
	panel's Copy setup commands shows `add`, so they cannot drift apart.

	The entry is the stdio launcher (spec 011): the editor's own program run as
	Node, with the launcher script. It starts the service when nothing answers,
	which a URL entry cannot.
*/

export const SERVER_NAME = "rojohub";

/** What the agent runs: a program (VS Code's, run as Node) and the launcher script it is given. */
export interface Launch {
	command: string;
	script: string;
}

export const LAUNCHER_ENV = "ELECTRON_RUN_AS_NODE=1";

export const AGENT_CLIS: Record<AgentId, { label: string; cli: string; add: (launch: Launch) => string[]; addUrl: string[]; remove: string[] }> = {
	claudeCode: {
		label: "Claude Code",
		cli: "claude",
		// -e takes any number of values, so the options that follow it end it and the name comes after them (measured: with the name right after -e, claude reads it as an environment value).
		add: (launch) => ["mcp", "add", "--transport", "stdio", "-e", LAUNCHER_ENV, "--scope", "user", SERVER_NAME, "--", launch.command, launch.script],
		addUrl: ["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, MCP_URL],
		remove: ["mcp", "remove", SERVER_NAME, "--scope", "user"],
	},
	codex: {
		label: "Codex",
		cli: "codex",
		add: (launch) => ["mcp", "add", SERVER_NAME, "--env", LAUNCHER_ENV, "--", launch.command, launch.script],
		addUrl: ["mcp", "add", SERVER_NAME, "--url", MCP_URL],
		remove: ["mcp", "remove", SERVER_NAME],
	},
};

/** A shell word: quoted when it holds a space or a character the shell reads. */
function word(text: string): string {
	return /[\s&|<>^()"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export const commandLine = (cli: string, args: string[]): string => [cli, ...args.map(word)].join(" ");

export function setupCommands(launch: Launch): string {
	return `# Claude Code (starts Rojo-Hub's service itself when it is not running)
${commandLine(AGENT_CLIS.claudeCode.cli, AGENT_CLIS.claudeCode.add(launch))}

# Codex
${commandLine(AGENT_CLIS.codex.cli, AGENT_CLIS.codex.add(launch))}

# Any other agent that reads a JSON MCP config
{ "mcpServers": { "${SERVER_NAME}": { "command": ${JSON.stringify(launch.command)}, "args": [${JSON.stringify(launch.script)}], "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }

# Or, for an agent that only takes a URL (it needs the service to be running already)
${commandLine(AGENT_CLIS.claudeCode.cli, AGENT_CLIS.claudeCode.addUrl)}
${commandLine(AGENT_CLIS.codex.cli, AGENT_CLIS.codex.addUrl)}
{ "mcpServers": { "${SERVER_NAME}": { "type": "http", "url": "${MCP_URL}" } } }
`;
}

export function setupPrompt(launch: Launch): string {
	return `Add an MCP server named "${SERVER_NAME}" to your user-level (global) configuration, not this project's: stdio transport, command ${JSON.stringify(launch.command)}, arguments [${JSON.stringify(launch.script)}], environment variable ELECTRON_RUN_AS_NODE=1. It is Rojo-Hub, which serves my Roblox Rojo projects to Roblox Studio, and that command starts its background service when it is not running. If you can only add a URL, use streamable HTTP at ${MCP_URL} instead, with no authentication. Once it is added, call its serve_here tool with your working directory before checking changes in Studio.`;
}
