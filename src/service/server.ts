import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { SERVICE_VERSION, STUDIO_PATH, type AgentId, type AgentWishes, type Health, type Snapshot, type Target } from "../common/api";
import { isProjectFileName } from "../common/projectFiles";
import { AGENTS, AgentRegistrar } from "./agentConfig";
import { Groups } from "./groups";
import type { Hub } from "./hub";
import { Mcp } from "./mcp";
import { Conflict, NotFound } from "./registry";
import { acceptWebSocket } from "./websocket";

/*
	The service's HTTP API, bound to 127.0.0.1 only. JSON in, JSON out.

	GET    /health
	GET    /events                                   a stream (text/event-stream) of the panel's whole Snapshot, sent on every change
	GET    /slots
	POST   /slots                 { path, projectFile? }
	PUT    /slots/:id/project-file { projectFile }    serve another *.project.json (restarts a serving rojo)
	DELETE /slots/:id
	POST   /slots/:id/start
	POST   /slots/:id/stop
	GET    /slots/:id/targets                        the branch picker's list, from the service's cache
	POST   /slots/:id/fetch                          git fetch --all --prune, then the fresh list
	POST   /slots/:id/branch      { name, base }     a new branch in its own worktree, and switch to it
	POST   /slots/:id/build       { output }         rojo build of what the slot serves
	POST   /slots/:id/sourcemap                      write the served worktree's sourcemap.json once
	POST   /slots/:id/switch      { target }             a user's switch, which also clears an agent's claim
	GET    /groups
	POST   /groups                { name, slotIds?, groupIds? }
	PUT    /groups/:id            { name?, slotIds?, groupIds? }   groupIds that would loop are refused (409)
	DELETE /groups/:id
	POST   /groups/:id/start      { only? }   only: also stop every project outside the group
	POST   /groups/:id/stop
	GET    /order                                    the panel's display order
	PUT    /order                 { projects?, groups? }   (never changes ports)
	POST   /stop-all                                 stop every serving project, mark every group stopped
	PUT    /settings              { portRange?, excludedPorts?, sourcemaps? }
	POST   /shutdown              { stopServing? }
	GET    /agents                                   Claude Code's and Codex's MCP registration (spec 004)
	PUT    /agents                { claudeCode?, codex? }   true adds Rojo-Hub to that agent's config, false takes it out
	POST   /mcp                                      the Model Context Protocol, for agents (src/service/mcp.ts)
	GET    /studio                                   WebSocket for the Studio plugin (spec 007, src/service/studio.ts)
	PUT    /studio/places/:key    { slotId }         assign a project to an open Studio place (null: back to its project files)

	Only programs on this machine may use it, never a web page:
	- Host must name the loopback address and this port. A DNS-rebinding page
	  (attacker.example resolving to 127.0.0.1) sends its own name as Host, so it
	  cannot even read.
	- A browser Origin (http, https, or "null" from a file or sandboxed page) is
	  refused, localhost pages included: a local dev server's page must not drive
	  it either. The extension, the uninstall hook and agents' MCP clients send
	  no Origin; VS Code's own windows send vscode-file://, which is allowed.
*/

export function allowedRequest(request: IncomingMessage, port: number): boolean {
	const host = (request.headers.host ?? "").toLowerCase();
	if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false;
	const origin = request.headers.origin;
	return origin === undefined || /^vscode-[a-z-]+:\/\//i.test(origin);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(payload));
}

function isTarget(value: unknown): value is Target {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	return (target.kind === "worktree" && typeof target.path === "string") || (target.kind === "branch" && typeof target.ref === "string");
}

function isIdList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/*
	How often the snapshot is compared with the last one sent. A change reaches
	every window within this, whatever made it: a click in another window, an
	agent, a crash, a checkout, Studio connecting. Nothing is sent when nothing
	changed, so an idle panel costs one JSON.stringify per tick.
*/
const EVENT_TICK_MS = 150;
/** A comment line now and then, so a window whose connection died unnoticed gets an error and reconnects. */
const HEARTBEAT_MS = 15000;

/** Windows subscribed to GET /events; while any is, the service is not idle. */
const subscribers = new Set<ServerResponse>();
export const eventSubscribers = (): number => subscribers.size;

