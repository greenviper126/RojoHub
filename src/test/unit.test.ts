import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { IncomingMessage } from "node:http";

import { DEFAULT_PORT_RANGE, MCP_URL, SERVICE_PORT, SERVICE_VERSION, STUDIO_PATH, STUDIO_PROTOCOL, type StudioHello, type StudioMatch } from "../common/api";
import { pathKey } from "../common/paths";
import { expandGroup, pathBetween } from "../common/groups";
import { defaultProjectFile, isProjectFileName, listProjectFiles } from "../common/projectFiles";
import { compareVersions } from "../common/version";
import { hideAgentNudge, showAgentNudge } from "../extension/nudge";
import { savedState } from "../extension/saved";
import { findWorkspaces, parseWorkspaceFile } from "../extension/workspaces";
import { AGENTS, agentState } from "../service/agentConfig";
import { gitVersion, headFile, MIN_GIT, parseWorktrees, readHead } from "../service/git";
import { Mcp, TOOLS } from "../service/mcp";
import { isRefChange } from "../service/targets";
import { olderThan77, resolveRojo, rojoSpec } from "../service/tools";
import { collectPaths, missingRoots, planTree, redirectPaths, slotProject, verbatim } from "../service/project";
import { assignPorts, parsePortSettings, preferredPort, type PortRequest } from "../service/ports";
import { Hub } from "../service/hub";
import { Registry, slugify } from "../service/registry";
import { allowedRequest } from "../service/server";
import { countConnections, decodeInfo, findRojo } from "../service/rojo";
import { matchPlace, speaksProtocol5, StudioLinks, type PlaceCandidate, type PlaceMemory } from "../service/studio";
import { acceptWebSocket } from "../service/websocket";
import { installPlugin, removePlugin } from "../service/studioPlugin";

test("verbatim prefixes a Windows path once", { skip: process.platform !== "win32" }, () => {
	assert.equal(verbatim("C:\\a\\b.json"), "\\\\?\\C:\\a\\b.json");
	assert.equal(verbatim("\\\\?\\C:\\a\\b.json"), "\\\\?\\C:\\a\\b.json");
	assert.equal(verbatim("C:/a/../a/b.json"), "\\\\?\\C:\\a\\b.json");
	assert.equal(verbatim("\\\\server\\share\\x"), "\\\\?\\UNC\\server\\share\\x");
});

test("collectPaths finds string and optional $paths", () => {
	const tree = { $className: "DataModel", A: { $path: "src/a" }, B: { C: { $path: { optional: "Packages" } } } };
	assert.deepEqual(collectPaths(tree), ["src/a", "Packages"]);
});

test("redirectPaths makes paths absolute and borrows the named roots", () => {
	const tree = { A: { $path: "src/a" }, P: { $path: "Packages" }, O: { $path: { optional: "ServerPackages" } } };
	const out = redirectPaths(tree, "C:\\tree", "C:\\primary", new Set(["Packages", "ServerPackages"])) as Record<string, { $path: unknown }>;
	assert.equal(out.A.$path, join("C:\\tree", "src/a"));
	assert.equal(out.P.$path, join("C:\\primary", "Packages"));
	assert.deepEqual(out.O.$path, { optional: join("C:\\primary", "ServerPackages") });
});

test("slotProject keeps the session fields and points the root at the nested file", () => {
	const primary = { name: "Game", servePlaceIds: [1, 2], servePort: 9999, globIgnorePaths: ["x"], tree: {} };
	const slot = slotProject("Game", primary, "C:\\tree\\default.project.json") as Record<string, unknown>;
	assert.deepEqual(slot.servePlaceIds, [1, 2]);
	assert.equal(slot.servePort, undefined);
	assert.equal(slot.globIgnorePaths, undefined);
	assert.equal((slot.tree as { $path: string }).$path, verbatim("C:\\tree\\default.project.json"));
});

function fixture(): { primary: string; tree: string } {
	const root = mkdtempSync(join(tmpdir(), "rojo-hub-unit-"));
	const primary = join(root, "primary");
	const tree = join(root, "tree");
	for (const dir of [primary, tree]) {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(
			join(dir, "default.project.json"),
			JSON.stringify({ name: "Game", globIgnorePaths: ["**/*.spec.luau"], tree: { S: { $path: "src" }, P: { $path: "Packages" } } }),
		);
		writeFileSync(join(dir, "wally.toml"), "[dependencies]\n");
	}
	mkdirSync(join(primary, "Packages"));
	return { primary, tree };
}

test("planTree serves natively when the tree has every mapped folder", () => {
	const { primary, tree } = fixture();
	mkdirSync(join(tree, "Packages"));
	const plan = planTree(tree, primary, "default.project.json", join(tree, "borrowed.json"));
	assert.equal(plan.mode, "native");
	assert.equal(plan.nestedFile, join(tree, "default.project.json"));
	assert.deepEqual(plan.warnings, []);
});

test("planTree borrows missing packages and says what is lost", () => {
	const { primary, tree } = fixture();
	assert.deepEqual(missingRoots({ tree: { P: { $path: "Packages" }, M: { $path: "missing" } } }, tree, primary), ["Packages"]);
	const plan = planTree(tree, primary, "default.project.json", join(tree, "borrowed.json"));
	assert.equal(plan.mode, "borrowed");
	assert.match(plan.warnings.join("\n"), /Packages comes from the primary/);
	assert.match(plan.warnings.join("\n"), /globIgnorePaths do not apply/);
});

test("planTree warns when the branch changed wally.toml", () => {
	const { primary, tree } = fixture();
	writeFileSync(join(tree, "wally.toml"), "[dependencies]\nFoo = \"a/b@1\"\n");
	const plan = planTree(tree, primary, "default.project.json", join(tree, "borrowed.json"));
	assert.match(plan.warnings[0], /changed wally.toml/);
});

