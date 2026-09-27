import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { SERVICE_VERSION, type Health, type Target } from "../common/api";
import { Groups } from "./groups";
import type { Hub } from "./hub";
import { Conflict, NotFound } from "./registry";

/*
	The service's HTTP API, bound to 127.0.0.1 only. JSON in, JSON out.

	GET    /health
	GET    /slots
	POST   /slots                 { path, projectFile? }
	DELETE /slots/:id
	POST   /slots/:id/start
	POST   /slots/:id/stop
	GET    /slots/:id/targets
	POST   /slots/:id/switch      { target }
	GET    /groups
	POST   /groups                { name, slotIds?, groupIds? }
	PUT    /groups/:id            { name?, slotIds?, groupIds? }   groupIds that would loop are refused (409)
	DELETE /groups/:id
	POST   /groups/:id/start      { only? }   only: also stop every project outside the group
	POST   /groups/:id/stop
	PUT    /settings              { portRange?, excludedPorts? }
	POST   /shutdown              { stopServing? }
*/

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

export function serve(hub: Hub, port: number, onShutdown: (stopServing: boolean) => void) {
	const groups = new Groups(hub);
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			const method = request.method ?? "GET";

			if (method === "GET" && url.pathname === "/health") {
				const health: Health = { ok: true, version: SERVICE_VERSION, pid: process.pid, home: hub.home };
				return send(response, 200, health);
			}
			if (method === "PUT" && url.pathname === "/settings") {
				const input = await body(request);
				const excludedPorts = Array.isArray(input.excludedPorts) ? (input.excludedPorts as (number | string)[]) : [];
				hub.setPortSettings({ portRange: typeof input.portRange === "string" ? input.portRange : "", excludedPorts });
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
					const projectFile = typeof input.projectFile === "string" ? input.projectFile : undefined;
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
				if (method === "POST" && action === "start") return send(response, 200, await hub.start(id));
				if (method === "POST" && action === "stop") return send(response, 200, await hub.stop(id));
				if (method === "GET" && action === "targets") return send(response, 200, await hub.targets(id));
				if (method === "POST" && action === "switch") {
					const input = await body(request);
					if (!isTarget(input.target)) return send(response, 400, { error: "target must be {kind:'worktree',path} or {kind:'branch',ref}" });
					return send(response, 200, await hub.switch(id, input.target));
				}
			}
			send(response, 404, { error: `No route for ${method} ${url.pathname}` });
		} catch (error) {
			const status = error instanceof NotFound ? 404 : error instanceof Conflict ? 409 : 500;
			send(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	return new Promise<typeof server>((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", () => done(server));
	});
}
