import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SERVICE_PORT } from "../common/api";
import { gitProblem } from "./git";
import { Hub } from "./hub";
import { eventSubscribers, serve } from "./server";

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

/*
	How long the service stays up with nothing to do: no project serving or
	meant to serve, no window subscribed to its events, and no request from any
	window or agent. It then exits, so
	it does not keep VS Code's program (Code.exe, which it runs on) in use for
	nothing, which can get in the way of a VS Code update. The next window or
	panel refresh starts it again.
*/
const IDLE_EXIT_MS = 15 * 60_000;

function log(message: string): void {
	try {
		appendFileSync(serviceLog, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// the log is for people; never let it stop the service
	}
}

/*
	The last line of defence. The service owns every project's rojo, so dying
	on one unexpected error (a file watcher failing, a race while a folder is
	deleted) would leave crashed rojos unrestarted and every window without a
	service. It is logged and the service carries on; each slot's own state is
	kept consistent by its queue.
*/
process.on("uncaughtException", (error) => log(`uncaught: ${error instanceof Error ? error.stack : error}`));
process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`));

async function main(): Promise<void> {
	const hub = new Hub(home);
	if (hub.registry.recovered) log(hub.registry.recovered);
	let exiting = false;
	const exit = (stopServing: boolean) => {
		if (exiting) return;
		exiting = true;
		void hub.shutdown(stopServing).finally(() => {
			server.close();
			process.exit(0);
		});
	};
	const server = await serve(hub, port, (stopServing) => {
		log(`shutdown requested (stopServing=${stopServing})`);
		exit(stopServing);
	});
	let lastRequest = Date.now();
	server.on("request", () => (lastRequest = Date.now()));
	setInterval(() => {
		if (Date.now() - lastRequest < IDLE_EXIT_MS || eventSubscribers() > 0 || !hub.idle()) return;
		log("exiting: idle, nothing serving");
		exit(false);
	}, 60_000).unref();
	log(`service ${process.pid} listening on 127.0.0.1:${port}, home ${home}`);
	const problem = await gitProblem();
	if (problem) log(problem);
	await hub.restore();
}

main().catch((error: NodeJS.ErrnoException) => {
	/*
		Two windows that open at the same moment can both start a service; the
		second finds the port taken by the first, which is what both wanted.
	*/
	if (error?.code === "EADDRINUSE") {
		log(`service ${process.pid} not started: port ${port} is already in use (another service started first)`);
		process.exit(0);
	}
	log(`fatal: ${error instanceof Error ? error.stack : error}`);
	console.error(error);
	process.exit(1);
});