test("parseWorktrees reads porcelain output", () => {
	const porcelain = [
		"worktree C:/repo",
		"HEAD aaaa",
		"branch refs/heads/main",
		"",
		"worktree C:/wt/feature",
		"HEAD bbbb",
		"detached",
		"",
	].join("\n");
	const worktrees = parseWorktrees(porcelain);
	assert.equal(worktrees.length, 2);
	assert.equal(worktrees[0].primary, true);
	assert.equal(worktrees[0].branch, "main");
	assert.equal(worktrees[1].detached, true);
	assert.equal(worktrees[1].primary, false);
});

test("port settings: defaults, ranges, 34872 always excluded, bad input reported", () => {
	const empty = parsePortSettings({});
	assert.equal(empty.first, 34873);
	assert.equal(empty.last, 35872);
	assert.ok(empty.exclude.has(34872));
	const custom = parsePortSettings({ portRange: "40000-40009", excludedPorts: [40001, "40003-40005", "40007"] });
	assert.deepEqual([custom.first, custom.last], [40000, 40009]);
	assert.deepEqual([...custom.exclude].sort(), [34870, 34872, 40001, 40003, 40004, 40005, 40007]);
	assert.deepEqual(custom.problems, []);
	assert.equal(parsePortSettings({ excludedPorts: [] }).exclude.has(34872), true, "cannot be un-excluded");
	assert.match(parsePortSettings({ portRange: "5-1" }).problems[0], /portRange/);
	assert.match(parsePortSettings({ excludedPorts: ["nope"] }).problems[0], /excludedPorts/);
	assert.ok(parsePortSettings({ portRange: "34800-34900" }).exclude.has(SERVICE_PORT), "the service's own port is never a project's");
	const single = parsePortSettings({ portRange: "35000-35000" });
	assert.deepEqual([single.first, single.last, single.problems.length], [35000, 35000, 0], "a one-port range is a range");
});

test("findRojo matches command lines with non-ASCII letters and quotes", { skip: process.platform !== "win32" }, async () => {
	// A stand-in rojo.exe (a copy of cmd.exe) whose command line names a slot file under such a folder.
	const dir = mkdtempSync(join(tmpdir(), "rojohub-find-"));
	const exe = join(dir, "rojo.exe");
	copyFileSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "cmd.exe"), exe);
	const slotFile = join(dir, "ΝΙΚΟΣ İbrahim’s", "slots", "a", "slot.project.json");
	const child = spawn(exe, ["/c", `ping -n 30 127.0.0.1 >nul & rem ${slotFile}`], { windowsHide: true, stdio: "ignore" });
	try {
		await new Promise((done) => setTimeout(done, 500));
		assert.deepEqual(await findRojo(slotFile), [child.pid], "found by its own path, whatever the letters");
		assert.deepEqual(await findRojo(slotFile.toUpperCase()), [child.pid], "case-insensitively");
		assert.deepEqual(await findRojo(join(dir, "someone-else", "slot.project.json")), [], "and nothing else");
	} finally {
		child.kill();
	}
});

test("git version check", () => {
	assert.deepEqual(gitVersion("git version 2.45.1.windows.1\n"), [2, 45]);
	assert.deepEqual(gitVersion("git version 2.30.0"), [2, 30]);
	assert.equal(gitVersion("nonsense"), null);
	assert.deepEqual(MIN_GIT, [2, 31]);
});

test("the service answers only local programs, never web pages", () => {
	const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
	assert.ok(allowedRequest(request({ host: "127.0.0.1:34870" }), 34870), "the extension, agents");
	assert.ok(allowedRequest(request({ host: "localhost:34870" }), 34870));
	assert.ok(allowedRequest(request({ host: "127.0.0.1:34870", origin: "vscode-file://vscode-app" }), 34870), "VS Code's own windows");
	assert.equal(allowedRequest(request({ host: "evil.example:34870" }), 34870), false, "DNS rebinding: a foreign Host");
	assert.equal(allowedRequest(request({ host: "127.0.0.1:34870", origin: "http://localhost:5173" }), 34870), false, "a localhost web page");
	assert.equal(allowedRequest(request({ host: "127.0.0.1:34870", origin: "null" }), 34870), false, "a file:// page");
	assert.equal(allowedRequest(request({ host: "127.0.0.1:9999" }), 34870), false, "another port");
	assert.equal(allowedRequest(request({}), 34870), false, "no Host");
});

test("a damaged registry.json is set aside and the last good save restored", () => {
	const home = mkdtempSync(join(tmpdir(), "rojohub-registry-"));
	const first = new Registry(home);
	first.groups.push({ id: "g", name: "G", slotIds: [] });
	first.save();
	first.groups.push({ id: "h", name: "H", slotIds: [] });
	first.save();
	writeFileSync(join(home, "registry.json"), '{"version": 1, "slots": [');
	const second = new Registry(home);
	assert.match(second.recovered ?? "", /registry\.json\.bak/);
	assert.deepEqual(second.groups.map((group) => group.id), ["g"], "the save before the last one");
	assert.ok(readdirSync(home).some((name) => name.startsWith("registry.corrupt-")), "the damaged file is kept");
	assert.equal(new Registry(home).recovered, null, "and the next start reads fine");

	const bare = mkdtempSync(join(tmpdir(), "rojohub-registry-"));
	writeFileSync(join(bare, "registry.json"), "not json");
	const empty = new Registry(bare);
	assert.match(empty.recovered ?? "", /no projects/);
	assert.deepEqual(empty.slots, []);
});

const request = (id: string, seed: string, servePort: number | null = null): PortRequest => ({ id, name: id, seed, servePort });