export function serve(hub: Hub, port: number, onShutdown: (stopServing: boolean) => void) {
	const groups = new Groups(hub);
	const mcp = new Mcp(hub, groups);
	const agents = new AgentRegistrar();

	let lastSent = "";
	const snapshot = (): string => JSON.stringify({ slots: hub.snapshot(), groups: groups.list(), order: hub.registry.order, studioPlugin: hub.studioPlugin, studioPlaces: hub.studio.places() } satisfies Snapshot);
	const publish = (force = false): void => {
		if (subscribers.size === 0) return;
		let now: string;
		try {
			now = snapshot();
		} catch {
			return;
		}
		if (now === lastSent && !force) return;
		lastSent = now;
		for (const subscriber of subscribers) subscriber.write(`data: ${now}\n\n`);
	};
	setInterval(publish, EVENT_TICK_MS).unref();
	setInterval(() => {
		for (const subscriber of subscribers) subscriber.write(": keep-alive\n\n");
	}, HEARTBEAT_MS).unref();

	const server = createServer(async (request, response) => {
		// After anything that may have changed state, tell every window at once instead of on the next tick.
		if (request.method !== "GET") response.once("finish", () => publish());
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			const method = request.method ?? "GET";

			if (!allowedRequest(request, port)) return send(response, 403, { error: "Only programs on this machine may use Rojo-Hub's service; requests from web pages are refused" });
			if (url.pathname === "/mcp") {
				if (method !== "POST") {
					response.writeHead(405, { allow: "POST" });
					return response.end();
				}
				const answer = await mcp.handle(await body(request).catch(() => null));
				if (!answer) {
					response.writeHead(202);
					return response.end();
				}
				return send(response, 200, answer);
			}
			if (url.pathname === "/agents") {
				if (method === "GET") return send(response, 200, await agents.status());
				if (method === "PUT") {
					const input = await body(request);
					const wishes: AgentWishes = {};
					for (const agent of AGENTS) {
						const wish = input[agent.id as AgentId];
						if (typeof wish === "boolean") wishes[agent.id] = wish;
					}
					return send(response, 200, await agents.apply(wishes));
				}
			}

			if (method === "GET" && url.pathname === "/events") {
				// Built before the headers go out, so a failure is still an ordinary error answer.
				const first = snapshot();
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				response.write(`data: ${first}\n\n`);
				subscribers.add(response);
				request.socket.setKeepAlive(true);
				response.on("close", () => subscribers.delete(response));
				return;
			}
			if (method === "GET" && url.pathname === "/health") {
				const health: Health = { ok: true, version: SERVICE_VERSION, pid: process.pid, home: hub.home };
				return send(response, 200, health);
			}
			if (url.pathname === "/order") {
				if (method === "GET") return send(response, 200, hub.registry.order);
				if (method === "PUT") {
					const input = await body(request);
					if ((input.projects !== undefined && !isIdList(input.projects)) || (input.groups !== undefined && !isIdList(input.groups))) {
						return send(response, 400, { error: "projects and groups must be lists of ids" });
					}
					hub.registry.order = {
						projects: (input.projects as string[] | undefined) ?? hub.registry.order.projects,
						groups: (input.groups as string[] | undefined) ?? hub.registry.order.groups,
					};
					hub.registry.save();
					return send(response, 200, hub.registry.order);
				}
			}
			if (method === "PUT" && parts[0] === "studio" && parts[1] === "places" && parts.length === 3) {
				const input = await body(request);
				if (input.slotId !== null && typeof input.slotId !== "string") return send(response, 400, { error: "slotId must be a project id or null" });
				if (typeof input.slotId === "string") hub.registry.get(input.slotId);
				hub.studio.assign(parts[2], input.slotId as string | null);
				return send(response, 200, hub.studio.places());
			}
			if (method === "POST" && url.pathname === "/stop-all") return send(response, 200, await groups.stopAll());
			if (method === "PUT" && url.pathname === "/settings") {
				const input = await body(request);
				const excludedPorts = Array.isArray(input.excludedPorts) ? (input.excludedPorts as (number | string)[]) : [];
				hub.setPortSettings({
					portRange: typeof input.portRange === "string" ? input.portRange : "",
					excludedPorts,
					sourcemaps: input.sourcemaps !== false,
					studioPlugin: input.studioPlugin !== false,
				});
				return send(response, 200, { ok: true });
			}
			if (method === "POST" && url.pathname === "/shutdown") {
				const input = await body(request);
				send(response, 200, { ok: true });
				return onShutdown(input.stopServing === true);
			}
			if (parts[0] === "groups" && parts.length === 1) {
				if (method === "GET") return send(response, 200, groups.list());
				if (method === "POST") {
					const input = await body(request);
					if (typeof input.name !== "string") return send(response, 400, { error: "name is required" });
					if ((input.slotIds !== undefined && !isIdList(input.slotIds)) || (input.groupIds !== undefined && !isIdList(input.groupIds))) {
						return send(response, 400, { error: "slotIds and groupIds must be lists of ids" });
					}
					return send(response, 200, groups.create(input.name, (input.slotIds as string[]) ?? [], (input.groupIds as string[]) ?? []));
				}
			}
			if (parts[0] === "groups" && parts.length >= 2) {
				const id = parts[1];
				const action = parts[2];
				if (method === "PUT" && !action) {
					const input = await body(request);
					if ((input.slotIds !== undefined && !isIdList(input.slotIds)) || (input.groupIds !== undefined && !isIdList(input.groupIds))) {
						return send(response, 400, { error: "slotIds and groupIds must be lists of ids" });
					}
					return send(
						response,
						200,
						groups.update(id, {
							name: typeof input.name === "string" ? input.name : undefined,
							slotIds: input.slotIds as string[] | undefined,
							groupIds: input.groupIds as string[] | undefined,
						}),
					);
				}
				if (method === "DELETE" && !action) {
					groups.remove(id);
					return send(response, 200, { ok: true });
				}
				if (method === "POST" && action === "start") {
					const input = await body(request);
					return send(response, 200, await groups.start(id, input.only === true));
				}
				if (method === "POST" && action === "stop") return send(response, 200, await groups.stop(id));
			}
			if (parts[0] === "slots" && parts.length === 1) {
				if (method === "GET") return send(response, 200, hub.list());
				if (method === "POST") {
					const input = await body(request);
					if (typeof input.path !== "string") return send(response, 400, { error: "path is required" });
					if (input.projectFile !== undefined && !isProjectFileName(input.projectFile)) return send(response, 400, { error: "projectFile must be a *.project.json file name" });
					const projectFile = input.projectFile as string | undefined;
					return send(response, 200, await hub.add(input.path, projectFile));
				}
			}
			if (parts[0] === "slots" && parts.length >= 2) {
				const id = parts[1];
				const action = parts[2];
				if (method === "DELETE" && !action) {
					await hub.remove(id);
					return send(response, 200, { ok: true });
				}
				if (method === "GET" && action === "port-moves-on-remove") return send(response, 200, hub.portMovesOnRemove(id));
				if (method === "POST" && action === "start") return send(response, 200, await hub.start(id));
				if (method === "POST" && action === "stop") return send(response, 200, await hub.stop(id));
				if (method === "GET" && action === "targets") return send(response, 200, await hub.targets(id));
				if (method === "POST" && action === "fetch") return send(response, 200, await hub.fetch(id));
				if (method === "POST" && action === "branch") {
					const input = await body(request);
					if (typeof input.name !== "string" || typeof input.base !== "string") return send(response, 400, { error: "name and base are required" });
					// Making a branch from the picker is the user's switch too, so it clears an agent's claim like one.
					const made = await hub.createBranch(id, input.name, input.base);
					hub.setClaim(id, null);
					return send(response, 200, { ...made, slot: { ...made.slot, claim: null } });
				}
				if (method === "POST" && action === "sourcemap") return send(response, 200, await hub.writeSourcemap(id));
				if (method === "PUT" && action === "project-file") {
					const input = await body(request);
					if (!isProjectFileName(input.projectFile)) return send(response, 400, { error: "projectFile must be a *.project.json file name" });
					return send(response, 200, await hub.setProjectFile(id, input.projectFile));
				}
				if (method === "POST" && action === "build") {
					const input = await body(request);
					if (typeof input.output !== "string") return send(response, 400, { error: "output is required" });
					return send(response, 200, await hub.build(id, input.output));
				}
				if (method === "POST" && action === "switch") {
					const input = await body(request);
					if (!isTarget(input.target)) return send(response, 400, { error: "target must be {kind:'worktree',path} or {kind:'branch',ref}" });
					const switched = await hub.switch(id, input.target);
					hub.setClaim(id, null);
					return send(response, 200, { ...switched, claim: null });
				}
			}
			send(response, 404, { error: `No route for ${method} ${url.pathname}` });
		} catch (error) {
			const status = error instanceof NotFound ? 404 : error instanceof Conflict ? 409 : 500;
			send(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	/*
		The Studio plugin's WebSocket (spec 007). Same rule as every other request:
		a web page may open a WebSocket to 127.0.0.1 too, but it must send its
		Origin, and that is refused. Studio sends none (measured, spec 007).
	*/
	server.on("upgrade", (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path !== STUDIO_PATH || !allowedRequest(request, port)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const link = acceptWebSocket(request, socket, head);
		if (link) hub.studio.attach(link);
	});
	return new Promise<typeof server>((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", () => done(server));
	});
}
