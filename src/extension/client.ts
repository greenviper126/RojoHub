import { spawn } from "node:child_process";

import { SERVICE_PORT, SERVICE_VERSION, type GroupResult, type GroupView, type Health, type PortSettings, type SlotView, type Target, type TargetOption } from "../common/api";

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

async function health(): Promise<Health | null> {
	try {
		const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1500) });
		return response.ok ? ((await response.json()) as Health) : null;
	} catch {
		return null;
	}
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/*
	Makes sure a service of this extension's version is running. An older one
	(left from before an update) is asked to exit, leaving its rojo processes
	serving for the new one to adopt.
*/
export async function ensureService(serviceScript: string): Promise<Health> {
	let current = await health();
	if (current && current.version === SERVICE_VERSION) return current;
	if (current) {
		await call("POST", "/shutdown", { stopServing: false }).catch(() => undefined);
		for (let i = 0; i < 40 && (await health()); i++) await sleep(100);
	}
	const child = spawn(process.execPath, [serviceScript], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	child.unref();
	for (let i = 0; i < 100; i++) {
		current = await health();
		if (current) return current;
		await sleep(100);
	}
	throw new Error("The Rojo-Hub service did not start. See service.log in %LOCALAPPDATA%\\RojoHub.");
}

export const client = {
	health,
	slots: () => call<SlotView[]>("GET", "/slots"),
	add: (path: string) => call<SlotView>("POST", "/slots", { path }),
	remove: (id: string) => call<{ ok: true }>("DELETE", `/slots/${encodeURIComponent(id)}`),
	start: (id: string) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/start`),
	stop: (id: string) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/stop`),
	targets: (id: string) => call<TargetOption[]>("GET", `/slots/${encodeURIComponent(id)}/targets`),
	switch: (id: string, target: Target) => call<SlotView>("POST", `/slots/${encodeURIComponent(id)}/switch`, { target }),
	groups: () => call<GroupView[]>("GET", "/groups"),
	createGroup: (name: string, slotIds: string[]) => call<GroupView>("POST", "/groups", { name, slotIds }),
	updateGroup: (id: string, changes: { name?: string; slotIds?: string[]; groupIds?: string[] }) => call<GroupView>("PUT", `/groups/${encodeURIComponent(id)}`, changes),
	deleteGroup: (id: string) => call<{ ok: true }>("DELETE", `/groups/${encodeURIComponent(id)}`),
	startGroup: (id: string, only: boolean) => call<GroupResult>("POST", `/groups/${encodeURIComponent(id)}/start`, { only }),
	stopGroup: (id: string) => call<GroupResult>("POST", `/groups/${encodeURIComponent(id)}/stop`),
	stopAll: () => call<{ stopped: string[]; failed: { id: string; error: string }[] }>("POST", "/stop-all"),
	putSettings: (settings: PortSettings) => call<{ ok: true }>("PUT", "/settings", settings),
	shutdown: (stopServing: boolean) => call<{ ok: true }>("POST", "/shutdown", { stopServing }),
};
