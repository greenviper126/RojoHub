import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SERVICE_PORT } from "../common/api";
import { Hub } from "./hub";
import { serve } from "./server";

/*
	Entry point of the background service. Started by the extension when nothing
	answers on the service port, or by hand with `npm run service`. It keeps
	running when VS Code windows close; the rojo processes it starts keep
	running even when it stops, and the next service adopts them.

	ROJO_HUB_HOME overrides the state folder and ROJO_HUB_PORT the API port,
	both for tests.
*/

const home = process.env.ROJO_HUB_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "RojoHub");
const port = Number(process.env.ROJO_HUB_PORT ?? SERVICE_PORT);
mkdirSync(home, { recursive: true });
const serviceLog = join(home, "service.log");

function log(message: string): void {
	appendFileSync(serviceLog, `${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
	const hub = new Hub(home);
	const server = await serve(hub, port, (stopServing) => {
		log(`shutdown requested (stopServing=${stopServing})`);
		void hub.shutdown(stopServing).finally(() => {
			server.close();
			process.exit(0);
		});
	});
	log(`service ${process.pid} listening on 127.0.0.1:${port}, home ${home}`);
	await hub.restore();
}

main().catch((error) => {
	log(`fatal: ${error instanceof Error ? error.stack : error}`);
	console.error(error);
	process.exit(1);
});
