import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { compareVersions } from "../common/version";
import { SERVICE_PORT, SERVICE_VERSION, type AgentStatus, type AgentWishes, type BranchResult, type DisplayOrder, type GroupResult, type GroupView, type Health, type PortMove, type PortSettings, type SlotView, type Target, type TargetOption } from "../common/api";

/*
	The extension's side of the service API, and starting the service when
	nothing answers. The service is spawned with VS Code's own runtime
	(ELECTRON_RUN_AS_NODE) so it needs no Node install, and detached so it
	outlives this window.
*/

const base = `http://127.0.0.1:${SERVICE_PORT}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(base + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(method === "GET" ? 5000 : 120000),
	});
	const payload = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error ?? `${method} ${path} failed with ${response.status}`);
	return payload;
}

async function anyHealth(): Promise<Health | null> {
	try {
		const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1500) });
		return response.ok ? ((await response.json()) as Health) : null;
	} catch {
		return null;
	}
}

/** The service's state folder for this Windows user, worked out exactly as src/service/main.ts does. */
export function expectedHome(): string {
	return process.env.ROJO_HUB_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "RojoHub");
}

const homeKey = (path: string) => resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/*
	Port 34870 is machine-wide, so with two Windows users signed in, the other
	user's service can be the one answering. Its /health names its home, which
	is under that user's profile; a service with another home is never used or
	shut down.
*/
function ours(current: Health): boolean {
	return !current.home || homeKey(current.home) === homeKey(expectedHome());
}

function otherUserError(current: Health): Error {
	return new Error(`Port ${SERVICE_PORT} is used by another Windows user's Rojo-Hub (${current.home}). Only one signed-in user can run Rojo-Hub at a time.`);
}

/** This user's service's health, or null when nothing (or another user's service) answers. */
async function health(): Promise<Health | null> {
	const current = await anyHealth();
	return current && ours(current) ? current : null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/*
	Makes sure a service at least as new as this extension is running. An older
	one (left from before an update) is asked to exit, leaving its rojo
	processes serving for the new one to adopt. A newer one is kept: every
	VS Code window runs its own copy of the extension, and a window that has
	not been reloaded since an update must not put the old service back.
*/
export async function ensureService(serviceScript: string): Promise<Health> {
	let current = await anyHealth();
	if (current && !ours(current)) throw otherUserError(current);
	if (current && compareVersions(current.version, SERVICE_VERSION) >= 0) return current;
	if (current) {
		await call("POST", "/shutdown", { stopServing: false }).catch(() => undefined);
		for (let i = 0; i < 40 && (await anyHealth()); i++) await sleep(100);
	}
	const child = spawn(process.execPath, [serviceScript], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	child.unref();
	for (let i = 0; i < 100; i++) {
		current = await anyHealth();
		if (current && !ours(current)) throw otherUserError(current);
		if (current) return current;
		await sleep(100);
	}
	throw new Error("The Rojo-Hub service did not start. See service.log in %LOCALAPPDATA%\\RojoHub.");
}

export const client = {
	health,
	slots: () => call<SlotView[]>("GET", "/slots"),
	add: (path: string, projectFile?: string) => call<SlotView>("POST", "/slots", { path, projectFile }),
	setProjectFile: (id: string, projectFile: string) => call<SlotView>("PUT", `/slots/${encodeURIComponent(id)}/project-file`, { projectFile }),
	remove: (id: string) => call<{ ok: true }>("DELETE", `/slots/${encodeURIComponent(id)}`),
	portMovesOnRemove: (id: string) => call<PortMove[]>("GET", `/slots/${encodeURIComponent(id)}/port-moves-on-remove`),
	start: (id: string) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/start`),
	stop: (id: string) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/stop`),
	targets: (id: string) => call<TargetOption[]>("GET", `/slots/${encodeURIComponent(id)}/targets`),
	fetch: (id: string) => call<TargetOption[]>("POST", `/slots/${encodeURIComponent(id)}/fetch`),
	createBranch: (id: string, name: string, base: string) => call<BranchResult>("POST", `/slots/${encodeURIComponent(id)}/branch`, { name, base }),
	sourcemap: (id: string) => call<{ path: string }>("POST", `/slots/${encodeURIComponent(id)}/sourcemap`),
	build: (id: string, output: string) => call<{ output: string; bytes: number }>("POST", `/slots/${encodeURIComponent(id)}/build`, { output }),
	switch: (id: string, target: Target) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/switch`, { target }),
	groups: () => call<GroupView[]>("GET", "/groups"),
	createGroup: (name: string, slotIds: string[]) => call<GroupView>("POST", "/groups", { name, slotIds }),
	updateGroup: (id: string, changes: { name?: string; slotIds?: string[]; groupIds?: string[] }) => call<GroupView>("PUT", `/groups/${encodeURIComponent(id)}`, changes),
	deleteGroup: (id: string) => call<{ ok: true }>("DELETE", `/groups/${encodeURIComponent(id)}`),
	startGroup: (id: string, only: boolean) => call<GroupResult>("POST", `/groups/${encodeURIComponent(id)}/start`, { only }),
	stopGroup: (id: string) => call<GroupResult>("POST", `/groups/${encodeURIComponent(id)}/stop`),
	order: () => call<DisplayOrder>("GET", "/order"),
	putOrder: (order: Partial<DisplayOrder>) => call<DisplayOrder>("PUT", "/order", order),
	stopAll: () => call<{ stopped: string[]; failed: { id: string; error: string }[] }>("POST", "/stop-all"),
	putSettings: (settings: PortSettings) => call<{ ok: true }>("PUT", "/settings", settings),
	agents: () => call<AgentStatus[]>("GET", "/agents"),
	putAgents: (wishes: AgentWishes) => call<AgentStatus[]>("PUT", "/agents", wishes),
	shutdown: (stopServing: boolean) => call<{ ok: true }>("POST", "/shutdown", { stopServing }),
};
