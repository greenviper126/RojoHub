import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";

import { decode } from "@msgpack/msgpack";

import type { GroupResult, GroupView, SlotView, TargetOption } from "../common/api";
import { parsePortSettings, preferredPort } from "../service/ports";

/*
	Drives the real service against a real `rojo serve` and a throwaway git repo,
	with a websocket client standing in for the Studio plugin. Needs git and a
	Rokit-installed rojo 7.7 on PATH.
*/

const API_PORT = 34869;
const api = `http://127.0.0.1:${API_PORT}`;
const root = mkdtempSync(join(tmpdir(), "rojo-hub-e2e-"));
const repo = join(root, "Game");
const featureTree = join(root, "wt-feature");
const home = join(root, "home");
const projectName = `HubE2E-${process.pid}`;
let service: ChildProcess;

function gitIn(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
}

function write(file: string, text: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(api + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(`${method} ${path}: ${payload.error}`);
	return payload;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, ms = 15000): Promise<T> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
	mkdirSync(repo, { recursive: true });
	gitIn(repo, "init", "-q", "-b", "main");
	write(join(repo, ".gitignore"), "Packages/\n");
	write(join(repo, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');
	write(
		join(repo, "default.project.json"),
		JSON.stringify({
			name: projectName,
			servePlaceIds: [123],
			globIgnorePaths: ["**/*.ignored.luau"],
			tree: {
				$className: "DataModel",
				ServerScriptService: { $className: "ServerScriptService", Game: { $path: "src/Server" } },
				ReplicatedStorage: { $className: "ReplicatedStorage", Packages: { $path: "Packages" } },
			},
		}),
	);
	write(join(repo, "src", "Server", "Foo.server.luau"), 'print("main")\n');
	write(join(repo, "src", "Server", "Skip.ignored.luau"), "return 0\n");
	gitIn(repo, "add", "-A");
	gitIn(repo, "commit", "-q", "-m", "main");
	write(join(repo, "Packages", "Dep.luau"), "return 'dep'\n");

	gitIn(repo, "checkout", "-q", "-b", "feature");
	write(join(repo, "src", "Server", "Foo.server.luau"), 'print("feature")\n');
	gitIn(repo, "commit", "-q", "-am", "feature");
	gitIn(repo, "checkout", "-q", "-b", "other", "main");
	write(join(repo, "src", "Server", "Other.server.luau"), 'print("other")\n');
	gitIn(repo, "add", "-A");
	gitIn(repo, "commit", "-q", "-m", "other");
	gitIn(repo, "checkout", "-q", "main");
	gitIn(repo, "worktree", "add", "-q", featureTree, "feature");

	service = spawn(process.execPath, [join(__dirname, "..", "service", "main.js")], {
		env: { ...process.env, ROJO_HUB_HOME: home, ROJO_HUB_PORT: String(API_PORT) },
		stdio: "inherit",
	});
	await until("service", () => fetch(api + "/health").then((r) => r.ok).catch(() => false));
});

after(async () => {
	await fetch(api + "/shutdown", { method: "POST", body: JSON.stringify({ stopServing: true }) }).catch(() => undefined);
	await sleep(500);
	service?.kill();
});

interface Packet {
	sessionId: string;
	body: { messages: { added: Record<string, { Name: string; Properties: { Source?: { String: string } } }>; removed: string[]; updated: { changedProperties: { Source?: { String: string } } }[] }[] };
}

test("one port, live switches, one session", async () => {
	const slot = await call<SlotView>("POST", "/slots", { path: featureTree });
	assert.equal(slot.repoPath.toLowerCase(), repo.toLowerCase(), "registering from a worktree registers the primary");
	const root = gitIn(repo, "rev-list", "--max-parents=0", "HEAD").trim();
	assert.equal(slot.port, preferredPort(`commit:${root}`, parsePortSettings({})), "port hashed from the first commit");
	assert.equal(slot.portSource, "hash");
	await assert.rejects(call("POST", "/slots", { path: repo }), /already registered/);

	const started = await call<SlotView>("POST", `/slots/${slot.id}/start`);
	assert.equal(started.state, "running");
	assert.equal(started.mode, "native");

	const info = decode(new Uint8Array(await (await fetch(`http://localhost:${slot.port}/api/rojo`)).arrayBuffer())) as {
		sessionId: string;
		projectName: string;
		rootInstanceId: string;
		expectedPlaceIds: number[];
	};
	assert.equal(info.projectName, projectName);
	assert.deepEqual(info.expectedPlaceIds, [123]);
	const read = decode(new Uint8Array(await (await fetch(`http://localhost:${slot.port}/api/read/${info.rootInstanceId}`)).arrayBuffer())) as {
		messageCursor: number;
		instances: Record<string, { Name: string }>;
	};
	const names = Object.values(read.instances).map((i) => i.Name);
	assert.ok(names.includes("Dep"), "packages served");
	assert.ok(!names.includes("Skip"), "globIgnorePaths honoured natively");

	const packets: Packet[] = [];
	let closed = false;
	const socket = new WebSocket(`ws://localhost:${slot.port}/api/socket/${read.messageCursor}`);
	socket.binaryType = "arraybuffer";
	socket.onmessage = (event) => packets.push(decode(new Uint8Array(event.data as ArrayBuffer)) as Packet);
	socket.onclose = () => (closed = true);
	await new Promise((done) => (socket.onopen = done));
	await until("connection count 1", async () => (await call<SlotView[]>("GET", "/slots"))[0].connections === 1);

	const sources = () => packets.flatMap((p) => p.body.messages.flatMap((m) => [...m.updated.map((u) => u.changedProperties.Source?.String), ...Object.values(m.added).map((a) => a.Properties.Source?.String)])).filter(Boolean);

	const targets = await call<TargetOption[]>("GET", `/slots/${slot.id}/targets`);
	assert.ok(targets.some((t) => t.target.kind === "worktree" && t.branch === "feature"));
	assert.ok(targets.some((t) => t.target.kind === "branch" && t.branch === "other"));
	assert.ok(!targets.some((t) => t.target.kind === "branch" && t.branch === "feature"), "a checked-out branch is offered as its worktree");

	// worktree without Packages: borrowed mode, still one patch on the same session
	let switched = await call<SlotView>("POST", `/slots/${slot.id}/switch`, { target: { kind: "worktree", path: featureTree } });
	assert.equal(switched.mode, "borrowed");
	assert.equal(switched.branch, "feature");
	await until("feature source", async () => sources().some((s) => s!.includes("feature")));

	// edit in the served worktree
	packets.length = 0;
	writeFileSync(join(featureTree, "src", "Server", "Foo.server.luau"), 'print("feature edited")\n');
	await until("edit", async () => sources().some((s) => s!.includes("feature edited")));

	// branch with no worktree: checked out into a view
	packets.length = 0;
	switched = await call<SlotView>("POST", `/slots/${slot.id}/switch`, { target: { kind: "branch", ref: "refs/heads/other" } });
	assert.equal(switched.branch, "other");
	await until("other source", async () => sources().some((s) => s!.includes("other")));
	assert.equal(readdirSync(join(home, "views", slot.id)).length, 1, "one view, named after the commit");

	// back to the primary: views cleaned up
	packets.length = 0;
	switched = await call<SlotView>("POST", `/slots/${slot.id}/switch`, { target: { kind: "worktree", path: repo } });
	assert.equal(switched.mode, "native");
	// "other" branched from main, so the only difference is its extra script going away
	await until("Other removed", async () => packets.some((p) => p.body.messages.some((m) => m.removed.length > 0)));
	assert.equal(readdirSync(join(home, "views", slot.id)).length, 1, "views are kept while rojo runs (rojo-rbx/rojo#1305)");

	// the primary's own project file changes sync live when served natively
	packets.length = 0;
	const project = JSON.parse(readFileSync(join(repo, "default.project.json"), "utf8"));
	project.tree.ServerScriptService.Extra = { $path: "src/Server" };
	writeFileSync(join(repo, "default.project.json"), JSON.stringify(project));
	await until("project edit", async () => packets.some((p) => p.body.messages.some((m) => Object.values(m.added).some((a) => a.Name === "Extra"))));

	for (const packet of packets) assert.equal(packet.sessionId, info.sessionId);
	const after = decode(new Uint8Array(await (await fetch(`http://localhost:${slot.port}/api/rojo`)).arrayBuffer())) as { sessionId: string };
	assert.equal(after.sessionId, info.sessionId, "same session throughout");
	assert.equal(closed, false, "socket never closed");
	assert.equal((await call<SlotView[]>("GET", "/slots"))[0].state, "running");

	socket.close();
	await until("connection count 0", async () => (await call<SlotView[]>("GET", "/slots"))[0].connections === 0);

	// deleting a served subfolder crashes rojo 7.7 (rojo-rbx/rojo#1305); the Hub brings the port back
	mkdirSync(join(repo, "src", "Server", "Doomed", "Deeper"), { recursive: true });
	writeFileSync(join(repo, "src", "Server", "Doomed", "Deeper", "X.luau"), "return 1\n");
	await sleep(800);
	rmSync(join(repo, "src", "Server", "Doomed"), { recursive: true, force: true });
	const restarted = await until("restart after crash", async () => {
		const [view] = await call<SlotView[]>("GET", "/slots");
		return view.state === "running" && view.sessionId !== info.sessionId && view;
	}, 30000);
	assert.match(restarted.warnings.join("\n"), /crashed .* restarted/);
	assert.equal(readdirSync(join(home, "views", slot.id)).length, 0, "restart collected the unused view");

	// a servePort in the project file wins; the running slot moves to it
	const movedTo = slot.port === 35500 ? 35501 : 35500;
	const withPort = JSON.parse(readFileSync(join(repo, "default.project.json"), "utf8"));
	withPort.servePort = movedTo;
	writeFileSync(join(repo, "default.project.json"), JSON.stringify(withPort));
	const moved = await until("move to servePort", async () => {
		const [view] = await call<SlotView[]>("GET", "/slots");
		return view.port === movedTo && view.state === "running" && view;
	}, 30000);
	assert.equal(moved.portSource, "servePort");
	assert.match(moved.warnings.join("\n"), new RegExp(`Port moved from ${slot.port} to ${movedTo}`));
	const answer = decode(new Uint8Array(await (await fetch(`http://localhost:${movedTo}/api/rojo`)).arrayBuffer())) as { projectName: string };
	assert.equal(answer.projectName, projectName);

	const stopped = await call<SlotView>("POST", `/slots/${slot.id}/stop`);
	assert.equal(stopped.state, "stopped");
	await call("DELETE", `/slots/${slot.id}`);
	assert.deepEqual(await call("GET", "/slots"), []);
});

async function makeRepo(name: string): Promise<string> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	gitIn(dir, "init", "-q", "-b", "main");
	write(join(dir, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');
	write(
		join(dir, "default.project.json"),
		JSON.stringify({ name: `${name}-${process.pid}`, tree: { $className: "DataModel", ServerScriptService: { $className: "ServerScriptService", Code: { $path: "src" } } } }),
	);
	write(join(dir, "src", "Main.server.luau"), `print("${name}")\n`);
	gitIn(dir, "add", "-A");
	gitIn(dir, "commit", "-q", "-m", name);
	return dir;
}

test("groups nest without loops, serve only, and stop without taking shared projects down", async () => {
	const [one, two] = await Promise.all([makeRepo("GroupOne"), makeRepo("GroupTwo")]);
	const a = await call<SlotView>("POST", "/slots", { path: one });
	const b = await call<SlotView>("POST", "/slots", { path: two });
	// reordering is display only: it is saved, and never moves a port
	const portsBefore = (await call<SlotView[]>("GET", "/slots")).map((slot) => [slot.id, slot.port]);
	await call("PUT", "/order", { projects: [b.id, a.id], groups: [] });
	assert.deepEqual((await call<{ projects: string[] }>("GET", "/order")).projects, [b.id, a.id]);
	await sleep(3500); // the service recomputes ports every 3 s
	assert.deepEqual((await call<SlotView[]>("GET", "/slots")).map((slot) => [slot.id, slot.port]), portsBefore);

	const state = async (id: string) => (await call<SlotView[]>("GET", "/slots")).find((slot) => slot.id === id)!.state;

	const both = await call<GroupView>("POST", "/groups", { name: "Both", slotIds: [a.id, b.id] });
	const onlyA = await call<GroupView>("POST", "/groups", { name: "Just One", slotIds: [a.id] });
	await assert.rejects(call("POST", "/groups", { name: "both", slotIds: [] }), /already a group/);
	await assert.rejects(call("POST", "/groups", { name: "Ghost", slotIds: ["nope"] }), /No project/);

	let result = await call<GroupResult>("POST", `/groups/${both.id}/start`, {});
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.started.sort(), [a.id, b.id].sort());
	assert.equal(await state(a.id), "running");
	assert.equal(await state(b.id), "running");
	const sessionA = (await call<SlotView[]>("GET", "/slots")).find((slot) => slot.id === a.id)!.sessionId;

	result = await call<GroupResult>("POST", `/groups/${onlyA.id}/start`, { only: true });
	assert.deepEqual(result.stopped, [b.id], "serve-only stops projects outside the group");
	assert.deepEqual(result.started, [], "members already serving are left alone");
	assert.equal(await state(b.id), "stopped");
	assert.equal((await call<SlotView[]>("GET", "/slots")).find((slot) => slot.id === a.id)!.sessionId, sessionA, "same session kept");

	// Just One is running (Singleton), so stopping Both must keep A: another running group uses it
	result = await call<GroupResult>("POST", `/groups/${both.id}/stop`);
	assert.deepEqual(result.kept, [{ id: a.id, because: "Just One" }]);
	assert.equal(await state(a.id), "running");
	result = await call<GroupResult>("POST", `/groups/${onlyA.id}/stop`);
	assert.deepEqual(result.stopped, [a.id]);
	assert.equal(await state(a.id), "stopped");

	// nesting: Outer holds Both; Both can't then hold Outer, nor itself
	const outer = await call<GroupView>("POST", "/groups", { name: "Outer", groupIds: [both.id] });
	assert.deepEqual(outer.projectIds.sort(), [a.id, b.id].sort(), "nested projects count");
	await assert.rejects(call("PUT", `/groups/${both.id}`, { groupIds: [outer.id] }), /would loop.*Outer → Both|Outer → Both.*would loop/);
	await assert.rejects(call("PUT", `/groups/${both.id}`, { groupIds: [both.id] }), /can't contain itself/);
	result = await call<GroupResult>("POST", `/groups/${outer.id}/start`, {});
	assert.deepEqual(result.started.sort(), [a.id, b.id].sort(), "starting Outer starts the nested group's projects");
	assert.equal((await call<GroupView[]>("GET", "/groups")).find((group) => group.id === outer.id)!.active, true);
	result = await call<GroupResult>("POST", `/groups/${outer.id}/stop`);
	assert.deepEqual(result.stopped.sort(), [a.id, b.id].sort());
	await call("DELETE", `/groups/${both.id}`);
	assert.deepEqual((await call<GroupView[]>("GET", "/groups")).find((group) => group.id === outer.id)!.groupIds, [], "deleted group leaves the groups holding it");
	await call("DELETE", `/groups/${outer.id}`);
	const again = await call<GroupView>("POST", "/groups", { name: "Both", slotIds: [a.id, b.id] });

	// Stop all stops every serving project and marks every group stopped
	await call<GroupResult>("POST", `/groups/${again.id}/start`, {});
	assert.equal(await state(a.id), "running");
	const all = await call<{ stopped: string[]; failed: unknown[] }>("POST", "/stop-all");
	assert.deepEqual(all.stopped.sort(), [a.id, b.id].sort());
	assert.deepEqual(all.failed, []);
	assert.equal(await state(b.id), "stopped");
	assert.equal((await call<GroupView[]>("GET", "/groups")).every((group) => !group.active), true, "no group left running");

	await call("PUT", `/groups/${again.id}`, { name: "Renamed" });
	await call("DELETE", `/slots/${b.id}`);
	const groups = await call<GroupView[]>("GET", "/groups");
	assert.deepEqual(groups.find((group) => group.id === again.id)!.slotIds, [a.id], "removed project leaves its groups");
	assert.equal(groups.find((group) => group.id === again.id)!.name, "Renamed");
	await call("DELETE", `/groups/${again.id}`);
	await call("DELETE", `/groups/${onlyA.id}`);
	await call("DELETE", `/slots/${a.id}`);
	assert.deepEqual(await call("GET", "/groups"), []);
});

test("branch picker: cached list kept fresh, fetch, new branch, build, and a checkout in a served worktree", async () => {
	const origin = await makeRepo("BranchyOrigin");
	const dir = join(root, "Branchy");
	gitIn(root, "clone", "-q", origin, dir);
	const slot = await call<SlotView>("POST", "/slots", { path: dir });
	const labels = async () => (await call<TargetOption[]>("GET", `/slots/${slot.id}/targets`)).map((option) => option.label);
	assert.ok((await labels()).includes(basename(dir)), "the primary checkout is listed");

	// the list is served from memory, and a branch made outside the Hub shows up by itself
	const stamp = async () => (await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!.targetsAt;
	const before = await stamp();
	assert.ok(before > 0, "the list was read in the background after registering");
	let started = Date.now();
	await labels();
	assert.ok(Date.now() - started < 200, `a cached list comes back at once (${Date.now() - started} ms)`);
	gitIn(dir, "branch", "made-outside");
	await until("the new branch in the picker", async () => (await labels()).includes("made-outside"), 5000);
	assert.ok((await stamp()) > before, "targetsAt moves when a newer list is read");

	// Fetch picks up a branch pushed to the remote since
	gitIn(origin, "branch", "pushed-since");
	assert.ok(!(await labels()).includes("origin/pushed-since"));
	const fetched = await call<TargetOption[]>("POST", `/slots/${slot.id}/fetch`);
	assert.ok(fetched.some((option) => option.label === "origin/pushed-since"), "fetch lists the new remote branch");

	// New branch: git's rules and existing names are refused; a good one gets a worktree beside the repo and is served
	await assert.rejects(call("POST", `/slots/${slot.id}/branch`, { name: "bad name", base: "main" }), /not a valid branch name/);
	await assert.rejects(call("POST", `/slots/${slot.id}/branch`, { name: "made-outside", base: "main" }), /already exists/);
	await assert.rejects(call("POST", `/slots/${slot.id}/branch`, { name: "fine", base: "no-such-base" }), /is not a branch or commit/);
	const made = await call<{ slot: SlotView; path: string; branch: string; via: string }>("POST", `/slots/${slot.id}/branch`, { name: "feat/new-thing", base: "main" });
	assert.equal(made.via, "git", "a repo Orca does not know gets a git worktree");
	assert.equal(made.path.toLowerCase(), join(root, "Branchy-worktrees", "feat-new-thing").toLowerCase());
	assert.equal(made.branch, "feat/new-thing");
	assert.deepEqual(made.slot.target, { kind: "worktree", path: made.path });
	assert.equal(gitIn(made.path, "branch", "--show-current").trim(), "feat/new-thing");

	// Build a place file of what the slot serves, while stopped
	const output = join(root, "out", "Branchy.rbxl");
	const built = await call<{ output: string; bytes: number }>("POST", `/slots/${slot.id}/build`, { output });
	assert.ok(built.bytes > 0 && readFileSync(output).length === built.bytes, "the place file was written");

	// A checkout made in the served worktree is noticed and explained
	await call<SlotView>("POST", `/slots/${slot.id}/start`);
	gitIn(made.path, "checkout", "-q", "-b", "swapped-in");
	const noticed = await until("the checkout note", async () => {
		const view = (await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!;
		return view.warnings.some((warning) => /swapped-in was checked out in feat-new-thing/.test(warning)) && view;
	});
	assert.equal(noticed.state, "running", "a checkout that removes no folder leaves Rojo running");
	await until("the label to follow the checkout", async () => (await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!.targetLabel === "swapped-in");

	// Sourcemaps (spec 003): never created where git would show it; written on request; then kept up to date, through a crash
	const view = async () => (await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!;
	const sourcemap = join(made.path, "sourcemap.json");
	assert.equal((await view()).sourcemap.state, "off");
	assert.match((await view()).sourcemap.detail, /not gitignored/);
	assert.throws(() => readFileSync(sourcemap), "nothing was written");
	await call("POST", `/slots/${slot.id}/sourcemap`);
	assert.ok(readFileSync(sourcemap, "utf8").includes("Main.server.luau"), "Update sourcemap.json writes it once");
	await call("PUT", "/settings", { sourcemaps: true });
	await until("the watcher", async () => (await view()).sourcemap.state === "watching");
	write(join(made.path, "src", "Later.server.luau"), "print(1)\n");
	await until("a new file in the sourcemap", async () => readFileSync(sourcemap, "utf8").includes("Later.server.luau"));
	write(join(made.path, "src", "Gone", "X.luau"), "return 1\n");
	await until("the folder in the sourcemap", async () => readFileSync(sourcemap, "utf8").includes("X.luau"));
	rmSync(join(made.path, "src", "Gone"), { recursive: true, force: true }); // rojo-rbx/rojo#1305 kills the watcher
	await sleep(2500);
	write(join(made.path, "src", "AfterCrash.server.luau"), "print(2)\n");
	await until("the restarted watcher to see a new file", async () => readFileSync(sourcemap, "utf8").includes("AfterCrash.server.luau"));
	await call("PUT", "/settings", { sourcemaps: false });
	await until("the watcher to stop", async () => (await view()).sourcemap.state === "off");

	await call("DELETE", `/slots/${slot.id}`);
});

/** Calls one of the service's MCP tools (spec 004) the way an agent does. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
	const response = await fetch(api + "/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const payload = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
	return { text: payload.result.content[0].text, isError: payload.result.isError === true };
}

test("agents over MCP: serve_here switches live and claims, other worktrees wait, a user switch clears the claim", async () => {
	const dir = await makeRepo("Agenty");
	const alpha = join(root, "Agenty-alpha");
	const beta = join(root, "Agenty-beta");
	gitIn(dir, "worktree", "add", "-q", "-b", "alpha", alpha);
	gitIn(dir, "worktree", "add", "-q", "-b", "beta", beta);
	const slot = await call<SlotView>("POST", "/slots", { path: dir });
	const view = async () => (await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!;

	const stranger = await makeRepo("Stranger");
	assert.match((await tool("serve_here", { path: stranger })).text, /does not serve/, "an unregistered repo is explained");
	assert.match((await tool("serve_here", { path: "relative/path" })).text, /must be absolute/);

	const { sessionId } = await call<SlotView>("POST", `/slots/${slot.id}/start`);
	const first = await tool("serve_here", { path: join(alpha, "src") });
	assert.ok(!first.isError, first.text);
	assert.match(first.text, /now serves .*Agenty-alpha.*Rojo is serving/s);
	let now = await view();
	assert.equal(now.target.kind === "worktree" && now.target.path.toLowerCase(), alpha.toLowerCase(), "any folder inside the worktree serves its root");
	assert.equal(now.sessionId, sessionId, "switched live, not restarted");
	assert.equal(now.claim?.label, "Agenty-alpha");

	const refused = await tool("serve_here", { path: beta });
	assert.ok(refused.isError);
	assert.match(refused.text, /claimed by an agent working in Agenty-alpha/);
	assert.match((await tool("status", { path: beta })).text, /NOT being served/);
	assert.match((await tool("status", { path: alpha })).text, /your worktree is the one being served/);

	const forced = await tool("serve_here", { path: beta, force: true });
	assert.ok(!forced.isError, forced.text);
	assert.equal((await view()).claim?.label, "Agenty-beta");
	assert.ok((await tool("release", { path: alpha })).isError, "only the holder releases");
	assert.match((await tool("release", { path: beta })).text, /Released/);
	assert.equal((await view()).claim, null);

	const switched = await tool("switch", { project: slot.projectName, target: "alpha" });
	assert.ok(!switched.isError, switched.text);
	now = await view();
	assert.equal(now.target.kind === "worktree" && now.target.path.toLowerCase(), alpha.toLowerCase(), "a branch checked out in a worktree is served from it");
	assert.ok(now.claim);

	await call<SlotView>("POST", `/slots/${slot.id}/switch`, { target: { kind: "worktree", path: dir } });
	assert.equal((await view()).claim, null, "a switch by the user clears the claim");
	assert.equal((await view()).sessionId, sessionId);
	assert.ok((await tool("build", { project: slot.projectName, output: "out.rbxl" })).isError, "a relative output is refused");

	await call("DELETE", `/slots/${slot.id}`);
});

test("project files: added by default or the only one, changed live with a restart, refused on a clash", async () => {
	const tree = (label: string) => ({ $className: "DataModel", ServerScriptService: { $className: "ServerScriptService", Code: { $path: label } } });
	const lib = await makeRepo("Libby");
	write(join(lib, "tests", "Spec.server.luau"), 'print("spec")\n');
	write(join(lib, "test.project.json"), JSON.stringify({ name: `LibbyTests-${process.pid}`, tree: tree("tests") }));
	write(join(lib, "clash.project.json"), JSON.stringify({ name: `Solo-${process.pid}`, tree: tree("tests") }));

	const only = join(root, "Solo");
	mkdirSync(only, { recursive: true });
	gitIn(only, "init", "-q", "-b", "main");
	write(join(only, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');
	write(join(only, "src", "Main.server.luau"), 'print("solo")\n');
	write(join(only, "test.project.json"), JSON.stringify({ name: `Solo-${process.pid}`, tree: tree("src") }));
	gitIn(only, "add", "-A");
	gitIn(only, "commit", "-q", "-m", "solo");

	const many = join(root, "Many");
	mkdirSync(many, { recursive: true });
	gitIn(many, "init", "-q", "-b", "main");
	write(join(many, "a.project.json"), JSON.stringify({ name: "A", tree: tree("src") }));
	write(join(many, "b.project.json"), JSON.stringify({ name: "B", tree: tree("src") }));
	await assert.rejects(call("POST", "/slots", { path: many }), /several project files/);
	await assert.rejects(call("POST", "/slots", { path: many, projectFile: "../a.project.json" }), /file name/);

	const solo = await call<SlotView>("POST", "/slots", { path: only });
	assert.equal(solo.projectFile, "test.project.json", "a folder's only project file is used");

	const slot = await call<SlotView>("POST", "/slots", { path: lib });
	assert.equal(slot.projectFile, "default.project.json", "default.project.json without asking");
	const started = await call<SlotView>("POST", `/slots/${slot.id}/start`);
	assert.equal(started.state, "running");

	const changed = await call<SlotView>("PUT", `/slots/${slot.id}/project-file`, { projectFile: "test.project.json" });
	assert.equal(changed.projectFile, "test.project.json");
	assert.equal(changed.projectName, `LibbyTests-${process.pid}`, "takes the new file's name");
	assert.equal(changed.state, "running", "a serving project serves the new file");
	assert.notEqual(changed.sessionId, started.sessionId, "a new Rojo session");
	assert.equal(changed.port, started.port, "the port comes from the repo, not the file");
	const info = await fetch(`http://127.0.0.1:${changed.port}/api/rojo`).then((r) => r.arrayBuffer());
	assert.match(Buffer.from(info).toString("latin1"), new RegExp(`LibbyTests-${process.pid}`), "Rojo reports the new project's name");

	await assert.rejects(call("PUT", `/slots/${slot.id}/project-file`, { projectFile: "clash.project.json" }), /already named/);
	await assert.rejects(call("PUT", `/slots/${slot.id}/project-file`, { projectFile: "..\\x.project.json" }), /file name/);
	assert.equal((await call<SlotView[]>("GET", "/slots")).find((entry) => entry.id === slot.id)!.projectFile, "test.project.json", "a refused change keeps the file");

	await call("POST", `/slots/${slot.id}/stop`);
	const back = await call<SlotView>("PUT", `/slots/${slot.id}/project-file`, { projectFile: "default.project.json" });
	assert.equal(back.state, "stopped", "a stopped project only records the change");
	assert.equal(back.projectName, `Libby-${process.pid}`);

	await call("DELETE", `/slots/${slot.id}`);
	await call("DELETE", `/slots/${solo.id}`);
});