test("hashed ports are a pure function of the seed", () => {
	const config = parsePortSettings({});
	const seed = "commit:82cb97798f758a6c13a09e73c7b97436e5181ccf";
	const alone = assignPorts([request("a", seed)], config);
	const withOthers = assignPorts([request("x", "commit:1fb3"), request("a", seed)], config);
	assert.equal(alone.get("a")!.port, preferredPort(seed, config));
	assert.equal(alone.get("a")!.port, withOthers.get("a")!.port, "other projects do not move it");
	assert.equal(alone.get("a")!.source, "hash");
});

test("servePort wins and hashed ports step around it", () => {
	const config = parsePortSettings({});
	const seed = "commit:abc";
	const own = preferredPort(seed, config);
	const result = assignPorts([request("hashed", seed), request("pinned", "commit:def", own)], config);
	assert.equal(result.get("pinned")!.port, own);
	assert.equal(result.get("pinned")!.source, "servePort");
	assert.equal(result.get("hashed")!.port, own === 35872 ? 34873 : own + 1);
	assert.match(result.get("hashed")!.note!, /taken by pinned/);
});

test("a hash collision goes to the project registered first", () => {
	const tiny = parsePortSettings({ portRange: "40000-40001", excludedPorts: [40001] });
	const full = assignPorts([request("first", "commit:1"), request("second", "commit:2")], tiny);
	assert.equal(full.get("first")!.port, 40000);
	assert.equal(full.get("second")!.port, null);
	assert.match(full.get("second")!.error!, /No free port/);
	const both = assignPorts([request("first", "commit:1"), request("second", "commit:1")], parsePortSettings({ portRange: "40000-40001" }));
	assert.notEqual(both.get("first")!.port, both.get("second")!.port);
	assert.equal(both.get("first")!.note, null);
	assert.match(both.get("second")!.note!, /moved/);
});

test("excluded ports are skipped, two servePorts on one port are an error", () => {
	const seed = "commit:abc";
	const own = preferredPort(seed, parsePortSettings({}));
	const result = assignPorts([request("a", seed)], parsePortSettings({ excludedPorts: [own] }));
	assert.notEqual(result.get("a")!.port, own);
	assert.match(result.get("a")!.note!, /excluded/);
	assert.match(assignPorts([request("svc", "s", SERVICE_PORT)], parsePortSettings({})).get("svc")?.error ?? "", /service port/, "a servePort cannot take the service's port");
	const clash = assignPorts([request("a", "s", 40000), request("b", "t", 40000)], parsePortSettings({}));
	assert.equal(clash.get("a")!.port, 40000);
	assert.match(clash.get("b")!.error!, /also set by a/);
});

test("expandGroup walks nested groups once each and survives a loop", () => {
	const groups = [
		{ id: "a", slotIds: ["p1"], groupIds: ["b", "c"] },
		{ id: "b", slotIds: ["p2", "p1"], groupIds: ["c"] },
		{ id: "c", slotIds: ["p3"], groupIds: ["a"] }, // a loop that got in by hand
	];
	assert.deepEqual(expandGroup(groups, "a"), ["p1", "p2", "p3"]);
	assert.deepEqual(expandGroup(groups, "c"), ["p3", "p1", "p2"]);
	assert.deepEqual(expandGroup(groups, "missing"), []);
	assert.deepEqual(expandGroup([{ id: "old", slotIds: ["p"] }], "old"), ["p"], "groups saved before nesting have no groupIds");
});

test("pathBetween finds the chain that would loop", () => {
	const groups = [
		{ id: "outer", slotIds: [], groupIds: ["middle"] },
		{ id: "middle", slotIds: [], groupIds: ["inner"] },
		{ id: "inner", slotIds: [], groupIds: [] },
	];
	assert.deepEqual(pathBetween(groups, "outer", "inner"), ["outer", "middle", "inner"], "adding outer to inner would loop");
	assert.equal(pathBetween(groups, "inner", "outer"), null, "adding inner to outer is fine");
	assert.deepEqual(pathBetween(groups, "inner", "inner"), ["inner"]);
});

test("slugify", () => {
	assert.equal(slugify("SkyIslands"), "skyislands");
	assert.equal(slugify("My Game!"), "my-game");
	assert.equal(slugify("!!!"), "project");
});

test("countConnections follows Rojo's websocket log lines", () => {
	const lines = [
		"[DEBUG librojo::web::api] WebSocket subscription established for session x",
		"[DEBUG librojo::web::api] WebSocket subscription established for session x",
		"[DEBUG librojo::web::api] Sending batch of messages over WebSocket subscription",
		"[DEBUG librojo::web::api] WebSocket subscription closed by client",
	];
	assert.equal(countConnections(lines), 1);
	assert.equal(countConnections(["[ERROR librojo::web::api] WebSocket error: reset"], 1), 0);
	assert.equal(countConnections(["[DEBUG librojo::web::api] WebSocket stream ended"], 0), 0);
});

test("savedState shows the registry's projects and groups while the service is stopped", () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-saved-"));
	assert.deepEqual(savedState(home, []), { slots: [], groups: [], order: { projects: [], groups: [] } }, "no registry yet");
	writeFileSync(
		join(home, "registry.json"),
		JSON.stringify({
			version: 1,
			slots: [
				{ id: "tls", projectName: "SkyIslands", repoPath: "C:\r\TLS", projectFile: "default.project.json", seed: "commit:x", port: 35045, target: { kind: "worktree", path: "C:\r\TLS" }, wantRunning: true, activeView: null },
				{ id: "ai", projectName: "NpcBrain", repoPath: "C:\r\AI", projectFile: "default.project.json", seed: "commit:y", port: 35761, target: { kind: "branch", ref: "refs/heads/feature/fsm" }, wantRunning: false, activeView: "abc" },
			],
			groups: [
				{ id: "outer", name: "Outer", slotIds: [], groupIds: ["tls-group"], active: true },
				{ id: "tls-group", name: "TLS", slotIds: ["tls", "ai"] },
			],
		}),
	);
	const known = [{ id: "tls", targetLabel: "chore/untrack-wally-lock", portSource: "servePort", branch: "chore/untrack-wally-lock" }] as unknown as Parameters<typeof savedState>[1];
	const { slots, groups } = savedState(home, known);
	assert.deepEqual(slots.map((slot) => [slot.id, slot.port, slot.state, slot.targetLabel]), [
		["tls", 35045, "offline", "chore/untrack-wally-lock"],
		["ai", 35761, "offline", "feature/fsm"],
	]);
	assert.equal(slots[0].portSource, "servePort", "keeps what the service last said");
	assert.deepEqual(groups.map((group) => [group.name, group.projectIds, group.active, group.groupIds]), [
		["Outer", ["tls", "ai"], true, ["tls-group"]],
		["TLS", ["tls", "ai"], false, []],
	]);
	writeFileSync(join(home, "registry.json"), "{ not json");
	assert.deepEqual(savedState(home, []), { slots: [], groups: [], order: { projects: [], groups: [] } }, "a broken file shows nothing rather than failing");
});

