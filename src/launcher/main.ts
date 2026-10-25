import { spawn } from "node:child_process";

import { SERVICE_PORT } from "../common/api";
import { cacheFile, findService, hubHome } from "../common/launcher";
import { LineBuffer, Proxy } from "./proxy";

/*
	Entry point of the stdio launcher (dist/mcp-stdio.js, copied by the service to
	<hub home>/launcher/rojohub-mcp.cjs). Agents' configs run it with VS Code's own
	program as Node. Spec 011, section 1; the work is in proxy.ts.

	ROJO_HUB_HOME and ROJO_HUB_PORT are honoured as the service honours them, and
	ROJO_HUB_SERVICE names the service script to start (tests).
*/

const home = hubHome();
const port = Number(process.env.ROJO_HUB_PORT ?? SERVICE_PORT);

function startService(): boolean {
	const found = findService(home);
	if (!found) return false;
	// The same way the extension starts it: this program as Node, detached so it outlives the session, with no window.
	const child = spawn(process.execPath, [found.script], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	child.on("error", () => undefined);
	child.unref();
	return true;
}

const proxy = new Proxy({
	port,
	home,
	cachePath: cacheFile(home),
	startService,
	write: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
});

const lines = new LineBuffer();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	for (const line of lines.push(chunk)) void proxy.handleLine(line);
});
// The agent went away: finish what is in flight, then end. The service is never stopped.
process.stdin.on("end", () => {
	const rest = lines.rest();
	if (rest.trim()) void proxy.handleLine(rest);
	void proxy.idle().then(() => process.exit(0));
});
process.stdout.on("error", () => process.exit(0));
