import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { DEFAULT_PORT_RANGE, MCP_URL } from "../common/api";
import { expandGroup, pathBetween } from "../common/groups";
import { compareVersions } from "../common/version";
import { savedState } from "../extension/saved";
import { findWorkspaces, parseWorkspaceFile } from "../extension/workspaces";
import { AGENTS, agentState } from "../service/agentConfig";
import { headFile, parseWorktrees, readHead } from "../service/git";
import { Mcp, TOOLS } from "../service/mcp";
import { isRefChange } from "../service/targets";
import { olderThan77, resolveRojo, rojoSpec } from "../service/tools";
import { collectPaths, missingRoots, planTree, redirectPaths, slotProject, verbatim } from "../service/project";
import { assignPorts, parsePortSettings, preferredPort, type PortRequest } from "../service/ports";
import { slugify } from "../service/registry";
import { countConnections, decodeInfo } from "../service/rojo";

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
	assert.deepEqual([...custom.exclude].sort(), [34872, 40001, 40003, 40004, 40005, 40007]);
	assert.deepEqual(custom.problems, []);
	assert.equal(parsePortSettings({ excludedPorts: [] }).exclude.has(34872), true, "cannot be un-excluded");
	assert.match(parsePortSettings({ portRange: "5-1" }).problems[0], /portRange/);
	assert.match(parsePortSettings({ excludedPorts: ["nope"] }).problems[0], /excludedPorts/);
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
	assert.equal(slugify("TheLaundryShift"), "thelaundryshift");
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
				{ id: "tls", projectName: "TheLaundryShift", repoPath: "C:\r\TLS", projectFile: "default.project.json", seed: "commit:x", port: 35045, target: { kind: "worktree", path: "C:\r\TLS" }, wantRunning: true, activeView: null },
				{ id: "ai", projectName: "VluxyAI", repoPath: "C:\r\AI", projectFile: "default.project.json", seed: "commit:y", port: 35761, target: { kind: "branch", ref: "refs/heads/feature/fsm" }, wantRunning: false, activeView: "abc" },
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
			{ "path": "../VluxyAI" }, /* shared AI */
			{ "uri": "vscode-remote://ssh/elsewhere" },
			{ "path": "C:/abs/Thing", "name": "Thing" },
		],
		"settings": {},
	}`;
	const file = join("C:/r/TLS", "TLS.code-workspace");
	assert.deepEqual(parseWorkspaceFile(text, file), [resolve("C:/r/TLS"), resolve("C:/r/VluxyAI"), resolve("C:/abs/Thing")]);
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
	const json = new TextEncoder().encode('{"sessionId":"s1","serverVersion":"7.3.0","projectName":"vluxysf"}');
	assert.equal(decodeInfo(json, "application/json").projectName, "vluxysf");
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