test("parseWorkspaceFile reads VS Code's commented, trailing-comma workspace files", () => {
	const text = `{
		// the main game and its libraries
		"folders": [
			{ "path": "." },
			{ "path": "../NpcBrain" }, /* shared AI */
			{ "uri": "vscode-remote://ssh/elsewhere" },
			{ "path": "C:/abs/Thing", "name": "Thing" },
		],
		"settings": {},
	}`;
	const file = join("C:/r/TLS", "TLS.code-workspace");
	assert.deepEqual(parseWorkspaceFile(text, file), [resolve("C:/r/TLS"), resolve("C:/r/NpcBrain"), resolve("C:/abs/Thing")]);
});

test("findWorkspaces groups registered projects and lists addable folders", async () => {
	const root = mkdtempSync(join(tmpdir(), "rojo-hub-ws-"));
	const make = (name: string, project: boolean) => {
		mkdirSync(join(root, name), { recursive: true });
		if (project) writeFileSync(join(root, name, "default.project.json"), "{}");
	};
	make("Game", true);
	make("Lib", true);
	make("Docs", false);
	make("Solo", true);
	writeFileSync(join(root, "Game", "Game.code-workspace"), JSON.stringify({ folders: [{ path: "." }, { path: "../Lib" }, { path: "../Docs" }, { path: "../Missing" }] }));
	writeFileSync(join(root, "Solo", "Solo.code-workspace"), JSON.stringify({ folders: [{ path: "." }] }));
	const primaryOf = async (folder: string) => folder;

	const withGameOnly = await findWorkspaces({ windowFile: null, slots: [{ id: "game", repoPath: join(root, "Game") }], primaryOf });
	assert.equal(withGameOnly.length, 1, "only workspaces in registered projects' folders are found");
	assert.equal(withGameOnly[0].name, "Game");
	assert.deepEqual(withGameOnly[0].slotIds, ["game"]);
	assert.deepEqual(withGameOnly[0].addable, [{ label: "Lib", path: resolve(join(root, "Lib")) }], "Docs has no project file, Missing does not exist");

	const all = await findWorkspaces({
		windowFile: join(root, "Solo", "Solo.code-workspace"),
		slots: [
			{ id: "game", repoPath: join(root, "Game") },
			{ id: "lib", repoPath: join(root, "Lib") },
		],
		primaryOf,
	});
	assert.deepEqual(all.map((workspace) => [workspace.name, workspace.isWindow, workspace.slotIds, workspace.addable.length]), [
		["Solo", true, [], 1],
		["Game", false, ["game", "lib"], 0],
	], "the window's workspace comes first");
});

test("rojoSpec reads Rokit, Aftman and Foreman manifests", () => {
	assert.deepEqual(rojoSpec('[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n'), { author: "rojo-rbx", name: "rojo", version: "7.7.0" });
	assert.deepEqual(rojoSpec('# aftman\n[tools]\nRojo = "rojo-rbx/rojo@7.3.0"\nwally = "x/y@1"\n'), { author: "rojo-rbx", name: "rojo", version: "7.3.0" });
	assert.deepEqual(rojoSpec('[tools]\nrojo = { source = "rojo-rbx/rojo", version = "=7.4.0" }\n'), { author: "rojo-rbx", name: "rojo", version: "7.4.0" });
	assert.equal(rojoSpec('[tools]\nwally = "upliftgames/wally@0.3.2"\n'), null);
	assert.equal(rojoSpec("not toml ["), null);
	assert.equal(olderThan77("7.3.0"), true);
	assert.equal(olderThan77("7.7.0"), false);
	assert.equal(olderThan77("8.0.0"), false);
});

