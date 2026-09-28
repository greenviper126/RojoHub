import { MCP_URL, type AgentId } from "./api";

/*
	How each agent's own CLI adds and removes Rojo-Hub's MCP server (spec 004).
	The service runs these, the uninstall hook runs `remove`, and the panel's
	Copy setup commands shows `add`, so they cannot drift apart.
*/

export const SERVER_NAME = "rojohub";

export const AGENT_CLIS: Record<AgentId, { label: string; cli: string; add: string[]; remove: string[] }> = {
	claudeCode: {
		label: "Claude Code",
		cli: "claude",
		add: ["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, MCP_URL],
		remove: ["mcp", "remove", SERVER_NAME, "--scope", "user"],
	},
	codex: {
		label: "Codex",
		cli: "codex",
		add: ["mcp", "add", SERVER_NAME, "--url", MCP_URL],
		remove: ["mcp", "remove", SERVER_NAME],
	},
};

export const SETUP_COMMANDS = `# Claude Code
${[AGENT_CLIS.claudeCode.cli, ...AGENT_CLIS.claudeCode.add].join(" ")}

# Codex
${[AGENT_CLIS.codex.cli, ...AGENT_CLIS.codex.add].join(" ")}

# Any other agent that reads a JSON MCP config
{ "mcpServers": { "${SERVER_NAME}": { "type": "http", "url": "${MCP_URL}" } } }
`;

export const SETUP_PROMPT = `Add an MCP server named "${SERVER_NAME}" to your user-level (global) configuration, not this project's: streamable HTTP transport at ${MCP_URL}, no authentication. It is Rojo-Hub, which serves my Roblox Rojo projects to Roblox Studio. Once it is added, call its serve_here tool with your working directory before checking changes in Studio.`;
