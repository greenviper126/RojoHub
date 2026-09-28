import { homedir } from "node:os";
import { join } from "node:path";

import { SERVICE_PORT, type Health } from "../common/api";
import { pathKey } from "../common/paths";
import { AGENTS, agentState, runCli } from "../service/agentConfig";

/*
	package.json's vscode:uninstall hook. VS Code runs it with its own Node, and
	no vscode API, once the extension is gone from every profile and VS Code has
	started again (measured in spec 004). It takes Rojo-Hub's MCP server out of
	Claude Code's and Codex's user config, but only an entry that points at
	Rojo-Hub: one the user made with another URL stays. Then it stops the
	service and every rojo it serves, which would otherwise run on with nothing
	left to manage them.
*/

const homeKey = pathKey;

/*
	Port 34870 is machine-wide: another signed-in Windows user's service can be
	the one answering. Only a service whose home is this user's is shut down.
	ROJO_HUB_PORT and ROJO_HUB_HOME are honoured as the service honours them, so
	the smoke test can point this at a port nothing listens on.
*/
async function stopService(): Promise<void> {
	const base = `http://127.0.0.1:${Number(process.env.ROJO_HUB_PORT ?? SERVICE_PORT)}`;
	const home = process.env.ROJO_HUB_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "RojoHub");
	try {
		const health = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).json()) as Partial<Health>;
		if (typeof health.home !== "string" || homeKey(health.home) !== homeKey(home)) return;
		await fetch(`${base}/shutdown`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stopServing: true }),
			signal: AbortSignal.timeout(10000),
		});
	} catch {
		// Not running, or not answering: nothing to stop.
	}
}

async function main(): Promise<void> {
	for (const agent of AGENTS) {
		if (agentState(agent) !== "connected") continue;
		await runCli(agent.cli, agent.remove).catch(() => undefined);
	}
	await stopService();
}

void main();