test("resolveRojo finds the pinned binary the way Rokit does, or says what to install", () => {
	const root = mkdtempSync(join(tmpdir(), "rojo-hub-tools-"));
	const rokit = join(root, ".rokit");
	const exe = process.platform === "win32" ? "rojo.exe" : "rojo";
	mkdirSync(join(rokit, "tool-storage", "rojo-rbx", "rojo", "7.7.0"), { recursive: true });
	writeFileSync(join(rokit, "tool-storage", "rojo-rbx", "rojo", "7.7.0", exe), "");
	const project = join(root, "work", "Game");
	mkdirSync(project, { recursive: true });

	writeFileSync(join(root, "work", "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');
	const fromParent = resolveRojo(project, rokit);
	assert.ok(fromParent.ok && fromParent.binary === join(rokit, "tool-storage", "rojo-rbx", "rojo", "7.7.0", exe), "a manifest in a parent folder counts");

	writeFileSync(join(project, "aftman.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.3.0"\n');
	const missing = resolveRojo(project, rokit);
	assert.ok(!missing.ok && /Rojo 7\.3\.0 .* is not installed\. Run "rokit install"/.test(missing.error), "the nearest manifest wins, and a missing version says what to do");

	writeFileSync(join(project, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');
	const preferred = resolveRojo(project, rokit);
	assert.ok(preferred.ok && preferred.manifest === join(project, "rokit.toml"), "rokit.toml before aftman.toml in the same folder");
});

test("compareVersions orders versions numerically, so an old window never downgrades the service", () => {
	assert.ok(compareVersions("0.10.2", "0.9.0") > 0, "0.10 is newer than 0.9, which a string compare gets wrong");
	assert.ok(compareVersions("0.11.0", "0.11.1") < 0);
	assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("the port range default is the same in package.json and the code", () => {
	const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
		contributes: { configuration: { properties: Record<string, { default: unknown }> } };
	};
	assert.equal(manifest.contributes.configuration.properties["rojoHub.portRange"].default, DEFAULT_PORT_RANGE);
	assert.deepEqual([parsePortSettings({}).first, parsePortSettings({}).last], DEFAULT_PORT_RANGE.split("-").map(Number));
});

test("decodeInfo reads Rojo 7.7's MessagePack and older Rojo's JSON", () => {
	const json = new TextEncoder().encode('{"sessionId":"s1","serverVersion":"7.3.0","projectName":"combatlib"}');
	assert.equal(decodeInfo(json, "application/json").projectName, "combatlib");
	// {"sessionId":"s2","projectName":"TLS"} in MessagePack
	const packed = new Uint8Array([0x82, 0xa9, ...new TextEncoder().encode("sessionId"), 0xa2, 0x73, 0x32, 0xab, ...new TextEncoder().encode("projectName"), 0xa3, 0x54, 0x4c, 0x53]);
	assert.deepEqual(decodeInfo(packed, "application/msgpack"), { sessionId: "s2", projectName: "TLS" });
});

test("isRefChange keeps ref, HEAD and worktree changes and ignores the index, logs, objects and locks", () => {
	for (const name of ["HEAD", "packed-refs", "refs\\heads\\main", "refs/remotes/origin/x", "worktrees", "worktrees/wt2", "worktrees\\wt2\\HEAD"]) assert.ok(isRefChange(name), name);
	for (const name of ["index", "FETCH_HEAD", "ORIG_HEAD", "logs/HEAD", "objects/ab/cdef", "refs/heads/main.lock", "packed-refs.lock", "worktrees/wt2/index", "worktrees/wt2/HEAD.lock"])
		assert.ok(!isRefChange(name), name);
});

test("headFile and readHead find a worktree's HEAD, primary or linked", () => {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-head-"));
	mkdirSync(join(dir, "main", ".git"), { recursive: true });
	writeFileSync(join(dir, "main", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
	assert.equal(headFile(join(dir, "main")), join(dir, "main", ".git", "HEAD"));
	assert.equal(readHead(headFile(join(dir, "main"))!), "feature/x");
	mkdirSync(join(dir, "main", ".git", "worktrees", "wt"), { recursive: true });
	writeFileSync(join(dir, "main", ".git", "worktrees", "wt", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
	mkdirSync(join(dir, "wt"), { recursive: true });
	writeFileSync(join(dir, "wt", ".git"), `gitdir: ${join(dir, "main", ".git", "worktrees", "wt")}\n`);
	assert.equal(readHead(headFile(join(dir, "wt"))!), "01234567", "a detached HEAD reads as the short commit");
});

test("MCP: initialize, tools/list, notifications and unknown methods", async () => {
	const mcp = new Mcp(null as never);
	const init = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as { result: { protocolVersion: string; instructions: string; capabilities: object } };
	assert.equal(init.result.protocolVersion, "2025-06-18", "a version it knows is echoed");
	assert.match(init.result.instructions, /serve_here/);
	assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
	const unknownVersion = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
	assert.equal(unknownVersion.result.protocolVersion, "2025-11-25", "otherwise its newest");
	assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no answer");
	const list = (await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string }[] } };
	assert.deepEqual(list.result.tools.map((tool) => tool.name), ["status", "serve_here", "switch", "release", "build", "sourcemap"]);
	assert.ok(!TOOLS.some((tool) => /^(start|stop|add|remove)/.test(tool.name)), "no tool starts, stops, adds or removes projects");
	assert.equal(((await mcp.handle({ jsonrpc: "2.0", id: 4, method: "nope" })) as { error: { code: number } }).error.code, -32601);
	assert.equal(((await mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "start" } })) as { error: { code: number } }).error.code, -32602);
	assert.deepEqual(await mcp.handle({ jsonrpc: "2.0", id: 6, method: "ping" }), { jsonrpc: "2.0", id: 6, result: {} });
});

test("agent config: Rojo-Hub's entry, another rojohub entry, or none", () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-agents-"));
	const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
	Object.assign(process.env, { USERPROFILE: home, HOME: home, CODEX_HOME: home });
	try {
		const [claude, codex] = AGENTS;
		assert.equal(agentState(claude), "absent", "no config file at all");
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { rojohub: { type: "http", url: MCP_URL } }, projects: {} }));
		assert.equal(agentState(claude), "connected");
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { rojohub: { type: "http", url: "http://example.com/mcp" } } }));
		assert.equal(agentState(claude), "other", "someone else's rojohub is left alone");
		writeFileSync(join(home, ".claude.json"), '{"mcpServers": {"rojohub": ');
		assert.equal(agentState(claude), "unknown", "a file caught mid-write is not taken for a removed entry");
		writeFileSync(join(home, "config.toml"), `model = "x"

[mcp_servers.rojohub]
url = "${MCP_URL}"
`);
		assert.equal(agentState(codex), "connected");
		writeFileSync(join(home, "config.toml"), `[mcp_servers.other]
command = "x"
`);
		assert.equal(agentState(codex), "absent");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("every bundle package.json runs is packaged (the uninstall hook once was not)", () => {
	const root = resolve(__dirname, "..", "..");
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main: string; scripts: Record<string, string> };
	const packaged = readFileSync(join(root, ".vscodeignore"), "utf8");
	for (const file of [manifest.main, manifest.scripts["vscode:uninstall"].replace(/^node\s+/, "")]) {
		assert.ok(packaged.includes(`!${file.replace(/^\.\//, "")}`), `${file} is in .vscodeignore's allowlist`);
	}
});

test("the agent notice: only with projects and an installed agent that is not set up, and Later/never hide it", () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-nudge-"));
	const agent = (installed: boolean, state: "connected" | "absent" | "other") => ({ id: "claudeCode" as const, label: "Claude Code", installed, state, error: null });
	assert.equal(showAgentNudge(home, 1, [agent(true, "absent")]), true);
	assert.equal(showAgentNudge(home, 0, [agent(true, "absent")]), false, "not before the first project");
	assert.equal(showAgentNudge(home, 1, [agent(false, "absent")]), false, "not when no agent is installed");
	assert.equal(showAgentNudge(home, 1, [agent(true, "connected"), { ...agent(true, "absent"), id: "codex" as const }]), false, "not once one is set up");
	assert.equal(showAgentNudge(home, 1, [agent(true, "other")]), false, "not when the user set one up by hand");
	hideAgentNudge(home, "later");
	assert.equal(showAgentNudge(home, 1, [agent(true, "absent")]), false, "Later hides it");
	const until = JSON.parse(readFileSync(join(home, "agent-notice.json"), "utf8")).until as number;
	assert.ok(Math.abs(until - Date.now() - 14 * 86400000) < 60000, "for 14 days");
	hideAgentNudge(home, "never");
	assert.equal(JSON.parse(readFileSync(join(home, "agent-notice.json"), "utf8")).until, Number.MAX_SAFE_INTEGER);
});

