import { AGENTS, agentState, runCli } from "../service/agentConfig";

/*
	package.json's vscode:uninstall hook. VS Code runs it with its own Node, and
	no vscode API, once the extension is gone from every profile and VS Code has
	started again (measured in spec 004). It takes Rojo-Hub's MCP server out of
	Claude Code's and Codex's user config, but only an entry that points at
	Rojo-Hub: one the user made with another URL stays.
*/
async function main(): Promise<void> {
	for (const agent of AGENTS) {
		if (agentState(agent) !== "connected") continue;
		await runCli(agent.cli, agent.remove).catch(() => undefined);
	}
}

void main();