test("project files: listed default first, the one used without asking, and only bare *.project.json names", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-files-"));
	for (const name of ["test.project.json", "default.project.json", "bench.project.json", "notes.json", "sourcemap.json"]) writeFileSync(join(dir, name), "{}");
	mkdirSync(join(dir, "sub.project.json"));
	assert.deepEqual(listProjectFiles(dir), ["default.project.json", "bench.project.json", "test.project.json"], "files only, default first, then by name");
	assert.deepEqual(listProjectFiles(join(dir, "missing")), []);

	assert.equal(defaultProjectFile(["default.project.json", "test.project.json"]), "default.project.json");
	assert.equal(defaultProjectFile(["test.project.json"]), "test.project.json", "a folder's only file is used without asking");
	assert.equal(defaultProjectFile(["bench.project.json", "test.project.json"]), null, "several and no default: ask");
	assert.equal(defaultProjectFile([]), null);

	assert.ok(isProjectFileName("test.project.json"));
	for (const bad of ["../x.project.json", "sub/x.project.json", "sub\\x.project.json", "C:x.project.json", "x.json", "", 7, null]) {
		assert.equal(isProjectFileName(bad), false, String(bad));
	}

	// a folder with only a test.project.json can be added from a workspace
	const lib = join(dir, "OnlyTests");
	mkdirSync(lib);
	writeFileSync(join(lib, "test.project.json"), "{}");
	writeFileSync(join(lib, "Lib.code-workspace"), JSON.stringify({ folders: [{ path: "." }] }));
	const found = await findWorkspaces({ windowFile: join(lib, "Lib.code-workspace"), slots: [], primaryOf: async (folder) => folder });
	assert.deepEqual(found[0]?.addable, [{ label: "OnlyTests", path: resolve(lib) }]);
});

test("pathKey treats a short 8.3 path and its long form as one folder", { skip: process.platform !== "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "rojo hub long name "));
	mkdirSync(join(dir, "Game"));
	const short = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:DIR).ShortPath"], {
		encoding: "utf8",
		env: { ...process.env, DIR: dir },
	}).trim();
	if (!short.includes("~")) return; // short names are turned off on this drive
	assert.equal(pathKey(join(short, "Game")), pathKey(join(dir, "Game")));
	assert.equal(pathKey(join(short, "not-made-yet")), pathKey(join(dir, "not-made-yet")), "also for a folder that does not exist yet");
	assert.equal(pathKey(dir.toUpperCase() + "\\"), pathKey(dir), "case and a trailing slash");
});

const candidate = (over: Partial<PlaceCandidate> & { slotId: string }): PlaceCandidate => ({
	projectName: over.slotId,
	port: 35000,
	state: "running",
	sessionId: `session-${over.slotId}`,
	branch: "main",
	targetLabel: "main",
	rojoVersion: "7.7.0",
	servePlaceIds: null,
	blockedPlaceIds: null,
	placeId: null,
	...over,
});
const place = (placeId: number, remembered: string | null = null, unsaved = false) => ({ placeId, remembered, unsaved });

test("Studio places: servePlaceIds, then placeId, then the remembered project (spec 007)", () => {
	const lobby = candidate({ slotId: "lobby", servePlaceIds: [111, 222] });
	const byPlaceId = candidate({ slotId: "tools", placeId: 222 });
	const old = candidate({ slotId: "old" });
	assert.equal(matchPlace(place(222), [lobby, byPlaceId, old], null).target?.slotId, "lobby", "servePlaceIds wins over placeId");
	assert.equal(matchPlace(place(222), [byPlaceId, old], null).target?.slotId, "tools");
	const remembered = matchPlace(place(999, "old"), [lobby, byPlaceId, old], null);
	assert.equal(remembered.target?.slotId, "old");
	assert.equal(remembered.target?.reason, "remembered");
	assert.equal(matchPlace(place(999), [lobby, byPlaceId, old], null).status, "none");
	assert.equal(matchPlace(place(111), [lobby], null).target?.slotId, "lobby", "one project serves several places");
});

test("Studio places: an assignment from VS Code wins, for any place, saved or not", () => {
	const lobby = candidate({ slotId: "lobby", servePlaceIds: [111] });
	const other = candidate({ slotId: "other" });
	const assigned = matchPlace(place(111), [lobby, other], "other");
	assert.equal(assigned.target?.slotId, "other");
	assert.equal(assigned.target?.reason, "assigned");
	assert.equal(matchPlace(place(0, null, true), [lobby, other], "other").target?.slotId, "other", "an unsaved place too");
	assert.equal(matchPlace(place(0, null, true), [lobby, other], null).status, "unsaved");
	const waiting = matchPlace(place(111), [lobby, { ...other, state: "stopped", sessionId: null }], "other");
	assert.equal(waiting.status, "stopped", "an assigned project that is not serving is waited for");
	assert.equal(waiting.projectId, "other");
	assert.equal(matchPlace(place(111), [lobby], "removed").target?.slotId, "lobby", "an assignment to a project that is gone is ignored");
});

test("Studio places: only running projects connect, and a stopped claimant is not skipped for a lower tier", () => {
	const stopped = candidate({ slotId: "game", servePlaceIds: [111], state: "stopped", sessionId: null });
	const other = candidate({ slotId: "other" });
	const answer = matchPlace(place(111, "other"), [stopped, other], null);
	assert.equal(answer.status, "stopped");
	assert.equal(answer.target, null);
	assert.match(answer.message, /Waiting for game/);
	const starting = candidate({ slotId: "game", servePlaceIds: [111], state: "starting", sessionId: null });
	assert.equal(matchPlace(place(111), [starting], null).status, "stopped");
});

test("Studio places: several serving claimants are assigned in VS Code; only serving ones compete", () => {
	const a = candidate({ slotId: "a", servePlaceIds: [111] });
	const b = candidate({ slotId: "b", servePlaceIds: [111] });
	const choose = matchPlace(place(111), [a, b], null);
	assert.equal(choose.status, "choose");
	assert.match(choose.message, /VS Code/);
	assert.equal(matchPlace(place(111), [a, b], "b").target?.slotId, "b");
	assert.equal(matchPlace(place(111), [a, { ...b, state: "stopped", sessionId: null }], null).target?.slotId, "a");
});

test("Studio places: a place keeps to its own project while that one restarts", () => {
	const mine = candidate({ slotId: "mine", servePlaceIds: [111] });
	const fork = candidate({ slotId: "fork", servePlaceIds: [111] });
	const restarting = { ...mine, state: "starting" as const, sessionId: null };
	const waiting = matchPlace(place(111, "mine"), [restarting, fork], null);
	assert.equal(waiting.status, "stopped");
	assert.match(waiting.message, /^Waiting for mine/);
	assert.equal(matchPlace(place(111, "mine"), [mine, fork], null).target?.slotId, "mine", "and goes back to it without being asked");
	assert.equal(matchPlace(place(111), [restarting, fork], null).target?.slotId, "fork", "a place that never synced takes the only serving claimant");
});

test("Studio places: blocked places and old Rojo never connect", () => {
	const blocked = candidate({ slotId: "x", servePlaceIds: [111], blockedPlaceIds: [111] });
	assert.equal(matchPlace(place(111), [blocked], null).status, "none");
	const old = matchPlace(place(111), [candidate({ slotId: "sf", servePlaceIds: [111], rojoVersion: "7.3.0" })], null);
	assert.equal(old.status, "unsupported");
	assert.match(old.message, /Rojo 7\.3\.0/);
	assert.equal(speaksProtocol5("7.7.0"), true);
	assert.equal(speaksProtocol5("8.0.1"), true);
	assert.equal(speaksProtocol5("7.6.1"), false);
});

test("the Studio WebSocket: hello gets the place's answer, changes are pushed, VS Code assigns, web pages are refused", async () => {
	const { createServer } = await import("node:http");
	let candidates: PlaceCandidate[] = [candidate({ slotId: "game", servePlaceIds: [111], port: 35111 })];
	const assigned = new Map<number, string>();
	const synced = new Map<number, string>();
	const memory: PlaceMemory = {
		assigned: (id) => assigned.get(id) ?? null,
		assign: (id, slot) => void (slot ? assigned.set(id, slot) : assigned.delete(id)),
		synced: (id) => synced.get(id) ?? null,
		sync: (id, name) => void synced.set(id, name),
	};
	const links = new StudioLinks(() => candidates, memory);
	const server = createServer();
	let port = 0;
	server.on("upgrade", (request, socket, head) => {
		if (!allowedRequest(request, port)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		const link = acceptWebSocket(request, socket, head);
		if (link) links.attach(link);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	port = (server.address() as { port: number }).port;
	const open = async (hello: StudioHello) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}${STUDIO_PATH}`);
		const inbox: StudioMatch[] = [];
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as StudioMatch | { type: "welcome" | "ping" };
			if (message.type === "welcome") socket.send(JSON.stringify(hello));
			if (message.type === "match") inbox.push(message);
		};
		await new Promise((done, fail) => ((socket.onopen = done), (socket.onerror = fail)));
		const next = async (): Promise<StudioMatch> => {
			const deadline = Date.now() + 3000;
			while (inbox.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
			const message = inbox.shift();
			assert.ok(message, "an answer arrived");
			return message;
		};
		return { socket, next };
	};
	try {
		const hello: StudioHello = { type: "hello", protocol: STUDIO_PROTOCOL, pluginVersion: "test", placeId: 111, gameId: 1, placeName: "Lobby", unsaved: false, remembered: null };
		const lobby = await open(hello);
		const first = await lobby.next();
		assert.equal(first.status, "connect");
		assert.equal(first.target?.port, 35111);

		// the project's rojo restarts: the new session reaches the plugin without it asking
		candidates = [candidate({ slotId: "game", servePlaceIds: [111], port: 35111, sessionId: "second" })];
		assert.equal((await lobby.next()).target?.sessionId, "second");

		// reporting the sync puts the place on the project's card and in the service's memory
		lobby.socket.send(JSON.stringify({ type: "state", connected: { port: 35111, projectName: "game", sessionId: "second" } }));
		await new Promise((done) => setTimeout(done, 100));
		assert.deepEqual(links.placesOn(35111, "second"), [{ placeId: 111, placeName: "Lobby", pluginVersion: "test" }]);
		assert.deepEqual(links.placesOn(35111, "first"), [], "a place synced to an older session is not on the card");
		assert.equal(synced.get(111), "game");

		// a second claimant appears: the place keeps to the project it syncs with
		candidates = [...candidates, candidate({ slotId: "fork", servePlaceIds: [111], port: 35112 })];
		await new Promise((done) => setTimeout(done, 400));
		assert.equal(links.places()[0].projectId, "game", "its answer, and so nothing sent, is unchanged");

		// VS Code assigns the fork: stored per place, and the plugin is told at once
		links.assign("111", "fork");
		assert.equal((await lobby.next()).target?.slotId, "fork");
		assert.equal(assigned.get(111), "fork");
		const [view] = links.places();
		assert.equal(view.key, "111");
		assert.equal(view.assigned, "fork");
		assert.equal(view.syncedWith, "game");

		// an unsaved place is assigned by window, and forgotten when the window closes
		const unsaved = await open({ ...hello, placeId: 0, placeName: "Place1", unsaved: true });
		assert.equal((await unsaved.next()).status, "unsaved");
		const key = links.places().find((entry) => entry.unsaved)!.key;
		assert.match(key, /^studio:/);
		links.assign(key, "game");
		assert.equal((await unsaved.next()).target?.slotId, "game");
		assert.throws(() => links.assign("0", "game"), /not a place ID/);
		unsaved.socket.close();

		// a plugin speaking another protocol is told to reopen the place instead of being matched
		lobby.socket.send(JSON.stringify({ ...hello, protocol: STUDIO_PROTOCOL + 1 }));
		assert.equal((await lobby.next()).status, "incompatible");

		lobby.socket.close();
		await new Promise((done) => setTimeout(done, 200));
		assert.equal(links.count, 0, "closed sockets are forgotten");

		// Node's WebSocket sends no Origin, so a web page's handshake is sent by hand
		const refused = await fetch(`http://127.0.0.1:${port}${STUDIO_PATH}`, {
			headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://evil.example" },
		}).then(
			(response) => response.status,
			() => "refused",
		);
		assert.notEqual(refused, 101, "a web page's WebSocket is refused");
	} finally {
		links.closeAll();
		server.close();
	}
});

test("the Studio plugin install: once, updated in place, our other copies removed, the official one only reported", () => {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-plugins-"));
	const plugins = join(dir, "Plugins");
	const source = join(dir, "RojoHub.rbxm");
	writeFileSync(source, "v1");
	const first = installPlugin(source, plugins);
	assert.equal(first.state, "installed");
	assert.match(first.detail, /next place you open/);
	assert.equal(readFileSync(join(plugins, "RojoHub.rbxm"), "utf8"), "v1");
	assert.equal(installPlugin(source, plugins).detail, "", "an identical file is left alone");

	writeFileSync(source, "v2");
	writeFileSync(join(plugins, "RojoHub-0.19.0.rbxm"), "downloaded");
	writeFileSync(join(plugins, "rojohub.rbxmx"), "old");
	writeFileSync(join(plugins, "RojoManagedPlugin.rbxm"), "official");
	writeFileSync(join(plugins, "Other.rbxm"), "someone else's");
	const second = installPlugin(source, plugins);
	assert.match(second.detail, /Updated/);
	assert.equal(readFileSync(join(plugins, "RojoHub.rbxm"), "utf8"), "v2");
	assert.deepEqual(second.removed.sort(), ["RojoHub-0.19.0.rbxm", "rojohub.rbxmx"]);
	assert.equal(second.officialRojo, true);
	assert.deepEqual(readdirSync(plugins).sort(), ["Other.rbxm", "RojoHub.rbxm", "RojoManagedPlugin.rbxm"], "nothing else is touched, and no temporary file is left");

	assert.equal(installPlugin(join(dir, "missing.rbxm"), plugins).state, "error");
	assert.equal(removePlugin(plugins), true);
	assert.equal(removePlugin(plugins), false);
});

test("the Studio plugin says the same version as the service", () => {
	const lua = readFileSync(resolve(__dirname, "..", "..", "plugin", "src", "RojoHub", "Version.lua"), "utf8");
	assert.equal(/return "([^"]+)"/.exec(lua)?.[1], SERVICE_VERSION);
	const hub = readFileSync(resolve(__dirname, "..", "..", "plugin", "src", "RojoHub", "init.lua"), "utf8");
	assert.equal(Number(/local PROTOCOL = (\d+)/.exec(hub)?.[1]), STUDIO_PROTOCOL, "the plugin's protocol matches STUDIO_PROTOCOL");
});

test("agents' claims survive a service restart, and run out as before", () => {

	const home = mkdtempSync(join(tmpdir(), "rojo-hub-claims-"));
	const first = new Hub(home);
	first.setClaim("game", { key: "worktree:c:/work/feature", label: "feature", until: Date.now() + 60_000 });
	first.setClaim("old", { key: "worktree:c:/work/old", label: "old", until: Date.now() - 1 });
	const second = new Hub(home);
	assert.equal(second.claimOf("game")?.label, "feature", "a new service keeps a claim that has not run out");
	assert.equal(second.claimOf("old"), null, "a claim that ran out is not brought back");
	second.setClaim("game", null);
	assert.equal(new Hub(home).claimOf("game"), null, "a released claim stays released");
});
