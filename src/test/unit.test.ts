import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { IncomingMessage } from "node:http";

import { CLAIM_NEVER, DEFAULT_PORT_RANGE, MCP_URL, SERVICE_PORT, SERVICE_VERSION, STUDIO_PATH, STUDIO_PROTOCOL, type StudioHello, type StudioMatch } from "../common/api";
import { pathKey } from "../common/paths";
import { expandGroup, pathBetween } from "../common/groups";
import { defaultProjectFile, isProjectFileName, listProjectFiles } from "../common/projectFiles";
import { launcherScript } from "../common/launcher";
import { compareVersions } from "../common/version";
import { hideAgentNudge, showAgentNudge } from "../extension/nudge";
import { savedState } from "../extension/saved";
import { findWorkspaces, parseWorkspaceFile } from "../extension/workspaces";
import { AGENTS, agentState } from "../service/agentConfig";
import { gitVersion, headFile, MIN_GIT, parseWorktrees, readHead, revParse } from "../service/git";
import { newerInstalled, profileExtensionsFile, userFolder } from "../extension/reload";
import { Mcp, outdatedNote, staleConnection, TOOLS } from "../service/mcp";
import { extensionLists } from "../service/installed";
import { isRefChange } from "../service/targets";
import { olderThan77, resolveRojo, rojoSpec } from "../service/tools";
import { collectPaths, missingRoots, planTree, redirectPaths, slotProject, verbatim } from "../service/project";
import { assignPorts, loadPortSettings, parseClaimMinutes, parsePortSettings, preferredPort, savePortSettings, settingsToken, tokenMatches, type PortRequest } from "../service/ports";
import { claimKey, Hub } from "../service/hub";
import { Groups } from "../service/groups";
import { AUDIT_FILE, AUDIT_MAX_BYTES, AUDIT_OLD_FILE, writeAudit } from "../service/audit";
import { SourcemapWatcher } from "../service/sourcemap";
import { listersOf, OUTCOME_MS, PlaceRequests, type RequestDeps } from "../service/requests";
import { Registry, slugify } from "../service/registry";
import { allowedRequest } from "../service/server";
import { countConnections, decodeInfo, findRojo, LogFollower } from "../service/rojo";
import { matchPlace, speaksProtocol5, StudioLinks, type PlaceCandidate, type PlaceMemory } from "../service/studio";
import { acceptWebSocket } from "../service/websocket";
import { installPlugin, removePlugin } from "../service/studioPlugin";
import { CLOSE_OFF_MESSAGE, type CloseAnswer, OFF_MESSAGE, placeInCommandLine, placeLink, Places, type PlaceSystem, type StudioProcess } from "../service/places";

// ensure's versions step reads VS Code's extension lists (spec 015): point it at an empty folder, never the real ones.
const noVsCode = mkdtempSync(join(tmpdir(), "rojo-hub-vscode-"));
process.env.ROJO_HUB_VSCODE_USER = join(noVsCode, "User");
process.env.ROJO_HUB_VSCODE_EXTENSIONS = join(noVsCode, "extensions");

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
	const mcp = new Mcp({ claimMinutes: 15 } as never);
	const init = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as { result: { protocolVersion: string; instructions: string; capabilities: object } };
	assert.equal(init.result.protocolVersion, "2025-06-18", "a version it knows is echoed");
	assert.match(init.result.instructions, /serve_here/);
	assert.match(init.result.instructions, /for 15 minutes \(rojoHub\.claimMinutes;/, "the instructions state the claim setting");
	assert.match(init.result.instructions, /Never run git checkout, switch, reset --hard, rebase or stash in a folder Rojo-Hub serves/);
	assert.match(init.result.instructions, /use new_branch, then serve_here from that worktree/);
	assert.match(init.result.instructions, /Never run installs \(wally, npm\) in a folder/);
	assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
	const unknownVersion = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
	assert.equal(unknownVersion.result.protocolVersion, "2025-11-25", "otherwise its newest");
	assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no answer");
	const list = (await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as { result: { tools: { name: string }[] } };
	const names = list.result.tools.map((tool) => tool.name);
	for (const name of ["status", "serve_here", "switch", "release", "start", "stop", "stop_all", "add_project", "remove_project", "project_files", "set_project_file", "branches", "new_branch", "log", "wait_for_studio", "start_group", "stop_group", "create_group", "edit_group", "delete_group", "build", "sourcemap", "request_place", "version"]) {
		assert.ok(names.includes(name), `the ${name} tool (spec 008, 014)`);
	}
	assert.ok(!names.some((name) => /assign|setting|agent/.test(name)), "nothing for what stays the user's: place assignments, settings, agent registration");
	for (const tool of TOOLS) {
		const schema = tool.inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
		assert.equal(schema.type, "object", tool.name);
		for (const required of schema.required ?? []) assert.ok(required in schema.properties, `${tool.name} requires ${required}, which it declares`);
		assert.ok(tool.description.length > 20 && tool.description.length < 400, `${tool.name} has a short description`);
	}
	assert.match(init.result.instructions, /force only when the user asks/);
	assert.equal(((await mcp.handle({ jsonrpc: "2.0", id: 4, method: "nope" })) as { error: { code: number } }).error.code, -32601);
	assert.equal(((await mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "launch_missiles" } })) as { error: { code: number } }).error.code, -32602);
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
		assert.equal(agentState(claude), "legacy", "the old URL entry is rewritten to the launcher (spec 011)");
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { rojohub: { type: "http", url: "http://example.com/mcp" } } }));
		assert.equal(agentState(claude), "other", "someone else's rojohub is left alone");
		writeFileSync(join(home, ".claude.json"), '{"mcpServers": {"rojohub": ');
		assert.equal(agentState(claude), "unknown", "a file caught mid-write is not taken for a removed entry");
		writeFileSync(join(home, "config.toml"), `model = "x"

[mcp_servers.rojohub]
url = "${MCP_URL}"
`);
		assert.equal(agentState(codex), "legacy");
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

	// rojoHub.studioAutoConnect "listed": the remembered project does not connect by itself; listed and assigned still do
	const listedOnly = matchPlace(place(999, "old"), [lobby, byPlaceId, old], null, false);
	assert.equal(listedOnly.status, "none");
	assert.match(listedOnly.message, /only listed places connect by themselves/);
	assert.equal(matchPlace(place(111, "old"), [lobby, old], null, false).target?.slotId, "lobby");
	assert.equal(matchPlace(place(999, "old"), [lobby, old], "old", false).target?.reason, "assigned");
});

test("Studio places: a project the Hub is restarting says so, so the plugin holds the lost session (spec 010)", () => {
	const restarting = matchPlace(place(111), [candidate({ slotId: "game", servePlaceIds: [111], state: "error", sessionId: null, restarting: true })], null);
	assert.equal(restarting.status, "stopped");
	assert.equal(restarting.restarting, true);
	assert.match(restarting.message, /is restarting/);
	const stopped = matchPlace(place(111), [candidate({ slotId: "game", servePlaceIds: [111], state: "stopped", sessionId: null })], null);
	assert.equal(stopped.status, "stopped");
	assert.equal("restarting" in stopped, false, "a stopped project's answer is as before");
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
	const accepted = new Set<string>();
	const memory: PlaceMemory = {
		accepted: (id, name) => accepted.has(`${id}:${name}`),
		accept: (id, name) => void accepted.add(`${id}:${name}`),
		assigned: (id) => assigned.get(id) ?? null,
		assign: (id, slot) => void (slot ? assigned.set(id, slot) : assigned.delete(id)),
		synced: (id) => synced.get(id) ?? null,
		sync: (id, name) => void synced.set(id, name),
	};
	const links = new StudioLinks(() => candidates, memory);
	const logged: string[] = [];
	links.log = (message) => void logged.push(message);
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
		assert.equal(first.target?.accepted, false, "a place's first sync with a project is confirmed by the user");

		// the project's rojo restarts: the new session reaches the plugin without it asking
		candidates = [candidate({ slotId: "game", servePlaceIds: [111], port: 35111, sessionId: "second" })];
		assert.equal((await lobby.next()).target?.sessionId, "second");

		// rojo crashed and the Hub is starting it again: the plugin is told so, and waits quietly (spec 010)
		candidates = [candidate({ slotId: "game", servePlaceIds: [111], port: 35111, state: "starting", sessionId: null, restarting: true })];
		const restarting = await lobby.next();
		assert.equal(restarting.status, "stopped");
		assert.equal(restarting.restarting, true);
		candidates = [candidate({ slotId: "game", servePlaceIds: [111], port: 35111, sessionId: "second" })];
		const back = await lobby.next();
		assert.equal(back.target?.sessionId, "second");
		assert.equal(back.restarting, undefined, "only a stopped answer says restarting");

		// reporting the sync puts the place on the project's card and in the service's memory
		lobby.socket.send(JSON.stringify({ type: "state", connected: { port: 35111, projectName: "game", sessionId: "second" } }));
		await new Promise((done) => setTimeout(done, 100));
		assert.deepEqual(links.placesOn(35111, "second"), [{ placeId: 111, placeName: "Lobby", pluginVersion: "test" }]);
		assert.deepEqual(links.placesOn(35111, "first"), [], "a place synced to an older session is not on the card");
		assert.equal(synced.get(111), "game");
		assert.equal((await lobby.next()).target?.accepted, true, "once synced, the pair is not confirmed again");
		assert.ok(accepted.has("111:game"));

		// what the plugin could not apply reaches an agent's switch, if it came after the switch began
		const before = Date.now();
		lobby.socket.send(JSON.stringify({ type: "unapplied", sessionId: "second", total: 3, items: ["StarterPlayer.StarterCharacterScripts (StarterCharacterScripts, not added)"] }));
		await new Promise((done) => setTimeout(done, 100));
		assert.deepEqual(links.unappliedOn(35111, before), [{ placeName: "Lobby", placeId: 111, total: 3, items: ["StarterPlayer.StarterCharacterScripts (StarterCharacterScripts, not added)"] }]);
		assert.deepEqual(links.unappliedOn(35111, Date.now() + 1000), [], "an older report is not news");
		assert.deepEqual(links.unappliedOn(35999, before), [], "nor one from a place synced to another project");

		// a second claimant appears: the place keeps to the project it syncs with
		candidates = [...candidates, candidate({ slotId: "fork", servePlaceIds: [111], port: 35112 })];
		await new Promise((done) => setTimeout(done, 400));
		assert.equal(links.places()[0].projectId, "game", "its answer, and so nothing sent, is unchanged");

		// VS Code assigns the fork: stored per place, and the plugin is told at once
		links.assign("111", "fork", "panel");
		assert.ok(logged.includes("studio: Lobby (111) assigned to fork (panel)"), logged.join("\n"));
		const handed = await lobby.next();
		assert.equal(handed.target?.slotId, "fork");
		assert.equal(typeof handed.target?.handoff, "number", "a deliberate assignment carries a handoff, so a synced plugin switches once (spec 014)");
		assert.equal(assigned.get(111), "fork");
		// the same assignment again is another handoff: a new number, never a repeat of the last
		links.assign("111", "fork");
		const again = await lobby.next();
		assert.ok((again.target?.handoff ?? 0) > (handed.target?.handoff ?? 0));
		// back to the project files: no handoff, and the old number is not resent for a project it was not for
		links.assign("111", null, "panel");
		assert.ok(logged.includes("studio: Lobby (111) assignment cleared (panel)"), logged.join("\n"));
		const cleared = await lobby.next();
		assert.equal(cleared.target?.slotId, "game");
		assert.equal(cleared.target?.handoff, undefined, "the project files hand nothing over");
		links.assign("111", "fork");
		assert.equal((await lobby.next()).target?.slotId, "fork");
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
		const unsavedAnswer = await unsaved.next();
		assert.equal(unsavedAnswer.target?.slotId, "game");
		assert.equal(typeof unsavedAnswer.target?.handoff, "number");
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
	const lua = readFileSync(resolve(__dirname, "..", "..", "plugin", "RojoHub", "Version.lua"), "utf8");
	assert.equal(/return "([^"]+)"/.exec(lua)?.[1], SERVICE_VERSION);
	const hub = readFileSync(resolve(__dirname, "..", "..", "plugin", "RojoHub", "init.lua"), "utf8");
	assert.equal(Number(/local PROTOCOL = (\d+)/.exec(hub)?.[1]), STUDIO_PROTOCOL, "the plugin's protocol matches STUDIO_PROTOCOL");
});

test("every Hub method the plugin's patches call exists in plugin/RojoHub/init.lua", () => {
	// 0.22.6 shipped a hook calling hub:updateNote() with no such method: Rojo's window never drew.
	const root = resolve(__dirname, "..", "..", "plugin");
	const hub = readFileSync(resolve(root, "RojoHub", "init.lua"), "utf8");
	const defined = new Set([...hub.matchAll(/^function Hub[:.](\w+)\(/gm)].map((m) => m[1]));
	for (const file of readdirSync(resolve(root, "patches"))) {
		const added = readFileSync(resolve(root, "patches", file), "utf8").split(/\r?\n/).filter((line) => line.startsWith("+")).join("\n");
		for (const [, name] of added.matchAll(/\bhub[:.](\w+)\(/g)) assert.ok(defined.has(name), `${file} calls hub:${name}(), which init.lua does not define`);
	}
});

test("plugin/upstream is Rojo's plugin unedited, and every patch in plugin/patches applies to it", () => {
	execFileSync(process.execPath, ["tools/plugin.mjs", "check"], { cwd: resolve(__dirname, "..", ".."), stdio: "pipe" });
});

test("THIRD-PARTY-NOTICES.md is current and lists every bundled npm package", () => {
	execFileSync(process.execPath, ["tools/notices.mjs", "--check"], { cwd: resolve(__dirname, "..", ".."), stdio: "pipe" });
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
	assert.equal(first.claimOf("old"), null);
	assert.equal(first.lapsedClaim("old")?.label, "old", "a claim that ran out is remembered, so release can say so");
	first.setClaim("old", { key: "worktree:c:/work/old", label: "old", until: Date.now() + 60_000 });
	assert.equal(first.lapsedClaim("old"), null, "claiming again forgets it");
});

test("rojoHub.claimMinutes (spec 004): parsing, fallback, and claims that run out after N minutes or never", () => {
	assert.equal(parseClaimMinutes(undefined), 15, "unset means 15");
	assert.equal(parseClaimMinutes(30), 30);
	assert.equal(parseClaimMinutes(0.5), 0.5, "fractions are allowed");
	assert.equal(parseClaimMinutes(0), 0, "0 is a value, not a missing one");
	assert.equal(parseClaimMinutes(1_000_000), 1_000_000, "no upper limit");
	for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, {}]) assert.equal(parseClaimMinutes(bad), 15, `${String(bad)} falls back to 15`);

	const home = mkdtempSync(join(tmpdir(), "rojo-hub-claimminutes-"));
	assert.equal(new Hub(home).claimMinutes, 15, "nothing saved: 15");
	savePortSettings(home, { claimMinutes: 0 });
	assert.equal(loadPortSettings(home).claimMinutes, 0);
	savePortSettings(home, {});
	assert.equal(loadPortSettings(home).claimMinutes, 0, "a push without it (an older extension) keeps the saved value");
	savePortSettings(home, { claimMinutes: -3 });
	assert.equal(loadPortSettings(home).claimMinutes, 15, "a negative value is saved as 15");

	// N minutes: the claim lapses N minutes after it was set (a fake clock: it is set in the past)
	savePortSettings(home, { claimMinutes: 2 });
	const timed = new Hub(home);
	const key = "worktree:c:/work/timed";
	assert.equal(timed.claimUntil(1_000), 1_000 + 120_000);
	timed.setClaim("young", { key, label: "young", until: timed.claimUntil(Date.now() - 60_000) });
	timed.setClaim("old", { key, label: "old", until: timed.claimUntil(Date.now() - 121_000) });
	assert.equal(timed.claimOf("young")?.label, "young", "a claim set 1 minute ago still holds with 2 minutes");
	assert.equal(timed.claimOf("old"), null, "one set 2 minutes and a second ago has lapsed");
	assert.equal(timed.lapsedClaim("old")?.label, "old");

	// 0: never lapses, survives a restart through claims.json, and is told apart by CLAIM_NEVER
	savePortSettings(home, { claimMinutes: 0 });
	const forever = new Hub(home);
	assert.equal(forever.claimUntil(1_000), CLAIM_NEVER);
	forever.setClaim("held", { key, label: "held", until: forever.claimUntil(0) });
	assert.equal(forever.claimOf("held")?.until, CLAIM_NEVER, "no clock reaches it");
	assert.equal(forever.lapsedClaim("held"), null);
	assert.equal(new Hub(home).claimOf("held")?.until, CLAIM_NEVER, "claims.json round-trips it");
	// a claim from 0 is renewed to N minutes once the setting is N
	savePortSettings(home, { claimMinutes: 3 });
	assert.ok(Math.abs(new Hub(home).claimUntil() - (Date.now() + 180_000)) < 5_000);
});

test("rojoHub.claimMinutes 0: answers say the claim lasts until release, and the structured claim is null-valued and valid", async () => {
	const repo = tempRepo();
	const schemaOf = (name: string) => TOOLS.find((tool) => tool.name === name)!.outputSchema as Schema;
	type Result = { result: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } };
	const callOn = (mcp: Mcp, name: string, args: object) => mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "2025-06-18") as Promise<Result>;

	// someone else holds a claim that never runs out
	const held = stubHub(repo, { key: "worktree:elsewhere", label: "Other", until: CLAIM_NEVER });
	const mcp = new Mcp({ ...held.hub, claimMinutes: 0, claimUntil: () => CLAIM_NEVER } as never);
	const status = await callOn(mcp, "status", { path: repo });
	assert.match(status.result.content[0].text, /claimed by an agent in Other until it calls release \(claims don't run out: rojoHub\.claimMinutes is 0\)/);
	assert.deepEqual(check(status.result.structuredContent, schemaOf("status")), [], "a never-expiring claim matches the schema");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const claim = (status.result.structuredContent!.projects as any[])[0].claim;
	assert.equal(claim.holder, "Other");
	assert.equal(claim.until, null);
	assert.equal(claim.secondsLeft, null);
	const refused = await callOn(mcp, "serve_here", { path: repo });
	assert.ok(refused.result.isError);
	assert.match(refused.result.content[0].text, /claimed by an agent working in Other until it calls release \(claims don't run out/);
	assert.doesNotMatch(refused.result.content[0].text, /\d+ min\)/, "no countdown for a claim that does not run out");

	// our own serve_here under 0, and under 15
	const mine = stubHub(repo, null);
	const taken = await callOn(new Mcp({ ...mine.hub, claimMinutes: 0, claimUntil: () => CLAIM_NEVER } as never), "serve_here", { path: repo });
	assert.match(taken.result.content[0].text, /You hold it until you call release \(claims don't run out: rojoHub\.claimMinutes is 0\)\. Call release/);
	assert.doesNotMatch(taken.result.content[0].text, /renews that/);
	const limited = await callOn(new Mcp(stubHub(repo, null).hub as never), "serve_here", { path: repo });
	assert.match(limited.result.content[0].text, /You hold it until \d.*; each Rojo-Hub call from this worktree renews that\./);

	// the instructions follow the setting
	const instructions = async (minutes: number) => ((await new Mcp({ claimMinutes: minutes } as never).handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as { result: { instructions: string } }).result.instructions;
	assert.match(await instructions(0), /for your worktree until you call release \(rojoHub\.claimMinutes is 0: claims never run out\)\. While another/);
	assert.match(await instructions(1), /for 1 minute \(rojoHub\.claimMinutes;/);
	assert.match(await instructions(45), /for 45 minutes \(rojoHub\.claimMinutes;/);
});

/* ---------- opening places (spec 009) ---------- */

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/* A machine with no Studio: records what would have been launched and closed. Tests never open Studio. */
function fakeStudio() {
	const calls = { lookups: [] as number[], launched: [] as string[], closed: [] as number[] };
	const running: StudioProcess[] = [];
	const dead = new Set<number>();
	const closeAnswers = new Map<number, CloseAnswer>();
	let failLookup = false;
	const system: PlaceSystem = {
		async lookup(placeId) {
			calls.lookups.push(placeId);
			if (failLookup) throw new Error(`Could not look up the universe of place ${placeId}: the request timed out. Try again.`);
			return { universeId: placeId + 1, name: `Place${placeId}` };
		},
		launch(link) {
			calls.launched.push(link);
			// Studio starts at once with the link in its command line (M5).
			running.push({ pid: 1000 + running.length, placeId: placeInCommandLine(link) });
		},
		async processes() {
			return running.filter((entry) => !dead.has(entry.pid));
		},
		async close(pid) {
			calls.closed.push(pid);
			return closeAnswers.get(pid) ?? "asked";
		},
		alive: (pid) => !dead.has(pid),
	};
	return { system, calls, running, dead, closeAnswers, failLookup: (on: boolean) => (failLookup = on) };
}

test("placeInCommandLine reads the link's place ID, and -placeId", () => {
	assert.equal(placeInCommandLine('"C:\\Roblox\\RobloxStudioBeta.exe" roblox-studio:1+launchmode:edit+task:EditPlace+placeId:108404263554868+universeId:10768528004'), 108404263554868);
	assert.equal(placeInCommandLine("RobloxStudioBeta.exe -task EditPlace -placeId 42 -universeId 7"), 42);
	assert.equal(placeInCommandLine('"C:\\Roblox\\RobloxStudioBeta.exe"'), null);
	assert.equal(placeLink(5, 6), "roblox-studio:1+launchmode:edit+task:EditPlace+placeId:5+universeId:6");
});

test("opening places: off by default does nothing; on, the universe is looked up once and kept", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-places-"));
	const fake = fakeStudio();
	let on = false;
	const places = new Places(home, () => on, () => [], fake.system);
	await assert.rejects(places.open(111), (error: Error) => error.message === OFF_MESSAGE);
	await assert.rejects(places.close(111), (error: Error) => error.message === CLOSE_OFF_MESSAGE);
	await assert.rejects(places.reopen(111), (error: Error) => error.message === CLOSE_OFF_MESSAGE);
	assert.match(CLOSE_OFF_MESSAGE, /rojoHub.closePlaces/);
	assert.deepEqual(fake.calls, { lookups: [], launched: [], closed: [] }, "nothing is looked up, launched or closed while off");
	// openPlaces alone does not allow closing, and closePlaces alone does not allow opening
	on = true;
	await assert.rejects(places.close(111), (error: Error) => error.message === CLOSE_OFF_MESSAGE);
	const closeOnly = new Places(home, () => false, () => [], fake.system, undefined, () => true);
	await assert.rejects(closeOnly.open(111), (error: Error) => error.message === OFF_MESSAGE);
	await assert.rejects(closeOnly.close(111), /place 111 is not open/, "closing is allowed; there is just nothing to close");

	on = true;
	assert.deepEqual(await places.open(111), { placeId: 111, placeName: "Place111", outcome: "opened" });
	assert.deepEqual(fake.calls.launched, [placeLink(111, 112)]);
	assert.equal(places.listed([111])[0].busy, "opening");

	// A new service reads the saved universe: no second lookup.
	const again = new Places(home, () => true, () => [], fake.system);
	fake.running.length = 0;
	await again.open(111);
	assert.deepEqual(fake.calls.lookups, [111]);
	assert.equal(again.name(111), "Place111");

	// The project file's gameId is the universe: no lookup at all.
	await again.open(222, 999);
	assert.equal(fake.calls.launched.at(-1), placeLink(222, 999));
	assert.deepEqual(fake.calls.lookups, [111]);
});

test("opening places: never a second copy, whether the plugin or a Studio command line says it is open", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-places-"));
	const fake = fakeStudio();
	let reported: { placeId: number; placeName: string }[] = [{ placeId: 111, placeName: "Lobby" }];
	const logged: string[] = [];
	const places = new Places(home, () => true, () => reported, fake.system, (line) => logged.push(line));
	assert.deepEqual(await places.open(111), { placeId: 111, placeName: "Lobby", outcome: "already-open", evidence: "plugin" });
	assert.equal(fake.calls.launched.length, 0, "open by its plugin");

	reported = [];
	fake.running.push({ pid: 50, placeId: 333 });
	const byProcess = await places.open(333);
	assert.equal(byProcess.outcome, "already-open", "open by command line, before its plugin reports it");
	assert.equal(byProcess.evidence, "process");
	assert.deepEqual(byProcess.pids, [50]);
	assert.ok(logged.some((line) => /looks open \(Studio pid 50, plugin not connected\); not opened/.test(line)), logged.join("|"));
	assert.equal(fake.calls.launched.length, 0);

	// Two opens at the same moment (a double click, two agents) open it once.
	const both = await Promise.all([places.open(444), places.open(444)]);
	assert.deepEqual(both.map((result) => result.outcome).sort(), ["already-open", "opened"]);
	assert.equal(fake.calls.launched.length, 1);
});

test("opening places: a failed lookup says which place and why, and a retry works", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-places-"));
	const fake = fakeStudio();
	const places = new Places(home, () => true, () => [], fake.system);
	fake.failLookup(true);
	await assert.rejects(places.open(555), /place 555: the request timed out\. Try again/);
	assert.match(places.listed([555])[0].error ?? "", /place 555/);
	assert.equal(fake.calls.launched.length, 0);
	fake.failLookup(false);
	assert.equal((await places.open(555)).outcome, "opened");
	assert.equal(places.listed([555])[0].error, null, "the error goes with the next try");
});

test("closing places: only a Studio whose command line names the place, asked (never killed); reopen waits for it to exit", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-places-"));
	const fake = fakeStudio();
	let reported: { placeId: number; placeName: string }[] = [];
	// openPlaces is off: a reopen's own open step needs only closePlaces
	const places = new Places(home, () => false, () => reported, fake.system, undefined, () => true);

	await assert.rejects(places.close(111), /place 111 is not open/);
	reported = [{ placeId: 111, placeName: "Lobby" }];
	await assert.rejects(places.close(111), /cannot tell which Studio window it is\. Close it in Studio/);
	assert.deepEqual(fake.calls.closed, []);

	fake.running.push({ pid: 70, placeId: 111 }, { pid: 71, placeId: 999 });
	await places.close(111);
	assert.deepEqual(fake.calls.closed, [70], "only the place's own Studio");

	// Reopen: asks to close, waits while Studio is still up (a save prompt), opens once it has exited.
	await places.reopen(111, 7, 5000);
	assert.deepEqual(fake.calls.closed, [70, 70]);
	assert.equal(places.listed([111])[0].busy, "reopening");
	await sleep(700);
	assert.equal(fake.calls.launched.length, 0, "not reopened while Studio is still open");
	fake.dead.add(70);
	reported = [];
	await sleep(700);
	assert.deepEqual(fake.calls.launched, [placeLink(111, 7)]);

	// Studio that never closes: reopen gives up and says so.
	fake.running.push({ pid: 80, placeId: 222 });
	await places.reopen(222, 1, 300);
	await sleep(1000);
	assert.match(places.listed([222])[0].error ?? "", /did not close/);
	assert.equal(fake.calls.launched.length, 1);

	// A close Studio did not take says why, and is not counted as closing.
	fake.running.push({ pid: 90, placeId: 333 }, { pid: 91, placeId: 333 });
	fake.closeAnswers.set(90, "dialog").set(91, "no-window");
	await assert.rejects(places.close(333), (error: Error) => /pid 90: its window is not taking input, as while a dialog is open; Studio pid 91: Windows shows no window for it\)\. Close the dialog in Studio, then try again\.$/.test(error.message));
	fake.closeAnswers.set(90, "failed: timed out").set(91, "gone");
	await assert.rejects(places.reopen(333), /pid 90: asking failed \(timed out\); Studio pid 91: it had already exited\)\. Close it in Studio\.$/);
	assert.ok(!places.listed([333])[0].busy, "a close not taken is not counted as closing");

	// Reopen waits only for the Studio that was asked, and a place whose Studios all exited counts as closed.
	fake.running.push({ pid: 95, placeId: 444 }, { pid: 96, placeId: 444 });
	fake.closeAnswers.set(95, "asked").set(96, "no-window");
	await places.reopen(444, 2, 5000);
	fake.dead.add(95);
	await sleep(700);
	assert.equal(places.listed([444])[0].error ?? null, null, "pid 96 was not waited for");
	assert.ok(fake.calls.launched.length > 1 || places.listed([444])[0].busy !== "reopening", "the reopen went on once the asked Studio exited");
	fake.closeAnswers.set(90, "gone").set(91, "gone");
	await places.close(333);
});

test("SourcemapWatcher pauses after repeated crashes, then retries, and stays stopped once stopped", async () => {
	// node run with rojo's arguments exits at once with an error: a rojo that crashes on start
	const watcher = new SourcemapWatcher(process.execPath, tmpdir(), "x.project.json", { restartMs: 5, pauseMs: 500, maxCrashes: 3 });
	const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 200 && !check(); i++) await sleep(20);
		assert.ok(check(), `timed out: ${watcher.status.detail}`);
	};
	await until(() => watcher.status.state === "error" && /crashed 3 times in a minute, retrying in 1 s/.test(watcher.status.detail));
	assert.match(watcher.status.detail, /: \S/, "keeps the last error line");
	// the pause ends and a fresh budget starts: back to restarting, then paused again
	await until(() => watcher.status.state === "watching");
	await until(() => watcher.status.state === "error");
	watcher.stop();
	const stoppedAt = watcher.status.detail;
	await sleep(700);
	assert.equal(watcher.status.detail, stoppedAt, "no restart after stop");
});

/* ---------- structured answers (spec 011, design 3) ---------- */

type Schema = { type?: string | string[]; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[] };

/** A tiny JSON Schema checker: type (also as an array, for nullable), required, enum, properties, items, anyOf. Returns the problems found. */
function check(value: unknown, schema: Schema, at = "$"): string[] {
	if (schema.anyOf) return schema.anyOf.some((option) => check(value, option, at).length === 0) ? [] : [`${at}: matches none of anyOf`];
	const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
	const allowed = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (allowed && !allowed.some((type) => type === kind || (type === "number" && kind === "integer"))) return [`${at}: ${kind} is not ${allowed.join("|")}`];
	if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${String(value)} is not one of ${schema.enum.join(", ")}`];
	const problems: string[] = [];
	if (kind === "object") {
		const object = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key}: missing`);
		for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in object) problems.push(...check(object[key], sub, `${at}.${key}`));
	}
	if (kind === "array" && schema.items) (value as unknown[]).forEach((entry, index) => problems.push(...check(entry, schema.items!, `${at}[${index}]`)));
	return problems;
}

/** A schema is itself well formed: legal types, non-empty enums, required names declared. */
function wellFormed(schema: Schema, at: string): void {
	const legal = ["object", "array", "string", "integer", "number", "boolean", "null"];
	for (const type of schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]) assert.ok(legal.includes(type), `${at}: type ${type}`);
	if (schema.enum) assert.ok(schema.enum.length > 0, `${at}: enum`);
	for (const key of schema.required ?? []) assert.ok(key in (schema.properties ?? {}), `${at} requires ${key}, which it declares`);
	for (const [key, sub] of Object.entries(schema.properties ?? {})) wellFormed(sub, `${at}.${key}`);
	if (schema.items) wellFormed(schema.items, `${at}[]`);
	for (const option of schema.anyOf ?? []) wellFormed(option, `${at}|`);
}

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-struct-"));
	const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
	run("init", "-q", "-b", "main");
	writeFileSync(join(dir, "default.project.json"), "{}");
	run("add", ".");
	run("commit", "-q", "-m", "one");
	run("branch", "side");
	return dir;
}

/** What a stub hub answers about shared places (spec 014) when its projects share none. */
const noSharing = {
	requestProjects: () => [] as { id: string; projectName: string; listed: number[] }[],
	placeHolder: (): string | null => null,
	requests: { pendingFor: (): unknown => null, outcomeFor: (): unknown => null, against: (): unknown[] => [], dropAsker: (): void => undefined },
};

/** A hub with one running project serving `repo`, enough for status, serve_here and switch to answer. */
function stubHub(repo: string, claim: { key: string; label: string; until: number } | null) {
	const slot = {
		id: "game",
		projectName: "Game",
		repoPath: repo,
		projectFile: "default.project.json",
		projectFiles: ["default.project.json"],
		port: 34900,
		portSource: "hash",
		state: "running",
		connections: 1,
		target: { kind: "worktree", path: repo },
		targetLabel: "main",
		branch: "main",
		mode: "native",
		warnings: ["a warning"],
		error: null,
		sessionId: "session",
		logFile: "",
		targetsAt: 0,
		sourcemap: { state: "watching", detail: "kept current" },
		claim: null,
		places: [{ placeId: 111, placeName: "Lobby", pluginVersion: "0.21.0" }],
		listedPlaces: [{ placeId: 111, placeName: "Lobby", open: true, busy: null, error: null }],
	};
	const open = [
		{ key: "111", placeId: 111, placeName: "Lobby", unsaved: false, pluginVersion: "0.21.0", status: "ok", message: "", projectId: "game", reason: "servePlaceIds", assigned: null, syncedWith: "Game", confirming: false },
		{ key: "studio:1", placeId: 0, placeName: "Untitled", unsaved: true, pluginVersion: "0.21.0", status: "ok", message: "no project", projectId: "game", reason: null, assigned: null, syncedWith: null, confirming: true },
	];
	let held = claim;
	const hub = {
		list: () => [slot],
		claimOf: () => held,
		ackNotes: () => undefined,
		claimMinutes: 15,
		claimUntil: () => Date.now() + 15 * 60_000,
		// the real release, run against the stub's own claims and requests
		releaseClaim: Hub.prototype.releaseClaim,
		setClaim: (_id: string, next: typeof claim) => void (held = next),
		view: () => slot,
		registry: { get: () => slot, slots: [slot] },
		studio: { places: () => open, unappliedOn: () => [{ placeId: 111, placeName: "Lobby", total: 2, items: ["a", "b"] }] },
		...noSharing,
		openPlacesOn: false,
		crashedAt: () => 0,
		switch: async () => slot,
		home: mkdtempSync(join(tmpdir(), "rojo-hub-home-")),
		setupFor: () => null,
		setupJobs: { running: () => null, all: () => [] },
	};
	return { hub, slot };
}

test("structured answers: every outputSchema is well formed JSON Schema", () => {
	const withSchema = TOOLS.filter((tool) => tool.outputSchema);
	assert.deepEqual(withSchema.map((tool) => tool.name).sort(), ["ensure", "request_place", "serve_here", "status", "switch", "version"]);
	for (const tool of withSchema) wellFormed(tool.outputSchema as Schema, tool.name);
	assert.deepEqual(check({ a: 1 }, { type: "object", required: ["b"], properties: { a: { type: "string" } } }), ["$.b: missing", "$.a: integer is not string"], "the checker itself finds both kinds of mistake");
	assert.deepEqual(check(null, { type: ["string", "null"] }), []);
	assert.equal(check("x", { type: "string", enum: ["y"] }).length, 1);
});

test("structured answers: status, serve_here and switch answers match their schemas; the text is the same with or without", async () => {
	const repo = tempRepo();
	const { hub } = stubHub(repo, { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 });
	const mcp = new Mcp(hub as never);
	type Result = { result: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } };
	const call = (name: string, args: object, protocol?: string) => mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, protocol) as Promise<Result>;
	const schemaOf = (name: string) => TOOLS.find((tool) => tool.name === name)!.outputSchema as Schema;

	const status = await call("status", { path: repo }, "2025-06-18");
	const data = status.result.structuredContent!;
	assert.ok(data, "a 2025-06-18 client gets structuredContent");
	assert.deepEqual(check(data, schemaOf("status")), []);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const project = (data.projects as any[])[0];
	assert.equal(project.served.path, repo);
	assert.equal(project.served.branch, "main");
	assert.match(project.served.commit, /^[0-9a-f]{40}$/);
	assert.equal(project.claim.holder, "Other");
	assert.equal(project.claim.yours, false);
	assert.ok(project.claim.secondsLeft > 100 && project.claim.secondsLeft <= 120);
	assert.deepEqual(project.places.map((place: { placeId: number }) => place.placeId), [111]);
	assert.deepEqual(project.connecting, [{ placeId: 0, name: "Untitled", confirming: true }]);
	assert.equal(project.yourWorktreeServed, true);
	assert.equal(data.yourProject, "game");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	assert.equal(((await call("status", {}, "2025-06-18")).result.structuredContent!.projects as any[])[0].yourWorktreeServed, null, "null without a path");

	const plain = await call("status", { path: repo });
	assert.equal(plain.result.structuredContent, undefined, "no header: no structuredContent");
	assert.equal(Object.keys(plain.result).join(), "content", "no header: exactly the old shape");
	assert.equal(plain.result.content[0].text, status.result.content[0].text, "the text is the same");
	assert.equal((await call("status", { path: repo }, "2025-03-26")).result.structuredContent, undefined, "an older protocol gets none");

	const served = await call("serve_here", { path: repo, force: true }, "2025-11-25");
	assert.ok(!served.result.isError, served.result.content[0].text);
	const switched = served.result.structuredContent!;
	assert.deepEqual(check(switched, schemaOf("serve_here")), []);
	assert.equal(switched.switched, false, "it already served this worktree");
	assert.deepEqual(switched.problems, ["a warning"]);
	assert.deepEqual(switched.unapplied, [{ placeId: 111, placeName: "Lobby", total: 2, items: ["a", "b"] }]);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	assert.equal((switched.project as any).claim.yours, true, "serve_here took the claim");
	assert.match(served.result.content[0].text, /now serves/);

	const named = await call("switch", { target: repo, project: "Game", force: true }, "2025-06-18");
	assert.ok(!named.result.isError, named.result.content[0].text);
	assert.deepEqual(check(named.result.structuredContent, schemaOf("switch")), []);

	const empty = (await new Mcp({ ...hub, list: () => [] } as never).handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }, "2025-06-18")) as { result: { structuredContent: { projects: unknown[] } } };
	assert.deepEqual(empty.result.structuredContent.projects, []);
});

test("structured answers: tools/list carries outputSchema only for 2025-06-18 or later", async () => {
	const mcp = new Mcp(null as never);
	const list = async (protocol?: string) => ((await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, protocol)) as { result: { tools: { name: string; outputSchema?: unknown }[] } }).result.tools;
	assert.ok((await list("2025-06-18")).find((tool) => tool.name === "status")!.outputSchema);
	assert.ok((await list("2026-01-01")).find((tool) => tool.name === "status")!.outputSchema);
	for (const protocol of [undefined, "2025-03-26", "2024-11-05", "garbage"]) {
		const tools = await list(protocol);
		assert.ok(tools.every((tool) => !("outputSchema" in tool)), `${String(protocol)}: none`);
		assert.equal(JSON.stringify(tools), JSON.stringify(TOOLS.map(({ outputSchema: _unused, ...tool }) => tool)), `${String(protocol)}: the old shape, byte for byte`);
	}
});

test("revParse: a worktree's HEAD, a branch ref, and null on failure", async () => {
	const repo = tempRepo();
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	assert.equal(await revParse(repo, "HEAD"), head);
	assert.equal(await revParse(repo, "refs/heads/side"), head);
	assert.equal(await revParse(repo, "refs/heads/missing"), null, "an unknown ref");
	assert.equal(await revParse(join(repo, "nowhere"), "HEAD"), null, "a folder that is not there");
	assert.equal(await revParse(mkdtempSync(join(tmpdir(), "rojo-hub-nogit-")), "HEAD"), null, "not a repo");
});

/*
	ensure (spec 011, design 2) against a hub stub whose project can be stopped,
	whose places come and go, and which counts what was started and opened.
*/
type ListedStub = { placeId: number; placeName: string | null; open: boolean; busy?: null; error?: null };
function ensureStub(repo: string, over: { state?: string; listed?: ListedStub[]; openPlacesOn?: boolean; claim?: { key: string; label: string; until: number } | null } = {}) {
	const slot: Record<string, any> = {
		id: "game",
		projectName: "Game",
		repoPath: repo,
		projectFile: "default.project.json",
		projectFiles: ["default.project.json"],
		port: 34900,
		portSource: "hash",
		state: over.state ?? "stopped",
		connections: 0,
		target: { kind: "branch", ref: "refs/heads/side" },
		targetLabel: "side",
		branch: "side",
		mode: "native",
		warnings: [],
		error: null,
		sessionId: null,
		logFile: "",
		targetsAt: 0,
		sourcemap: { state: "off", detail: "off" },
		claim: null,
		places: [],
		listedPlaces: over.listed ?? [{ placeId: 111, placeName: "Lobby", open: false, busy: null, error: null }],
	};
	let held = over.claim ?? null;
	const open: Record<string, any>[] = [];
	const calls = { start: 0, openPlace: [] as number[], switch: 0 };
	const behave: { start: () => void; openPlace: (placeId: number) => void } = {
		start: () => void (slot.state = "running"),
		openPlace: (placeId) => void setTimeout(() => void (slot.places = [{ placeId, placeName: "Lobby", pluginVersion: "0.21.0" }]), 100),
	};
	const hub = {
		list: () => [slot],
		claimOf: () => held,
		ackNotes: () => undefined,
		claimMinutes: 15,
		claimUntil: () => Date.now() + 15 * 60_000,
		// the real release, run against the stub's own claims and requests
		releaseClaim: Hub.prototype.releaseClaim,
		lapsedClaim: () => null,
		setClaim: (_id: string, next: typeof held) => void (held = next),
		view: () => slot,
		registry: { get: () => slot, slots: [slot] },
		studio: { places: () => open, unappliedOn: () => [] },
		...noSharing,
		openPlacesOn: over.openPlacesOn ?? true,
		crashedAt: () => 0,
		home: mkdtempSync(join(tmpdir(), "rojo-hub-home-")),
		setupFor: (): unknown => null,
		setupRefusal: async (): Promise<string | null> => null,
		setupWorktree: async (..._args: unknown[]): Promise<unknown> => null,
		setupJobs: { running: (): unknown => null, all: () => [] as unknown[] },
		start: async () => {
			calls.start++;
			behave.start();
			return slot;
		},
		switch: async (_id: string, target: object) => {
			calls.switch++;
			slot.target = target;
			return slot;
		},
		openPlace: async (_id: string, placeId: number) => {
			calls.openPlace.push(placeId);
			behave.openPlace(placeId);
			return { placeId, placeName: "Lobby", outcome: "opened" };
		},
	};
	return { hub, slot, open, calls, behave };
}

type EnsureResult = { content: { text: string }[]; structuredContent: any; isError?: boolean };
const ensureCall = async (stub: ReturnType<typeof ensureStub>, args: object, protocol: string | undefined = "2025-06-18") =>
	((await new Mcp(stub.hub as never).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ensure", arguments: args } }, protocol)) as { result: EnsureResult }).result;
const allStepsOf = (result: EnsureResult) => result.structuredContent.steps.map((step: any) => `${step.step}:${step.outcome}`);
/** The steps without versions (spec 015), which the older ensure tests do not look at. */
const stepsOf = (result: EnsureResult) => allStepsOf(result).filter((step: string) => !step.startsWith("versions:"));

test("ensure: stopped project, unserved worktree, closed place: does everything, a second call finds it all done", async () => {
	const repo = tempRepo();
	const stub = ensureStub(repo);
	const { hub, slot, calls } = stub;
	const mcp = new Mcp(hub as never);
	const schema = TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema;

	const first = await ensureCall(stub, { path: repo });
	assert.ok(!first.isError, first.content[0].text);
	assert.deepEqual(check(first.structuredContent, schema), []);
	assert.equal(first.structuredContent.ready, true);
	assert.deepEqual(first.structuredContent.placeIds, [111]);
	assert.deepEqual(stepsOf(first), ["start:done", "serve:done", "open_place:done", "wait_for_studio:done"]);
	assert.equal(first.structuredContent.failure, null);
	assert.equal(first.structuredContent.project.yourWorktreeServed, true);
	assert.match(first.content[0].text, /^Ready\./);
	assert.equal(calls.start, 1);
	assert.equal(calls.switch, 1);
	assert.deepEqual(calls.openPlace, [111]);

	const second = await ensureCall(stub, { path: repo });
	assert.ok(!second.isError, second.content[0].text);
	assert.deepEqual(stepsOf(second), ["start:already", "serve:already", "open_place:already", "wait_for_studio:already"]);
	assert.equal(second.structuredContent.ready, true);
	assert.deepEqual([calls.start, calls.switch, calls.openPlace.length], [1, 1, 1], "nothing was repeated");
	assert.equal(slot.state, "running");

	const plain = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ensure", arguments: { path: repo } } })) as { result: Record<string, unknown> };
	assert.deepEqual(Object.keys(plain.result), ["content"], "a client without the header gets text only");
});

/* ---------- ensure: install checks and the setup step (spec 012, design 2) ---------- */

function wallyRepo(): string {
	const repo = tempRepo();
	writeFileSync(join(repo, "wally.toml"), `[package]\nname = "a/b"\n[dependencies]\nRoact = "a/roact@1"\n`);
	return repo;
}
const okOutcome = (worktree: string) => ({ ok: true, steps: [{ index: 1, of: 1, text: "wally install", state: "ok", seconds: 0.1 }], failed: null, worktree, branch: null });

test("ensure: checks and warnings never change ready; with no setup configured a missing Packages is only a warning", async () => {
	const repo = wallyRepo();
	const stub = ensureStub(repo);
	const result = await ensureCall(stub, { path: repo });
	assert.ok(!result.isError, result.content[0].text);
	assert.equal(result.structuredContent.ready, true);
	assert.deepEqual(check(result.structuredContent, TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema), []);
	const byName = Object.fromEntries(result.structuredContent.checks.map((entry: any) => [entry.name, entry]));
	assert.deepEqual(Object.keys(byName).sort(), ["node_modules", "packages", "rojo", "sourcemap"]);
	assert.equal(byName.packages.ok, false);
	assert.equal(byName.node_modules.ok, true);
	assert.ok(result.structuredContent.warnings.some((line: string) => line.startsWith("packages: Packages missing")));
	assert.match(result.content[0].text, /warning: packages: Packages missing/);
	assert.deepEqual(stepsOf(result), ["start:done", "serve:done", "open_place:done", "wait_for_studio:done"], "no setup step without an entry");
});

test("ensure: runs the repo's setup for a worktree whose packages are missing, before the claim; not when the checks are ok", async () => {
	const repo = wallyRepo();
	const stub = ensureStub(repo);
	const events: string[] = [];
	const hub = stub.hub as any;
	hub.setupFor = () => ({ commands: [{ command: "wally", args: ["install"], timeoutSeconds: 600 }] });
	hub.setupWorktree = async (_id: string, worktree: string) => {
		events.push(`setup(switch calls so far: ${stub.calls.switch})`);
		mkdirSync(join(worktree, "Packages"));
		return { job: { step: 1, of: 1, text: "wally install" }, outcome: okOutcome(worktree), joined: false };
	};
	const first = await ensureCall(stub, { path: repo });
	assert.ok(!first.isError, first.content[0].text);
	assert.deepEqual(stepsOf(first), ["start:done", "setup:done", "serve:done", "open_place:done", "wait_for_studio:done"]);
	assert.deepEqual(events, ["setup(switch calls so far: 0)"], "setup ran before the serve step took the claim");
	assert.match(first.structuredContent.steps[1].detail, /wally install/);
	assert.deepEqual(first.structuredContent.warnings, first.structuredContent.warnings.filter((line: string) => !line.startsWith("packages")), "the checks were taken again after setup");
	assert.equal(first.structuredContent.checks.find((entry: any) => entry.name === "packages").ok, true);
	// a second call: the checks pass, so nothing runs
	const second = await ensureCall(stub, { path: repo });
	assert.deepEqual(stepsOf(second), ["start:already", "serve:already", "open_place:already", "wait_for_studio:already"]);
	assert.equal(events.length, 1);
});

test("ensure: setup is skipped, with the reason, for a worktree a running rojo has read, and a broken entry is reported", async () => {
	const repo = wallyRepo();
	const served = ensureStub(repo);
	let ran = 0;
	const hub = served.hub as any;
	hub.setupFor = () => ({ commands: [{ command: "wally", args: ["install"], timeoutSeconds: 600 }] });
	hub.setupRefusal = async () => "the worktree is being served (or was, since Rojo started); stop the project to install, or install by hand.";
	hub.setupWorktree = async () => void ran++;
	const result = await ensureCall(served, { path: repo });
	assert.ok(!result.isError, result.content[0].text);
	assert.equal(ran, 0, "nothing was run");
	assert.deepEqual(stepsOf(result), ["start:done", "setup:skipped", "serve:done", "open_place:done", "wait_for_studio:done"]);
	assert.match(result.structuredContent.steps[1].detail, /being served/);
	assert.ok(result.structuredContent.warnings.some((line: string) => line.startsWith("packages:")), "the missing packages are still reported");
	assert.equal(result.structuredContent.ready, true);

	const broken = ensureStub(repo);
	(broken.hub as any).setupFor = () => ({ problem: "rojoHub.setupCommands for X is invalid, so no setup was run: cwd must not contain \"..\"." });
	const answer = await ensureCall(broken, { path: repo });
	assert.deepEqual(stepsOf(answer).slice(0, 2), ["start:done", "setup:skipped"]);
	assert.match(answer.structuredContent.steps[1].detail, /invalid/);
});

test("ensure: a failed setup is setup_failed (project started, nothing served); a slow one is setup_running", async () => {
	const repo = wallyRepo();
	const schema = TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema;
	const failedStub = ensureStub(repo);
	const hub = failedStub.hub as any;
	hub.setupFor = () => ({ commands: [{ command: "wally", args: ["install"], timeoutSeconds: 600 }] });
	const failed = { index: 1, of: 1, text: "wally install", state: "failed", exitCode: 1, reason: "exit", seconds: 0.2, tail: "no network" };
	hub.setupWorktree = async (_id: string, worktree: string) => ({ job: {}, joined: false, outcome: { ok: false, steps: [failed], failed, worktree, branch: null } });
	const result = await ensureCall(failedStub, { path: repo });
	assert.ok(result.isError);
	assert.deepEqual(check(result.structuredContent, schema), []);
	assert.equal(result.structuredContent.failure.reason, "setup_failed");
	assert.match(result.structuredContent.failure.message, /wally install/);
	assert.match(result.structuredContent.failure.message, /no network/);
	assert.deepEqual(stepsOf(result), ["start:done", "setup:failed"]);
	assert.equal(failedStub.calls.switch, 0, "nothing was served");
	assert.equal(failedStub.calls.start, 1, "the project was started");
	// a second ensure runs it again while the checks still fail
	let again = 0;
	hub.setupWorktree = async (_id: string, worktree: string) => (again++, { job: {}, joined: false, outcome: { ok: false, steps: [failed], failed, worktree, branch: null } });
	await ensureCall(failedStub, { path: repo });
	assert.equal(again, 1);

	const slowStub = ensureStub(repo);
	const slowHub = slowStub.hub as any;
	slowHub.setupFor = () => ({ commands: [{ command: "wally", args: ["install"], timeoutSeconds: 600 }] });
	slowHub.setupWorktree = async () => ({ job: { step: 2, of: 3, text: "npm ci" }, joined: true, outcome: null });
	const slow = await ensureCall(slowStub, { path: repo });
	assert.ok(slow.isError);
	assert.equal(slow.structuredContent.failure.reason, "setup_running");
	assert.match(slow.structuredContent.failure.message, /command 2 of 3: npm ci/);
	assert.match(slow.structuredContent.failure.message, /ensure again/);
	assert.equal(slowStub.calls.switch, 0);
});

test("ensure: a setup job already running is joined even when the checks pass", async () => {
	const repo = tempRepo();
	const stub = ensureStub(repo);
	const hub = stub.hub as any;
	hub.setupJobs.running = () => ({ step: 1, of: 2, text: "wally install" });
	let joined = 0;
	hub.setupWorktree = async (_id: string, worktree: string) => (joined++, { job: {}, joined: true, outcome: okOutcome(worktree) });
	const result = await ensureCall(stub, { path: repo });
	assert.equal(joined, 1);
	assert.match(result.structuredContent.steps[1].detail, /joined the running setup/);
});

test("ensure: the failure table, each reason with its steps, as isError answers carrying data", async () => {
	const repo = tempRepo();
	const schema = TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema;
	const run = async (stub: ReturnType<typeof ensureStub>, args: object = {}) => {
		const result = await ensureCall(stub, { path: repo, ...args });
		const data = result.structuredContent;
		assert.ok(result.isError, "a failure is an error result");
		assert.deepEqual(check(data, schema), [], data.failure?.reason);
		assert.equal(data.ready, false);
		assert.ok(data.failure.message.length > 0);
		return { data, outcomes: stepsOf(result), reason: data.failure.reason as string };
	};

	// no_project: a repo nobody registered, and no path
	const stranger = ensureStub(repo);
	stranger.hub.list = () => [];
	let result = await run(stranger);
	assert.equal(result.reason, "no_project");
	assert.deepEqual(result.outcomes, []);
	assert.equal(result.data.project, null);
	assert.equal((await run(ensureStub(repo), { path: "" })).reason, "no_project");

	// start_failed: start throws
	const broken = ensureStub(repo);
	broken.behave.start = () => {
		throw new Error("rojo is not installed");
	};
	result = await run(broken);
	assert.equal(result.reason, "start_failed");
	assert.deepEqual(result.outcomes, ["start:failed"]);
	assert.match(result.data.failure.message, /Nothing was served/);
	assert.equal(broken.calls.switch, 0);

	// start_failed: error after settling
	const errored = ensureStub(repo);
	errored.behave.start = () => {
		errored.slot.state = "error";
		errored.slot.error = "bad project file";
	};
	result = await run(errored);
	assert.equal(result.reason, "start_failed");
	assert.match(result.data.failure.message, /bad project file/);
	assert.equal(errored.calls.switch, 0);

	// claimed: another worktree holds it; the start step stays done
	const claimed = ensureStub(repo, { claim: { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 } });
	result = await run(claimed);
	assert.equal(result.reason, "claimed");
	assert.deepEqual(result.outcomes, ["start:done", "serve:failed"]);
	assert.match(result.data.failure.message, /Other/);
	assert.equal(claimed.calls.switch, 0, "not switched");
	assert.equal(result.data.project.rojo.state, "running", "the start was not rolled back");

	// rojo_error: after the switch Rojo reports an error
	const rojoError = ensureStub(repo);
	rojoError.hub.switch = async (_id: string, target: object) => {
		rojoError.slot.target = target;
		rojoError.slot.error = "Invalid project file";
		return rojoError.slot;
	};
	result = await run(rojoError);
	assert.equal(result.reason, "rojo_error");
	assert.deepEqual(result.outcomes, ["start:done", "serve:done"]);
	assert.match(result.data.failure.message, /Invalid project file/);

	// open_places_off: returns at once, never opens
	const off = ensureStub(repo, { openPlacesOn: false });
	result = await run(off);
	assert.equal(result.reason, "open_places_off");
	assert.deepEqual(result.outcomes, ["start:done", "serve:done", "open_place:skipped"]);
	assert.deepEqual(off.calls.openPlace, []);
	assert.match(result.data.failure.message, /Lobby/);

	// no_listed_places
	result = await run(ensureStub(repo, { listed: [] }));
	assert.equal(result.reason, "no_listed_places");
	assert.deepEqual(result.outcomes, ["start:done", "serve:done", "open_place:skipped"]);
	const notListed = ensureStub(repo);
	assert.equal((await run(notListed, { place: 999 })).reason, "no_listed_places", "a place that is not listed");
	assert.deepEqual(notListed.calls.openPlace, []);

	// several_places: opens none
	const several = ensureStub(repo, {
		listed: [
			{ placeId: 111, placeName: "Lobby", open: false },
			{ placeId: 222, placeName: "Match", open: false },
		],
	});
	result = await run(several);
	assert.equal(result.reason, "several_places");
	assert.deepEqual(several.calls.openPlace, []);
	assert.match(result.data.failure.message, /Lobby.*Match/);

	// open_failed
	const noOpen = ensureStub(repo);
	noOpen.hub.openPlace = async () => {
		throw new Error("Studio would not launch");
	};
	result = await run(noOpen);
	assert.equal(result.reason, "open_failed");
	assert.deepEqual(result.outcomes, ["start:done", "serve:done", "open_place:failed"]);
	assert.match(result.data.failure.message, /Studio would not launch/);

	// studio_confirming: a place that connected waits for the user
	const confirming = ensureStub(repo);
	confirming.behave.openPlace = () => {
		confirming.open.push({ key: "k", placeId: 111, placeName: "Lobby", unsaved: false, pluginVersion: "0.21.0", status: "ok", message: "", projectId: "game", reason: null, assigned: null, syncedWith: null, confirming: true });
	};
	result = await run(confirming);
	assert.equal(result.reason, "studio_confirming");
	assert.deepEqual(result.outcomes, ["start:done", "serve:done", "open_place:done", "wait_for_studio:failed"]);
	assert.equal(result.data.project.connecting[0].confirming, true);

	// stopped: someone stops the project during the wait
	const stopped = ensureStub(repo);
	stopped.behave.openPlace = () => void setTimeout(() => void (stopped.slot.state = "stopped"), 100);
	result = await run(stopped);
	assert.equal(result.reason, "stopped");
	assert.match(result.data.failure.message, /files were switched/);

	// timeout: the place opens and connects but never syncs (the minimum wait is 5 s)
	const slow = ensureStub(repo);
	slow.behave.openPlace = () => {
		slow.open.push({ key: "k", placeId: 111, placeName: "Lobby", unsaved: false, pluginVersion: "0.21.0", status: "ok", message: "", projectId: "game", reason: null, assigned: null, syncedWith: null, confirming: false });
	};
	result = await run(slow, { timeout: 1 });
	assert.equal(result.reason, "timeout");
	assert.match(result.data.failure.message, /Lobby/);
	assert.deepEqual(result.outcomes, ["start:done", "serve:done", "open_place:done", "wait_for_studio:failed"]);
});

test("ensure: openPlaces off with a place already synced or open needs no opening", async () => {
	const repo = tempRepo();
	const synced = ensureStub(repo, { state: "running", openPlacesOn: false });
	synced.slot.places = [{ placeId: 111, placeName: "Lobby", pluginVersion: "0.21.0" }];
	const result = await ensureCall(synced, { path: repo });
	assert.ok(!result.isError);
	assert.deepEqual(stepsOf(result), ["start:already", "serve:done", "open_place:already", "wait_for_studio:already"]);
	assert.deepEqual(synced.calls.openPlace, []);

	const opened = ensureStub(repo, { state: "running", openPlacesOn: false, listed: [{ placeId: 111, placeName: "Lobby", open: true }] });
	setTimeout(() => void (opened.slot.places = [{ placeId: 111, placeName: "Lobby", pluginVersion: "0.21.0" }]), 2500);
	const waited = await ensureCall(opened, { path: repo });
	assert.ok(!waited.isError, JSON.stringify(waited.structuredContent.failure));
	assert.deepEqual(stepsOf(waited), ["start:already", "serve:done", "open_place:already", "wait_for_studio:done"]);
	assert.deepEqual(opened.calls.openPlace, []);
});

/* ---------- handoff: then_return (spec 013) ---------- */

/** A real Hub with one running slot serving `held`, whose switches are recorded instead of made. */
function handHub(held: string) {
	const hub = new Hub(mkdtempSync(join(tmpdir(), "rojo-hub-handoff-")));
	const slot = { id: "game", projectName: "Game", target: { kind: "worktree", path: held } as { kind: "worktree"; path: string } };
	const internals = hub as unknown as { registry: unknown; runtime(id: string): { state: string }; switchLocked(s: unknown, t: typeof slot.target): Promise<void> };
	internals.registry = { get: () => slot, slots: [slot], save() {} };
	internals.runtime("game").state = "running";
	const switches: string[] = [];
	internals.switchLocked = async (_s, target) => {
		switches.push(target.path);
		slot.target = target;
	};
	return { hub, slot, switches };
}

const workKey = (path: string) => `worktree:${pathKey(path)}`;

test("handoff: a release switches back to what was served, once, and only if it still serves the claim's target", async () => {
	const before = mkdtempSync(join(tmpdir(), "rojo-hub-before-"));
	const mine = mkdtempSync(join(tmpdir(), "rojo-hub-mine-"));
	const { hub, slot, switches } = handHub(mine);
	const claim = { key: workKey(mine), label: "mine", until: Date.now() + 60_000, returnTo: { target: { kind: "worktree" as const, path: before }, label: "before" } };
	hub.setClaim("game", claim);
	assert.deepEqual(await hub.handBack("game", claim, "release"), { returned: true, label: "before" });
	assert.deepEqual(switches, [before]);

	// it no longer serves the claim's target: left alone
	const again = await hub.handBack("game", claim, "release");
	assert.equal(again.returned, false);
	assert.deepEqual(switches, [before], "no second switch");

	// a claim with no return does nothing
	slot.target = { kind: "worktree", path: mine };
	assert.equal((await hub.handBack("game", { ...claim, returnTo: undefined }, "release")).returned, false);
});

test("handoff: not to a worktree folder that is gone, and not when the slot is stopped", async () => {
	const mine = mkdtempSync(join(tmpdir(), "rojo-hub-mine-"));
	const gone = join(tmpdir(), "rojo-hub-gone-" + Date.now());
	const { hub, switches } = handHub(mine);
	const claim = { key: workKey(mine), label: "mine", until: Date.now() + 60_000, returnTo: { target: { kind: "worktree" as const, path: gone }, label: "gone" } };
	hub.setClaim("game", claim);
	const missing = await hub.handBack("game", claim, "release");
	assert.equal(missing.returned, false);
	assert.match((missing as { why: string }).why, /no longer exists/);

	const exists = { ...claim, returnTo: { target: { kind: "worktree" as const, path: tmpdir() }, label: "tmp" } };
	(hub as unknown as { runtime(id: string): { state: string } }).runtime("game").state = "stopped";
	const stopped = await hub.handBack("game", exists, "release");
	assert.match((stopped as { why: string }).why, /not serving/);
	assert.deepEqual(switches, [], "nothing was switched");
});

test("handoff: a claim that runs out gives the project back by itself, unless someone took it since", async () => {
	const before = mkdtempSync(join(tmpdir(), "rojo-hub-before-"));
	const mine = mkdtempSync(join(tmpdir(), "rojo-hub-mine-"));
	const { hub, slot, switches } = handHub(mine);
	const tick = () => (hub as unknown as { returnLapsed(): void }).returnLapsed();
	const settle = () => new Promise((done) => setTimeout(done, 20));
	const expired = (path: string) => ({ key: workKey(path), label: "mine", until: Date.now() - 1, returnTo: { target: { kind: "worktree" as const, path: before }, label: "before" } });

	hub.setClaim("game", { ...expired(mine), until: Date.now() + 60_000 });
	tick();
	await settle();
	assert.deepEqual(switches, [], "a claim still running is not returned");

	hub.setClaim("game", expired(mine));
	tick();
	await settle();
	assert.deepEqual(switches, [before], "returned when the claim ran out");
	tick();
	await settle();
	assert.deepEqual(switches, [before], "and only once");
	assert.equal(hub.lapsedClaim("game")?.returnTo, undefined);

	// taken by another agent since: the other claim is live, so nothing is switched
	slot.target = { kind: "worktree", path: mine };
	const other = mkdtempSync(join(tmpdir(), "rojo-hub-other-"));
	const lapsed = expired(mine);
	hub.setClaim("game", { key: workKey(other), label: "other", until: Date.now() + 60_000 });
	const taken = await hub.handBack("game", lapsed, "expiry");
	assert.equal(taken.returned, false);
	assert.match((taken as { why: string }).why, /other/);
	assert.deepEqual(switches, [before]);
});

test("handoff: the return survives a service restart, even one that outlasts the claim", () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-handoff-home-"));
	const first = new Hub(home);
	const returnTo = { target: { kind: "branch" as const, ref: "main" }, label: "main" };
	first.setClaim("game", { key: "worktree:x", label: "x", until: Date.now() - 5, returnTo });
	first.setClaim("live", { key: "worktree:y", label: "y", until: Date.now() + 60_000, returnTo });
	first.setClaim("plain", { key: "worktree:z", label: "z", until: Date.now() - 5 });
	const second = new Hub(home);
	assert.deepEqual(second.claimOf("live")?.returnTo, returnTo);
	assert.deepEqual(second.lapsedClaim("game")?.returnTo, returnTo, "a claim that ran out while the service was down still returns");
	assert.equal(second.lapsedClaim("plain"), null, "one without a return is dropped as before");
});

test("handoff: serve_here with then_return records what was served; release switches back and says so", async () => {
	const repo = tempRepo();
	const tree = join(tmpdir(), "rojo-hub-wt-" + Date.now());
	execFileSync("git", ["worktree", "add", "-q", "-b", "feat", tree], { cwd: repo, stdio: "pipe" });
	const { hub } = stubHub(repo, null);
	const handBacks: string[] = [];
	const wired = { ...hub, handBack: async (_id: string, claim: { returnTo?: { label: string } }) => (handBacks.push(claim.returnTo?.label ?? "?"), { returned: true, label: claim.returnTo?.label ?? "?" }) };
	const mcp = new Mcp(wired as never);
	type Result = { result: { content: { text: string }[]; structuredContent?: { project?: { claim?: { thenReturn: string | null } } } } };
	const call = (name: string, args: object) => mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "2025-06-18") as Promise<Result>;

	const plain = await call("serve_here", { path: tree });
	assert.ok(!plain.result.content[0].text.includes("switches back"), "without then_return nothing is promised");
	await call("release", { path: tree });
	assert.deepEqual(handBacks, []);

	const served = await call("serve_here", { path: tree, then_return: true });
	assert.match(served.result.content[0].text, /switches back to main/);
	assert.equal(served.result.structuredContent?.project?.claim?.thenReturn, "main");
	// a second call keeps the first one's return rather than returning to itself
	const renewed = await call("serve_here", { path: tree });
	assert.match(renewed.result.content[0].text, /switches back to main \(as you asked earlier\)/);
	const released = await call("release", { path: tree });
	assert.deepEqual(handBacks, ["main"]);
	assert.match(released.result.content[0].text, /switched back to main/);
});

test("settings token: made once and kept, matched exactly; omitted yolo and setupCommands keep their saved value", () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-token-"));
	const token = settingsToken(home);
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(settingsToken(home), token, "kept");
	assert.equal(tokenMatches(home, token), true);
	for (const wrong of [undefined, "", "0".repeat(64), token.slice(1), token + "0", 5]) assert.equal(tokenMatches(home, wrong), false);
	savePortSettings(home, { yolo: true, setupCommands: { "C:\Repo": [] } });
	savePortSettings(home, { sourcemaps: false });
	assert.equal(loadPortSettings(home).yolo, true);
	assert.deepEqual(loadPortSettings(home).setupCommands, { "C:\Repo": [] });
	savePortSettings(home, { yolo: false, setupCommands: {} });
	assert.equal(loadPortSettings(home).yolo, false);
	assert.deepEqual(loadPortSettings(home).setupCommands, {});
});

/* ---------- yolo mode (spec 012, design 4) ---------- */

const yoloHome = () => mkdtempSync(join(tmpdir(), "rojo-hub-yolo-"));
const auditLines = (home: string) =>
	readFileSync(join(home, AUDIT_FILE), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, any>);

test("yolo: openPlacesOn is openPlaces or yolo, and yolo is kept in settings.json", () => {
	const cases: [boolean, boolean, boolean][] = [
		[false, false, false],
		[true, false, true],
		[false, true, true],
		[true, true, true],
	];
	for (const [openPlaces, yolo, effective] of cases) {
		const home = yoloHome();
		savePortSettings(home, { openPlaces, yolo });
		const hub = new Hub(home);
		assert.equal(hub.openPlacesOn, effective, `openPlaces ${openPlaces}, yolo ${yolo}`);
		assert.equal(hub.openPlacesSwitchOn, openPlaces);
		assert.equal(hub.yoloOn, yolo);
	}
	assert.equal(new Hub(yoloHome()).yoloOn, false, "off by default");
});

function yoloStub(repo: string, over: { yolo: boolean; claim?: { key: string; label: string; until: number } | null; openPlaces?: boolean }) {
	const { hub, slot } = stubHub(repo, over.claim ?? null);
	const home = yoloHome();
	const stopped: string[] = [];
	const full = {
		...hub,
		home,
		yoloOn: over.yolo,
		openPlacesSwitchOn: over.openPlaces === true,
		openPlacesOn: over.yolo || over.openPlaces === true,
		stop: async (id: string) => void stopped.push(id),
		remove: async (id: string) => void stopped.push(`remove ${id}`),
		openPlace: async (_id: string, placeId: number) => ({ placeId, placeName: "Lobby", outcome: "opened" }),
	};
	return { hub: full, slot, home, stopped };
}
const callTool = async (mcp: Mcp, name: string, args: object, options: { elicit?: boolean } = {}) =>
	((await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "2025-06-18", options)) as { result: { content: { text: string }[]; structuredContent?: any; isError?: boolean; _meta?: any } }).result;

test("yolo: stop is refused for a synced place without it, goes through with it, and a claim still refuses", async () => {
	const repo = tempRepo();
	const off = yoloStub(repo, { yolo: false });
	const refused = await callTool(new Mcp(off.hub as never), "stop", { path: repo });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /synced to/);
	assert.deepEqual(off.stopped, []);

	const on = yoloStub(repo, { yolo: true });
	const stopped = await callTool(new Mcp(on.hub as never), "stop", { path: repo });
	assert.ok(!stopped.isError, stopped.content[0].text);
	assert.deepEqual(on.stopped, ["game"]);
	const removed = await callTool(new Mcp(on.hub as never), "remove_project", { path: repo });
	assert.ok(!removed.isError, removed.content[0].text);

	const claimed = yoloStub(repo, { yolo: true, claim: { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 } });
	const held = await callTool(new Mcp(claimed.hub as never), "stop", { path: repo });
	assert.equal(held.isError, true, "claims hold under yolo");
	assert.match(held.content[0].text, /claimed by an agent/);
	assert.deepEqual(claimed.stopped, []);
});

test("yolo: stop_all needs force without it, and with it skips claimed projects and names them", async () => {
	const fake = (claimed: string[]) => {
		const stopped: string[] = [];
		const slots = ["a", "b", "c"].map((id) => ({ id, projectName: id.toUpperCase() }));
		const hub = {
			registry: { slots, groups: [], save: () => undefined, get: (id: string) => slots.find((slot) => slot.id === id) },
			view: () => ({ state: "running" }),
			stop: async (id: string) => void stopped.push(id),
			claimOf: (id: string) => (claimed.includes(id) ? { key: "worktree:x", label: "x", until: Date.now() + 60_000 } : null),
			claimMinutes: 15,
			claimUntil: () => Date.now() + 15 * 60_000,
			// the real release, run against the stub's own claims and requests
			releaseClaim: Hub.prototype.releaseClaim,
			list: () => slots,
			home: yoloHome(),
			yoloOn: false,
		};
		return { hub, stopped };
	};
	const off = fake(["b"]);
	const refused = await callTool(new Mcp(off.hub as never, new Groups(off.hub as never)), "stop_all", {});
	assert.equal(refused.isError, true);
	assert.deepEqual(off.stopped, []);

	const on = fake(["b"]);
	on.hub.yoloOn = true;
	const answer = await callTool(new Mcp(on.hub as never, new Groups(on.hub as never)), "stop_all", {});
	assert.ok(!answer.isError, answer.content[0].text);
	assert.deepEqual(on.stopped.sort(), ["a", "c"]);
	assert.match(answer.content[0].text, /Kept running because another agent claimed them.*: B\./);

	const forced = fake(["b"]);
	forced.hub.yoloOn = true;
	await callTool(new Mcp(forced.hub as never, new Groups(forced.hub as never)), "stop_all", { force: true });
	assert.deepEqual(forced.stopped.sort(), ["a", "b", "c"], "force is as before");
});

test("yolo: status says so first and carries yolo in its data; ensure carries it too", async () => {
	const repo = tempRepo();
	const schema = TOOLS.find((tool) => tool.name === "status")!.outputSchema as Schema;
	for (const yolo of [false, true]) {
		const { hub } = yoloStub(repo, { yolo });
		const status = await callTool(new Mcp(hub as never), "status", { path: repo });
		assert.equal(status.structuredContent.yolo, yolo);
		assert.deepEqual(check(status.structuredContent, schema), []);
		assert.equal(status.content[0].text.startsWith("Yolo mode is ON:"), yolo);
	}
	const stub = ensureStub(repo);
	(stub.hub as any).yoloOn = true;
	const ensured = await ensureCall(stub, { path: repo });
	assert.equal(ensured.structuredContent.yolo, true);
	assert.deepEqual(check(ensured.structuredContent, TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema), []);
});

test("yolo: state-changing calls are audited with lifted, reads and calls without yolo are not", async () => {
	const repo = tempRepo();
	const on = yoloStub(repo, { yolo: true });
	const mcp = new Mcp(on.hub as never);
	await callTool(mcp, "status", { path: repo });
	await callTool(mcp, "stop", { path: repo });
	await callTool(mcp, "open_place", { path: repo });
	const lines = auditLines(on.home);
	assert.deepEqual(lines.map((line) => line.action), ["stop", "open_place"], "status is a read");
	assert.ok(lines.every((line) => line.actor === "mcp" && line.yolo === true && typeof line.time === "string"));
	assert.equal(lines[0].lifted, true, "the synced place would have refused it");
	assert.equal(lines[1].lifted, true, "openPlaces alone is off");

	const withSwitch = yoloStub(repo, { yolo: true, openPlaces: true });
	await callTool(new Mcp(withSwitch.hub as never), "open_place", { path: repo });
	assert.equal(auditLines(withSwitch.home)[0].lifted, false, "openPlaces alone would have allowed it");

	const claimed = yoloStub(repo, { yolo: true, claim: { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 } });
	await callTool(new Mcp(claimed.hub as never), "stop", { path: repo });
	const refused = auditLines(claimed.home)[0];
	assert.equal(refused.lifted, false);
	assert.equal(refused.outcome, "refused or failed");

	const off = yoloStub(repo, { yolo: false });
	await callTool(new Mcp(off.hub as never), "stop", { path: repo });
	assert.throws(() => readFileSync(join(off.home, AUDIT_FILE)), "nothing is audited while yolo is off");
});

test("audit log: appends lines, rotates at 1 MB, and never throws", () => {
	const home = yoloHome();
	writeAudit(home, { action: "one" });
	writeAudit(home, { action: "two" });
	assert.deepEqual(auditLines(home).map((line) => line.action), ["one", "two"]);
	writeFileSync(join(home, AUDIT_FILE), "x".repeat(AUDIT_MAX_BYTES));
	writeAudit(home, { action: "three" });
	assert.equal(readFileSync(join(home, AUDIT_OLD_FILE), "utf8").length, AUDIT_MAX_BYTES);
	assert.deepEqual(auditLines(home).map((line) => line.action), ["three"]);
	assert.doesNotThrow(() => writeAudit(join(home, "missing", "folder"), { action: "lost" }));
});

/* ---------- place requests (spec 014) ---------- */

/** PlaceRequests over a fake world: two projects listing place 111, held by "b", with a clock to move. */
function requestWorld(over: { holder?: string | null; claims?: Record<string, string> } = {}) {
	const world = {
		holder: over.holder === undefined ? "b" : over.holder,
		assigned: {} as Record<number, string>,
		claims: { a: "worktree:a", ...(over.claims ?? {}) } as Record<string, string>,
		listed: { a: [111], b: [111, 222] } as Record<string, number[]>,
		removed: new Set<string>(),
		clock: 1000,
	};
	const deps: RequestDeps = {
		projects: () => ["a", "b"].filter((id) => !world.removed.has(id)).map((id) => ({ id, projectName: id.toUpperCase(), listed: world.listed[id] })),
		holderOf: () => world.holder,
		assigned: (placeId) => world.assigned[placeId] ?? null,
		assign: (placeId, slotId) => {
			world.assigned[placeId] = slotId;
			world.holder = slotId;
		},
		claimKeyOf: (id) => world.claims[id] ?? null,
		now: () => world.clock,
	};
	return { world, requests: new PlaceRequests(deps) };
}

test("shared places: the projects listing a place are found", () => {
	const projects = [
		{ id: "a", projectName: "A", listed: [111] },
		{ id: "b", projectName: "B", listed: [111, 222] },
		{ id: "c", projectName: "C", listed: [] },
	];
	assert.deepEqual(listersOf(projects, 111).map((project) => project.id), ["a", "b"]);
	assert.deepEqual(listersOf(projects, 222).map((project) => project.id), ["b"]);
	assert.deepEqual(listersOf(projects, 333), []);
});

test("shared places: the place stays with the project it last synced with, whether the rival is running or not", () => {
	const candidate = (slotId: string, state: "running" | "stopped"): PlaceCandidate => ({
		slotId,
		projectName: slotId.toUpperCase(),
		port: slotId === "a" ? 1 : 2,
		state,
		sessionId: state === "running" ? slotId : null,
		branch: null,
		targetLabel: "main",
		rojoVersion: "7.7.0",
		servePlaceIds: [111],
		blockedPlaceIds: null,
		placeId: null,
	});
	for (const aState of ["running", "stopped"] as const) {
		const answer = matchPlace({ placeId: 111, unsaved: false, remembered: "B" }, [candidate("a", aState), candidate("b", "running")], null);
		assert.equal(answer.projectId, "b", `a ${aState} rival does not take it`);
	}
});

test("place requests: a repeat call refreshes one request; the holder's side sees it", () => {
	const { world, requests } = requestWorld();
	const first = requests.ask("a", 111, "worktree:a", false);
	assert.equal(first.kind, "pending");
	assert.equal(first.kind === "pending" && first.fresh, true);
	world.clock += 5000;
	const again = requests.ask("a", 111, "worktree:a", false);
	assert.equal(again.kind === "pending" && again.fresh, false, "no second notification");
	assert.equal(requests.pending().length, 1);
	assert.equal(requests.pending()[0].since, 1000, "it keeps its first time");
	assert.deepEqual(requests.against("b").map((request) => request.askerId), ["a"]);
	assert.deepEqual(requests.against("a"), []);
	assert.equal(requests.pendingFor("a", 111)?.id, "a:111");
	assert.equal(requests.pendingFor("a", 222), null);
	assert.deepEqual(world.assigned, {}, "nothing was taken from the holder");
});

test("place requests: nothing is asked when the asker holds the place, or nobody does", () => {
	const mine = requestWorld({ holder: "a" });
	assert.deepEqual(mine.requests.ask("a", 111, "worktree:a", false), { kind: "already" });
	assert.equal(mine.requests.pending().length, 0);

	const free = requestWorld({ holder: null });
	assert.deepEqual(free.requests.ask("a", 111, "worktree:a", false), { kind: "assigned" });
	assert.deepEqual(free.world.assigned, { 111: "a" }, "saved like the panel's assignment");
	assert.equal(free.requests.pending().length, 0, "no notification for a free place");
});

test("place requests: Move assigns, Decline does not, and a second answer finds nothing", () => {
	const moved = requestWorld();
	moved.requests.ask("a", 111, "worktree:a", false);
	assert.equal(moved.requests.answer("a:111", "move")?.askerId, "a");
	assert.deepEqual(moved.world.assigned, { 111: "a" });
	assert.equal(moved.requests.outcomeFor("a", 111), "moved");
	assert.equal(moved.requests.pending().length, 0);
	assert.equal(moved.requests.answer("a:111", "move"), null, "answered in another window: nothing to do");

	const declined = requestWorld();
	declined.requests.ask("a", 111, "worktree:a", false);
	assert.ok(declined.requests.answer("a:111", "decline"));
	assert.deepEqual(declined.world.assigned, {});
	assert.equal(declined.requests.outcomeFor("a", 111), "declined");
	assert.equal(declined.requests.answer("a:111", "decline"), null);
	declined.requests.ask("a", 111, "worktree:a", false);
	assert.equal(declined.requests.outcomeFor("a", 111), null, "asking again starts over");
	assert.equal(declined.requests.pending().length, 1);
	declined.requests.answer("a:111", "decline");
	declined.world.clock += OUTCOME_MS + 1;
	assert.equal(declined.requests.outcomeFor("a", 111), null, "an answer is remembered for a while only");
});

test("place requests: autoMove (yolo or placeMoves auto) moves at once only from a holder no agent claimed", () => {
	const free = requestWorld();
	assert.deepEqual(free.requests.ask("a", 111, "worktree:a", true), { kind: "moved", from: "b" });
	assert.deepEqual(free.world.assigned, { 111: "a" });
	assert.equal(free.requests.pending().length, 0);

	const busy = requestWorld({ claims: { b: "worktree:elsewhere" } });
	assert.equal(busy.requests.ask("a", 111, "worktree:a", true).kind, "pending", "an agent's claim still holds under yolo");
	assert.deepEqual(busy.world.assigned, {});

	const off = requestWorld();
	assert.equal(off.requests.ask("a", 111, "worktree:a", false).kind, "pending", "without yolo the user is asked");
});

test("place requests: they end on release, claim lapse or change, removal, an unlisted place, and a panel assignment", () => {
	const ask = () => {
		const made = requestWorld();
		made.requests.ask("a", 111, "worktree:a", false);
		assert.equal(made.requests.pending().length, 1);
		return made;
	};

	const released = ask();
	released.requests.dropAsker("a");
	assert.equal(released.requests.pending().length, 0);

	const lapsed = ask();
	delete lapsed.world.claims.a;
	assert.equal(lapsed.requests.pending().length, 0, "the asking claim ran out");

	const taken = ask();
	taken.world.claims.a = "worktree:someone-else";
	assert.equal(taken.requests.pending().length, 0, "the claim changed hands");

	const askerGone = ask();
	askerGone.world.removed.add("a");
	assert.equal(askerGone.requests.pending().length, 0);

	const holderGone = ask();
	holderGone.world.removed.add("b");
	assert.equal(holderGone.requests.pending().length, 0);

	const unlisted = ask();
	unlisted.world.listed.a = [];
	assert.equal(unlisted.requests.pending().length, 0, "the asker stopped listing the place");

	const panel = ask();
	panel.world.assigned[111] = "a";
	assert.equal(panel.requests.pending().length, 0, "the user assigned it in the panel instead");
	assert.equal(panel.requests.outcomeFor("a", 111), "moved");

	const synced = ask();
	synced.world.holder = "a";
	assert.equal(synced.requests.pending().length, 0, "the place now syncs with the asker");
});

test("version: names the service, plugin, launcher, each serving Rojo and each place's plugin; an older plugin gets the reopen note", async () => {
	const repo = tempRepo();
	const { hub, slot } = stubHub(repo, null);
	const place = (placeId: number, placeName: string, pluginVersion: string, unsaved = false) => ({ key: String(placeId), placeId, placeName, unsaved, pluginVersion });
	const stopped = { ...slot, id: "idle", projectName: "Idle", state: "stopped", rojoVersion: null };
	const wired = {
		...hub,
		list: () => [{ ...slot, rojoVersion: "7.7.0" }, stopped],
		studio: { places: () => [place(111, "Lobby", "0.21.0"), place(222, "Arena", SERVICE_VERSION), place(0, "Untitled", SERVICE_VERSION, true)] },
	};
	const mcp = new Mcp(wired as never);

	// no launcher installed yet
	const bare = await callTool(mcp, "version", {});
	assert.ok(!bare.isError, bare.content[0].text);
	assert.equal(bare.structuredContent.launcher, null);
	assert.match(bare.content[0].text, /MCP launcher: not installed\./);
	assert.deepEqual(check(bare.structuredContent, TOOLS.find((tool) => tool.name === "version")!.outputSchema as Schema), []);

	mkdirSync(join(wired.home, "launcher"), { recursive: true });
	writeFileSync(launcherScript(wired.home), `// rojo-hub-launcher ${SERVICE_VERSION}\n`);
	const answer = await callTool(mcp, "version", { path: repo });
	const text = answer.content[0].text;
	assert.ok(text.startsWith(`Rojo-Hub ${SERVICE_VERSION} (service). Studio plugin it installs: ${SERVICE_VERSION}. MCP launcher: ${SERVICE_VERSION} at `), text);
	assert.match(text, /Rojo per serving project: Game 7\.7\.0\./, "only running projects are listed");
	assert.doesNotMatch(text, /Idle/);
	assert.ok(text.includes(`Lobby (place 111) plugin 0.21.0: older than the service; reopen the place to load ${SERVICE_VERSION}.`), text);
	assert.ok(text.split(/\r?\n/).some((line) => line.includes("Arena") && !line.includes("older")), "a current plugin gets no note");
	assert.match(text, /Untitled \(unsaved\) plugin/);
	assert.deepEqual(answer.structuredContent, {
		service: SERVICE_VERSION,
		plugin: SERVICE_VERSION,
		launcher: SERVICE_VERSION,
		connection: null,
		connectionOutdated: false,
		projects: [{ id: "game", name: "Game", rojoVersion: "7.7.0" }],
		places: [
			{ placeId: 111, name: "Lobby", pluginVersion: "0.21.0", outdated: true },
			{ placeId: 222, name: "Arena", pluginVersion: SERVICE_VERSION, outdated: false },
			{ placeId: 0, name: "Untitled", pluginVersion: SERVICE_VERSION, outdated: false },
		],
		reopening: [],
	});
	assert.deepEqual(check(answer.structuredContent, TOOLS.find((tool) => tool.name === "version")!.outputSchema as Schema), []);
	assert.equal(wired.claimOf(), null, "it claims nothing");
});

/** Two projects, Game (the caller's, claimed by its worktree) and Other, listing Lobby (111); the real PlaceRequests behind an MCP stub. */
function sharedStub(repo: string, over: { yolo?: boolean; placeMoves?: "ask" | "auto"; holder?: string | null; claimMine?: boolean; claimTheirs?: boolean } = {}) {
	const { hub, slot } = stubHub(repo, null);
	const other = { ...slot, id: "other", projectName: "Other", repoPath: tempRepo(), places: [], listedPlaces: [{ placeId: 111, placeName: "Lobby", open: true, busy: null, error: null }] };
	const home = yoloHome();
	const claims = new Map<string, { key: string; label: string; until: number }>();
	if (over.claimMine !== false) claims.set("game", { key: claimKey({ kind: "worktree", path: repo }), label: "mine", until: Date.now() + 600_000 });
	if (over.claimTheirs) claims.set("other", { key: "worktree:theirs", label: "theirs", until: Date.now() + 600_000 });
	const world = { holder: over.holder === undefined ? "other" : over.holder, assigned: {} as Record<number, string> };
	const projects = () => [
		{ id: "game", projectName: "Game", listed: [111] },
		{ id: "other", projectName: "Other", listed: [111] },
	];
	const requests = new PlaceRequests({
		projects,
		holderOf: () => world.holder,
		assigned: (placeId) => world.assigned[placeId] ?? null,
		assign: (placeId, slotId) => {
			world.assigned[placeId] = slotId;
			world.holder = slotId;
		},
		claimKeyOf: (id) => claims.get(id)?.key ?? null,
	});
	const wired = {
		...hub,
		home,
		yoloOn: over.yolo === true,
		placeMoves: over.placeMoves ?? "ask",
		list: () => [slot, other],
		registry: { get: (id: string) => (id === "other" ? other : slot), slots: [slot, other] },
		claimOf: (id: string) => claims.get(id) ?? null,
		ackNotes: () => undefined,
		claimMinutes: 15,
		claimUntil: () => Date.now() + 15 * 60_000,
		// the real release, run against the stub's own claims and requests
		releaseClaim: Hub.prototype.releaseClaim,
		lapsedClaim: () => null,
		setClaim: (id: string, next: { key: string; label: string; until: number } | null) => void (next ? claims.set(id, next) : claims.delete(id)),
		requestProjects: projects,
		placeHolder: () => world.holder,
		requests,
	};
	return { hub: wired, other, home, world, requests };
}

test("request_place: shared places show on both sides, a request is one, and Move or Decline reach the waiting agent", async () => {
	const repo = tempRepo();
	const stub = sharedStub(repo);
	const mcp = new Mcp(stub.hub as never);

	const before = await callTool(mcp, "status", { path: repo });
	assert.match(before.content[0].text, /Lobby \(111\) is synced with Other, which also lists it\. Call request_place to ask the user to move it here\./);
	const project = before.structuredContent.projects.find((entry: Record<string, any>) => entry.id === "game");
	assert.deepEqual(project.sharedPlaces, [{ placeId: 111, name: "Lobby", heldBy: "Other", alsoListedBy: ["Other"], request: "none" }]);
	assert.deepEqual(check(before.structuredContent, TOOLS.find((tool) => tool.name === "status")!.outputSchema as Schema), []);

	const asked = await callTool(mcp, "request_place", { path: repo, place_id: 111 });
	assert.ok(!asked.isError, asked.content[0].text);
	assert.equal(asked.structuredContent.outcome, "pending");
	assert.equal(asked.structuredContent.holder, "Other");
	assert.deepEqual(check(asked.structuredContent, TOOLS.find((tool) => tool.name === "request_place")!.outputSchema as Schema), []);
	assert.equal((await callTool(mcp, "request_place", { path: repo, place_id: 111 })).structuredContent.outcome, "pending");
	assert.equal(stub.requests.pending().length, 1, "a repeat call refreshes, it does not add");

	// both sides hear of it
	assert.match((await callTool(mcp, "status", { path: repo })).content[0].text, /You asked the user to move it here; waiting for the answer\./);
	const holderSide = await callTool(mcp, "status", { path: stub.other.repoPath });
	assert.match(holderSide.content[0].text, /Game asked the user to move Lobby \(111\) to it; Other holds it now\. Finish what you are doing in Studio and release\./);
	assert.deepEqual(holderSide.structuredContent.projects.find((entry: Record<string, any>) => entry.id === "other").incomingRequests, [{ placeId: 111, name: "Lobby", from: "Game" }]);
	assert.match((await callTool(mcp, "serve_here", { path: repo })).content[0].text, /You asked the user to move it here/, "serve_here says it too");

	// The waiting call asks again before it waits; answer only once that request stands (finding the repo can take a while).
	const asking = async () => {
		const until = Date.now() + 5000;
		while (!stub.requests.pendingFor("game", 111) && Date.now() < until) await new Promise((done) => setTimeout(done, 20));
	};

	// Decline reaches an agent that is waiting (the standing request is dropped, so asking() sees the waiting call's own)
	stub.requests.dropAsker("game");
	const declining = callTool(mcp, "request_place", { path: repo, place_id: 111, wait: 10 });
	await asking();
	assert.ok(stub.requests.answer("game:111", "decline"));
	const declined = await declining;
	assert.equal(declined.structuredContent.outcome, "declined");
	assert.match(declined.content[0].text, /declined/);
	assert.match((await callTool(mcp, "status", { path: repo })).content[0].text, /The user declined moving it here\./, "its next status says so too");

	// Move reaches it too, and the place is the asker's afterwards
	const moving = callTool(mcp, "request_place", { path: repo, place_id: 111, wait: 10 });
	await asking();
	assert.ok(stub.requests.answer("game:111", "move"));
	assert.equal((await moving).structuredContent.outcome, "moved");
	assert.deepEqual(stub.world.assigned, { 111: "game" });
	assert.match((await callTool(mcp, "request_place", { path: repo, place_id: 111 })).content[0].text, /already syncs with Game/);

	// a wait that runs out says still pending; release ends the request
	stub.world.holder = "other";
	stub.world.assigned = {};
	assert.equal((await callTool(mcp, "request_place", { path: repo, place_id: 111 })).structuredContent.outcome, "pending");
	assert.equal((await callTool(mcp, "request_place", { path: repo, place_id: 111, wait: 0.1 })).structuredContent.outcome, "pending");
	await callTool(mcp, "release", { path: repo });
	assert.equal(stub.requests.pending().length, 0);
});

test("request_place: refuses without the asker's claim, for an unlisted place, and assigns a place nobody holds", async () => {
	const repo = tempRepo();
	const unclaimed = await callTool(new Mcp(sharedStub(repo, { claimMine: false }).hub as never), "request_place", { path: repo, place_id: 111 });
	assert.equal(unclaimed.isError, true);
	assert.match(unclaimed.content[0].text, /hold no claim.*serve_here/);

	const theirs = sharedStub(repo, { claimMine: false });
	theirs.hub.setClaim("game", { key: "worktree:elsewhere", label: "Other worktree", until: Date.now() + 600_000 });
	const busy = await callTool(new Mcp(theirs.hub as never), "request_place", { path: repo, place_id: 111 });
	assert.equal(busy.isError, true);
	assert.match(busy.content[0].text, /claimed by an agent working in Other worktree/);

	const stub = sharedStub(repo, { holder: null });
	const mcp = new Mcp(stub.hub as never);
	const unlisted = await callTool(mcp, "request_place", { path: repo, place_id: 999 });
	assert.equal(unlisted.isError, true);
	assert.match(unlisted.content[0].text, /999 is not one of Game's places: Lobby \(place 111, open\)/);
	assert.equal((await callTool(mcp, "request_place", { path: repo })).isError, true, "place_id is required");

	const free = await callTool(mcp, "request_place", { path: repo, place_id: 111 });
	assert.ok(!free.isError, free.content[0].text);
	assert.equal(free.structuredContent.outcome, "assigned");
	assert.deepEqual(stub.world.assigned, { 111: "game" }, "assigned straight away");
	assert.equal(stub.requests.pending().length, 0);
	assert.match(free.content[0].text, /Nobody held it/);
});

test("request_place: under yolo it moves at once from an unclaimed holder and is audited; a claimed holder still asks the user", async () => {
	const repo = tempRepo();
	const open = sharedStub(repo, { yolo: true });
	const moved = await callTool(new Mcp(open.hub as never), "request_place", { path: repo, place_id: 111 });
	assert.ok(!moved.isError, moved.content[0].text);
	assert.equal(moved.structuredContent.outcome, "moved");
	assert.equal(moved.structuredContent.holder, "Game");
	assert.deepEqual(open.world.assigned, { 111: "game" });
	const lines = auditLines(open.home);
	assert.deepEqual(lines.map((line) => line.action), ["move_place", "request_place"]);
	assert.deepEqual(lines[0].args, { placeId: 111, from: "Other" });
	assert.equal(lines[1].lifted, true, "only yolo allowed it");
	assert.equal(lines[0].by, "yolo");

	const busy = sharedStub(repo, { yolo: true, claimTheirs: true });
	const asked = await callTool(new Mcp(busy.hub as never), "request_place", { path: repo, place_id: 111 });
	assert.equal(asked.structuredContent.outcome, "pending");
	assert.deepEqual(busy.world.assigned, {});
	assert.equal(busy.requests.pending().length, 1);
});

test("request_place: rojoHub.placeMoves auto moves at once from an unclaimed holder and is audited; a claimed holder, or ask, still asks the user", async () => {
	const repo = tempRepo();
	const auto = sharedStub(repo, { placeMoves: "auto" });
	const moved = await callTool(new Mcp(auto.hub as never), "request_place", { path: repo, place_id: 111 });
	assert.equal(moved.structuredContent.outcome, "moved");
	assert.match(moved.content[0].text, /placeMoves to auto/);
	assert.deepEqual(auto.world.assigned, { 111: "game" });
	const lines = auditLines(auto.home);
	assert.equal(lines[0].action, "move_place");
	assert.equal(lines[0].by, "placeMoves");
	assert.equal(lines[0].lifted, false, "yolo did not allow it");
	assert.deepEqual(lines[0].args, { placeId: 111, from: "Other" });

	const claimed = sharedStub(repo, { placeMoves: "auto", claimTheirs: true });
	assert.equal((await callTool(new Mcp(claimed.hub as never), "request_place", { path: repo, place_id: 111 })).structuredContent.outcome, "pending", "a claim holds with auto");
	assert.deepEqual(claimed.world.assigned, {});

	const ask = sharedStub(repo, { placeMoves: "ask" });
	assert.equal((await callTool(new Mcp(ask.hub as never), "request_place", { path: repo, place_id: 111 })).structuredContent.outcome, "pending");
	assert.deepEqual(ask.world.assigned, {});
	assert.equal(ask.requests.pending().length, 1);
});

test("request_place: the question for the user (_meta rojo-hub/elicit) is returned only to a client that can be asked", async () => {
	const repo = tempRepo();
	const stub = sharedStub(repo);
	const mcp = new Mcp(stub.hub as never);
	const plain = await callTool(mcp, "request_place", { path: repo, place_id: 111 });
	assert.equal(plain._meta, undefined, "no _meta without the launcher's header");
	assert.match(plain.content[0].text, /do not ask in chat/);
	const asked = await callTool(mcp, "request_place", { path: repo, place_id: 111, wait: 30 }, { elicit: true });
	assert.equal(asked.structuredContent.outcome, "pending", "wait is not waited for: the question is handed back at once");
	const ask = asked._meta["rojo-hub/elicit"];
	assert.equal(ask.requestId, stub.requests.pending()[0].id);
	assert.equal(ask.message, "Move Lobby from Other to Game? Studio switches it over at once.");
	assert.equal(ask.moved.data.outcome, "moved");
	assert.equal(ask.declined.data.outcome, "declined");
	assert.equal(ask.answered.data.outcome, "ended");
	assert.equal(stub.requests.pending().length, 1, "one request, however it was asked");
	assert.match(asked.content[0].text, /never try to approve|do not ask in chat or try to approve/);
	// a place nobody holds is assigned: nothing to ask
	const free = sharedStub(repo, { holder: null });
	assert.equal((await callTool(new Mcp(free.hub as never), "request_place", { path: repo, place_id: 111 }, { elicit: true }))._meta, undefined);
	// the TOOL says the user is asked and the agent never answers for them
	assert.doesNotMatch(JSON.stringify(TOOLS.find((tool) => tool.name === "request_place")!.inputSchema), /approved/);
});

test("status: placeMoves is in its data, and a line says so when it is auto", async () => {
	const repo = tempRepo();
	for (const placeMoves of ["ask", "auto"] as const) {
		const stub = sharedStub(repo, { placeMoves });
		const status = await callTool(new Mcp(stub.hub as never), "status", { path: repo });
		assert.equal(status.structuredContent.placeMoves, placeMoves);
		assert.equal(/^Place moves are on automatic/.test(status.content[0].text), placeMoves === "auto");
	}
});

test("open_place: a Studio process alone says so and what to do; a connected plugin keeps the plain wording", async () => {
	const repo = tempRepo();
	const stub = ensureStub(repo);
	let found: { evidence: "plugin" | "process"; pids?: number[] } = { evidence: "process", pids: [4242] };
	stub.hub.openPlace = async (_id: string, placeId: number) => ({ placeId, placeName: "Lobby", outcome: "already-open", ...found }) as never;
	const mcp = new Mcp(stub.hub as never);
	const text = async () => {
		const answer = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_place", arguments: { path: repo } } }, undefined)) as { result: { content: { text: string }[] } };
		return answer.result.content[0].text;
	};
	const process = await text();
	assert.match(process, /Lobby \(place 111\) looks open: a Studio process for it is running \(pid 4242\) but its Rojo-Hub plugin has not connected/);
	assert.match(process, /Call wait_for_studio; if the user closed it, call open_place again once that Studio has exited/);
	assert.doesNotMatch(process, /is already open in Studio/);

	found = { evidence: "plugin" };
	assert.match(await text(), /^Lobby \(place 111\) is already open in Studio; nothing was opened\./);

	// ensure's open step says the same for a process
	found = { evidence: "process", pids: [7] };
	const ensured = await ensureCall(stub, { path: repo });
	const step = ensured.structuredContent.steps.find((entry: any) => entry.step === "open_place");
	assert.equal(step.outcome, "already");
	assert.match(step.detail, /looks open: a Studio process for it is running \(pid 7\)/);
});

test("serve_here from the main checkout says to use new_branch; from a worktree it does not", async () => {
	const repo = tempRepo();
	const worktree = join(mkdtempSync(join(tmpdir(), "rojo-hub-wt-")), "side");
	execFileSync("git", ["worktree", "add", "-q", worktree, "side"], { cwd: repo, stdio: "pipe" });
	const stub = ensureStub(repo, { state: "running" });
	const mcp = new Mcp(stub.hub as never);
	const serve = async (path: string) => {
		const answer = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "serve_here", arguments: { path } } }, undefined)) as { result: { content: { text: string }[] } };
		return answer.result.content[0].text;
	};
	assert.match(await serve(repo), /You are serving the main checkout; don't check out other branches here; use new_branch for other work\./);
	assert.doesNotMatch(await serve(worktree), /serving the main checkout/);
});

test("stale connection: a launcher older than the service, or none named (before 0.22.6, or direct HTTP), is told", async () => {
	assert.equal(staleConnection(SERVICE_VERSION), null, "a current launcher");
	assert.equal(staleConnection("99.0.0"), null, "a newer launcher is not stale");
	assert.equal(staleConnection("0.22.5"), "0.22.5", "an older launcher names itself");
	assert.equal(staleConnection(undefined), "before 0.22.6", "no header: a launcher from before 0.22.6, or a direct client");
	assert.equal(staleConnection(" "), "before 0.22.6");
	assert.equal(staleConnection(["0.1.0"]), "0.1.0");

	const mcp = new Mcp({ home: mkdtempSync(join(tmpdir(), "rh-stale-")), list: () => [], studio: { places: () => [] } } as never);
	const call = async (connection: string | null, launcher: string | null, name = "version") =>
		(await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, "2025-06-18", { connection, launcher })) as { result?: { content: { text: string }[]; structuredContent?: Record<string, unknown> }; error?: unknown };
	const fresh = await call(null, SERVICE_VERSION);
	assert.ok(!fresh.result!.content[0].text.includes("Note: this chat's"), "no note for a current launcher");
	assert.match(fresh.result!.content[0].text, new RegExp(`This chat's connection: launcher ${SERVICE_VERSION.replace(/\./g, "\.")}\.`));
	assert.equal(fresh.result!.structuredContent!.connection, SERVICE_VERSION);
	assert.equal(fresh.result!.structuredContent!.connectionOutdated, false);
	const old = await call("before 0.22.6", null);
	const text = old.result!.content[0].text;
	assert.ok(text.endsWith(outdatedNote("before 0.22.6")), "the note is the last line of every tool result");
	assert.match(text, /launcher before 0\.22\.6\) than the service/);
	assert.match(text, /This chat's connection: older than 0\.22\.6\. Ask the user to run \/mcp and reconnect rojohub/);
	assert.equal(old.result!.structuredContent!.connection, "older than 0.22.6");
	assert.equal(old.result!.structuredContent!.connectionOutdated, true);
	assert.ok(!JSON.stringify(old.result!.structuredContent).includes("Note:"), "only the text carries the note");
	const named = await call("0.22.5", "0.22.5");
	assert.match(named.result!.content[0].text, /This chat's connection: launcher 0\.22\.5\./);
	assert.match(named.result!.content[0].text, /launcher 0\.22\.5\) than the service/);
	const failed = await call("0.22.5", "0.22.5", "status");
	assert.match(failed.result!.content[0].text, /Note: this chat's Rojo-Hub connection is older/, "an error result carries it too");
});

test("place requests and assignments are written to the log", () => {
	const { world, requests } = requestWorld();
	const logged: string[] = [];
	requests.log = (line) => void logged.push(line);
	requests.ask("a", 111, "worktree:a", false);
	assert.deepEqual(logged, ["places: A asked for place 111, held by B"]);
	requests.ask("a", 111, "worktree:a", false);
	assert.equal(logged.length, 1, "a repeat call is not a new request");
	assert.ok(requests.answer("a:111", "decline", "the agent's chat"));
	assert.equal(logged[1], "places: A's request for place 111 answered in the agent's chat: decline");

	const sources: string[] = [];
	const rig = requestWorld();
	rig.requests.log = (line) => void logged.push(line);
	const deps = (rig.requests as unknown as { deps: RequestDeps }).deps;
	const inner = deps.assign;
	deps.assign = (placeId, slotId, source) => (sources.push(source), inner(placeId, slotId, source));
	rig.requests.ask("a", 111, "worktree:a", false);
	rig.requests.answer("a:111", "move");
	assert.deepEqual(sources, ["Move on A's request, answered in VS Code"]);
	assert.ok(logged.includes("places: A's request for place 111 answered in VS Code: move"));

	const auto = requestWorld();
	auto.requests.log = (line) => void logged.push(line);
	(auto.requests as unknown as { deps: RequestDeps }).deps.assign = (_p, _s, source) => void sources.push(source);
	auto.requests.ask("a", 111, "worktree:a", true, "yolo");
	assert.equal(sources[1], "auto move, yolo");
	assert.ok(logged.includes("places: A took place 111 from B at once (yolo; no agent claimed it)"));

	const ended = requestWorld();
	ended.requests.log = (line) => void logged.push(line);
	ended.requests.ask("a", 111, "worktree:a", false);
	delete ended.world.claims.a;
	assert.equal(ended.requests.pending().length, 0);
	assert.ok(logged.includes("places: A's request for place 111 ended: its claim was released or lapsed"));
	const released = requestWorld();
	released.requests.log = (line) => void logged.push(line);
	released.requests.ask("a", 111, "worktree:a", false);
	released.requests.dropAsker("a");
	assert.ok(logged.includes("places: A's request for place 111 ended: the project was released"));
	assert.ok(world);
});

test("status: a place assigned to one project but still synced with another says the handover is pending", async () => {
	const place = (assigned: string | null, syncedWith: string | null) => ({ placeName: "TLS Building Tests - Dev", placeId: 88678433007729, unsaved: false, assigned, syncedWith, pluginVersion: "0.22.4" });
	const mcp = new Mcp({ registry: { slots: [{ id: "ft", projectName: "FolderThemes" }, { id: "vb", projectName: "VluxyBuildingTools" }] }, studio: { places: () => [place("ft", "VluxyBuildingTools")] } } as never);
	const internals = mcp as unknown as { handoverText(p: unknown, only?: string): string | null; assignedName(p: unknown): string | null };
	const text = internals.handoverText(place("ft", "VluxyBuildingTools"));
	assert.equal(text, "TLS Building Tests - Dev is assigned to FolderThemes but still synced with VluxyBuildingTools; its plugin (0.22.4) switches over by itself from 0.22.5 on; with an older plugin, Disconnect in Studio's Rojo panel or reopen the place.");
	assert.equal(internals.handoverText(place("ft", "FolderThemes")), null, "nothing pending once synced");
	assert.equal(internals.handoverText(place(null, "FolderThemes")), null, "nothing assigned");
	assert.equal(internals.handoverText(place("ft", null)), null, "not synced yet: it is connecting, not handing over");
	assert.equal(internals.handoverText(88678433007729, "vb"), null, "by place ID, only for the named assignment");
	assert.equal(internals.handoverText(88678433007729, "ft"), text, "by place ID");
	assert.equal(internals.assignedName(place("vb", null)), "VluxyBuildingTools");
});

test("reload on update: only the window's own profile list counts, never another profile's newer folder", () => {
	const user = join("C:", "Users", "u", "AppData", "Roaming", "Code", "User");
	const extensions = join("C:", "Users", "u", ".vscode", "extensions");
	const running = join(extensions, "greenviper126.rojo-hub-0.22.6");
	// globalStorage is shared by all profiles (measured: a Roblox-profile window got the shared one, so 0.22.6-0.22.8 never reloaded)
	const shared = join(user, "globalStorage", "greenviper126.rojo-hub");
	assert.equal(userFolder(shared), user);
	assert.equal(userFolder(join(user, "profiles", "-e02f7ca", "globalStorage", "greenviper126.rojo-hub")), user, "a per-profile one, should VS Code give it");
	// the profile comes from VS Code's own record of which profile each workspace opens in
	const storage = (file: string) => {
		assert.equal(file, join(user, "globalStorage", "storage.json"));
		return JSON.stringify({ profileAssociations: { workspaces: { "file:///c%3A/roblox/game": "-e02f7ca", "file:///c%3A/other": "__default__profile__" } } });
	};
	assert.equal(profileExtensionsFile(shared, running, "file:///c%3A/roblox/game", storage), join(user, "profiles", "-e02f7ca", "extensions.json"));
	assert.equal(profileExtensionsFile(shared, running, "file:///c%3A/other", storage), join(extensions, "extensions.json"), "the default profile's list is in the extensions folder");
	assert.equal(profileExtensionsFile(shared, running, "file:///c%3A/unknown", storage), null, "a workspace VS Code has no record of: no reload");
	assert.equal(profileExtensionsFile(shared, running, undefined, storage), null, "an empty window: no reload");
	assert.equal(profileExtensionsFile(shared, running, "file:///c%3A/roblox/game", () => "{not json"), null);

	const list = (version: string) => () => JSON.stringify([{ identifier: { id: "other.ext" }, version: "9.9.9" }, { identifier: { id: "GreenViper126.rojo-hub" }, version }]);
	assert.equal(newerInstalled("x", "0.22.6", list("0.22.7")), "0.22.7");
	assert.equal(newerInstalled("x", "0.22.6", list("0.22.6")), null, "only itself");
	assert.equal(newerInstalled("x", "0.22.7", list("0.22.6")), null, "an older one in this profile is no update");
	assert.equal(newerInstalled("x", "0.9.0", list("0.10.0")), "0.10.0", "versions compare numerically");
	assert.equal(newerInstalled("x", "0.22.6", () => "[]"), null, "not in this profile");
	assert.equal(newerInstalled("x", "0.22.6", () => { throw new Error("gone"); }), null, "an unreadable list is no update");
	assert.equal(newerInstalled("x", "0.22.6", () => "{not json"), null);
});

test("close_place and reopen_place: refused while closePlaces is off (yolo does not lift it), claims apply, force passes, and both are audited", async () => {
	const repo = tempRepo();
	const run = (over: { closeOn: boolean; yolo?: boolean; claim?: { key: string; label: string; until: number } | null }) => {
		const { hub, slot, home } = yoloStub(repo, { yolo: over.yolo === true, claim: over.claim ?? null });
		const done: string[] = [];
		const full = { ...hub, closePlacesOn: over.closeOn, closePlace: async (_id: string, placeId: number) => void done.push(`close ${placeId}`), reopenPlace: async (_id: string, placeId: number) => void done.push(`reopen ${placeId}`) };
		return { mcp: new Mcp(full as never), done, home, slot };
	};
	const off = run({ closeOn: false, yolo: true });
	for (const name of ["close_place", "reopen_place"]) {
		const refused = await callTool(off.mcp, name, { path: repo });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /rojoHub\.closePlaces/, "names the setting, even under yolo");
	}
	assert.deepEqual(off.done, []);

	const on = run({ closeOn: true });
	const closed = await callTool(on.mcp, "close_place", { path: repo });
	assert.ok(!closed.isError, closed.content[0].text);
	assert.match(closed.content[0].text, /Asked Studio to close Lobby \(place 111\)/);
	const reopened = await callTool(on.mcp, "reopen_place", { path: repo, placeId: 111 });
	assert.ok(!reopened.isError, reopened.content[0].text);
	assert.deepEqual(on.done, ["close 111", "reopen 111"]);
	const lines = readFileSync(join(on.home, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { action: string; args: { placeId: number } });
	assert.deepEqual(lines.map((line) => line.action), ["close_place", "reopen_place"]);
	assert.equal(lines[0].args.placeId, 111);
	assert.match((await callTool(on.mcp, "close_place", { path: repo, placeId: 5 })).content[0].text, /not one of/);

	const claim = { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 };
	const claimed = run({ closeOn: true, claim });
	const held = await callTool(claimed.mcp, "close_place", { path: repo });
	assert.equal(held.isError, true);
	assert.match(held.content[0].text, /claimed by an agent/);
	assert.deepEqual(claimed.done, []);
	const forced = await callTool(claimed.mcp, "close_place", { path: repo, force: true });
	assert.ok(!forced.isError, forced.content[0].text);
	assert.deepEqual(claimed.done, ["close 111"]);
});

/* ---------- ensure: the versions step (spec 015) ---------- */

type VersionsPlace = { key: string; placeId: number; placeName: string; unsaved: boolean; pluginVersion: string; projectId: string | null; syncedWith: string | null; confirming: boolean };
const versionsPlace = (over: Partial<VersionsPlace> = {}): VersionsPlace => ({ key: "k111", placeId: 111, placeName: "Lobby", unsaved: false, pluginVersion: SERVICE_VERSION, projectId: "game", syncedWith: "Game", confirming: false, ...over });

/** A running project with its place 111 open and synced; reopening a place brings it back with the current plugin after a moment (unless it is told to stay open). */
function versionsStub(repo: string, places: VersionsPlace[], over: { closeOn?: boolean; claim?: { key: string; label: string; until: number } | null; stayOpen?: boolean; reopenFails?: boolean; yolo?: boolean } = {}) {
	const stub = ensureStub(repo, { state: "running", openPlacesOn: false, listed: [{ placeId: 111, placeName: "Lobby", open: true }], claim: over.claim });
	stub.slot.places = [{ placeId: 111, placeName: "Lobby", pluginVersion: SERVICE_VERSION }];
	stub.slot.target = { kind: "worktree", path: repo };
	stub.open.push(...places);
	const reopened: number[] = [];
	const hub = stub.hub as any;
	hub.closePlacesOn = over.closeOn !== false;
	hub.yoloOn = over.yolo === true;
	hub.reopenPlace = async (_id: string, placeId: number) => {
		if (over.reopenFails) throw new Error("Studio is not installed");
		reopened.push(placeId);
		if (over.stayOpen) return;
		const index = stub.open.findIndex((entry) => entry.placeId === placeId);
		const [gone] = stub.open.splice(index, 1);
		setTimeout(() => stub.open.push({ ...gone, pluginVersion: SERVICE_VERSION }), 60);
	};
	return { ...stub, reopened };
}
const versionsCall = async (stub: ReturnType<typeof versionsStub>, args: object = {}, options: { lists?: string[]; connection?: string | null } = {}) =>
	((await new Mcp(stub.hub as never, undefined, { extensionLists: () => options.lists ?? [], pollMs: 10 }).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ensure", arguments: { path: stub.slot.repoPath, timeout: 5, ...args } } }, "2025-06-18", { connection: options.connection ?? null })) as { result: EnsureResult }).result;

test("ensure versions: an older-plugin place of this project is reopened and reported reloaded once it is back", async () => {
	const repo = tempRepo();
	const stub = versionsStub(repo, [versionsPlace({ pluginVersion: "0.21.0" }), versionsPlace({ key: "k2", placeId: 222, placeName: "Other", projectId: "other", syncedWith: "Other", pluginVersion: "0.21.0" })]);
	const result = await versionsCall(stub);
	assert.ok(!result.isError, result.content[0].text);
	const versions = result.structuredContent.versions;
	assert.deepEqual(check(result.structuredContent, TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema), []);
	assert.deepEqual(stub.reopened, [111]);
	assert.equal(versions.reopened.length, 1);
	assert.deepEqual({ ...versions.reopened[0], detail: "" }, { placeId: 111, name: "Lobby", outcome: "reloaded", detail: "" });
	assert.ok(versions.reopened[0].detail.startsWith(`plugin 0.21.0 to ${SERVICE_VERSION}, reopened in `), versions.reopened[0].detail);
	assert.deepEqual(versions.outdatedElsewhere, [{ placeId: 222, name: "Other", pluginVersion: "0.21.0" }], "another project's place is only listed (acceptance 4)");
	assert.equal(versions.current, true, "this agent's setup is current once its place is back; another project's place is only listed");
	assert.deepEqual(allStepsOf(result), ["start:already", "serve:already", "versions:done", "open_place:already", "wait_for_studio:already"]);
	assert.equal(result.structuredContent.ready, true);
	assert.match(result.content[0].text, /fixed: reopened Lobby \(place 111\)/);
	const audit = readFileSync(join(stub.hub.home, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { action: string; args: { placeId: number; by: string } });
	assert.deepEqual(audit.map((line) => [line.action, line.args.placeId, line.args.by]), [["reopen_place", 111, "ensure"]]);
});

test("ensure versions: closePlaces off lists the place with the step to take and closes nothing; ensure stays ready", async () => {
	const repo = tempRepo();
	const stub = versionsStub(repo, [versionsPlace({ pluginVersion: "0.21.0" })], { closeOn: false });
	const result = await versionsCall(stub);
	assert.deepEqual(stub.reopened, []);
	assert.equal(result.structuredContent.ready, true);
	assert.ok(!result.isError);
	assert.equal(allStepsOf(result)[2], "versions:already");
	assert.deepEqual(result.structuredContent.versions.reopened, []);
	assert.match(result.structuredContent.versions.needsUser[0], /Lobby \(place 111\) runs plugin 0\.21\.0.*rojoHub\.closePlaces/);
	assert.match(result.content[0].text, /needs you: Lobby/);
});

test("ensure versions: a place whose project another agent claims is not reopened without force", async () => {
	const repo = tempRepo();
	const other = { key: "worktree:elsewhere", label: "Other", until: Date.now() + 120_000 };
	// the place is synced with another project (Rival) that another agent claimed; this project's own claim is ensure's
	const stub = versionsStub(repo, [versionsPlace({ pluginVersion: "0.21.0", projectId: "game", syncedWith: "Rival" })]);
	const hub = stub.hub as any;
	const rival = { ...stub.slot, id: "rival", projectName: "Rival", repoPath: join(tmpdir(), "rojo-hub-rival-repo") };
	hub.list = () => [stub.slot, rival];
	hub.claimOf = (id: string) => (id === "rival" ? other : null);
	const held = await versionsCall(stub);
	assert.deepEqual(stub.reopened, []);
	assert.equal(held.structuredContent.versions.reopened[0].outcome, "skipped", "left alone on purpose, not an error");
	assert.match(held.structuredContent.versions.reopened[0].detail, /another agent claimed Rival/);
	assert.equal(held.structuredContent.ready, true, "never changes ready");
	const forced = await versionsCall(stub, { force: true });
	assert.deepEqual(stub.reopened, [111], "force passes");
	assert.equal(forced.structuredContent.versions.reopened[0].outcome, "reloaded");
});

test("ensure versions: a place still open when the time is up is reported waiting; a failed reopen reports its error; neither fails ensure", async () => {
	const repo = tempRepo();
	const waiting = versionsStub(repo, [versionsPlace({ pluginVersion: "0.21.0" })], { stayOpen: true });
	const slow = await versionsCall(waiting, { timeout: 0 });
	assert.ok(!slow.isError, slow.content[0].text);
	assert.equal(slow.structuredContent.versions.reopened[0].outcome, "waiting");
	assert.match(slow.structuredContent.versions.reopened[0].detail, /waiting on you in Studio \(it may be asking about unsaved changes\)/);
	assert.equal(allStepsOf(slow)[2], "versions:already");
	assert.equal(slow.structuredContent.ready, true);

	const broken = versionsStub(repo, [versionsPlace({ pluginVersion: "0.21.0" })], { reopenFails: true });
	const failed = await versionsCall(broken);
	assert.ok(!failed.isError, failed.content[0].text);
	assert.equal(failed.structuredContent.versions.reopened[0].outcome, "failed");
	assert.equal(failed.structuredContent.versions.reopened[0].detail, "Studio is not installed");
	assert.equal(failed.structuredContent.ready, true);
});

test("ensure versions: a newer Rojo-Hub in a profile's extensions.json is reported with the reload step; older, equal and unreadable lists are not", async () => {
	const repo = tempRepo();
	const folder = mkdtempSync(join(tmpdir(), "rojo-hub-ext-"));
	const list = (name: string, version: string) => {
		const file = join(folder, name);
		writeFileSync(file, JSON.stringify([{ identifier: { id: "GreenViper126.rojo-hub" }, version }]));
		return file;
	};
	const garbage = join(folder, "garbage.json");
	writeFileSync(garbage, "{not json");
	const files = [list("older.json", "0.1.0"), list("equal.json", SERVICE_VERSION), garbage, join(folder, "missing.json")];

	const quiet = await versionsCall(versionsStub(repo, []), {}, { lists: files });
	assert.deepEqual(quiet.structuredContent.versions.needsUser, []);
	assert.equal(quiet.structuredContent.versions.current, true);

	const newer = await versionsCall(versionsStub(repo, []), {}, { lists: [...files, list("newer.json", "99.0.0"), list("newest.json", "99.1.0")] });
	assert.deepEqual(newer.structuredContent.versions.needsUser, [`Rojo-Hub 99.1.0 is installed but ${SERVICE_VERSION} is running; reload a VS Code window (Developer: Reload Window).`]);
	assert.equal(newer.structuredContent.versions.current, false);
	assert.equal(allStepsOf(newer)[2], "versions:already");
	assert.equal(newer.structuredContent.ready, true);
});

test("extensionLists: the default profile's list and every profile folder, from the folders it is given", () => {
	const user = mkdtempSync(join(tmpdir(), "rojo-hub-user-"));
	mkdirSync(join(user, "profiles", "-abc"), { recursive: true });
	mkdirSync(join(user, "profiles", "-def"), { recursive: true });
	writeFileSync(join(user, "profiles", "stray.txt"), "");
	const files = extensionLists({ ROJO_HUB_VSCODE_USER: user, ROJO_HUB_VSCODE_EXTENSIONS: join(user, "ext") });
	assert.deepEqual(files.sort(), [join(user, "ext", "extensions.json"), join(user, "profiles", "-abc", "extensions.json"), join(user, "profiles", "-def", "extensions.json")].sort());
	assert.deepEqual(extensionLists({ ROJO_HUB_VSCODE_USER: join(user, "nowhere"), ROJO_HUB_VSCODE_EXTENSIONS: join(user, "ext") }), [join(user, "ext", "extensions.json")], "no profiles folder");
});

test("ensure versions: an outdated chat connection is reported with the /mcp step", async () => {
	const repo = tempRepo();
	const result = await versionsCall(versionsStub(repo, []), {}, { connection: "0.22.5" });
	assert.ok(!result.isError);
	assert.equal(result.structuredContent.ready, true);
	assert.match(result.structuredContent.versions.needsUser[0], /run \/mcp and reconnect rojohub, or start a new chat/);
	assert.equal(allStepsOf(result)[2], "versions:already");

	// a place reopened is "done" even while the connection still needs the user (field test 2026-10-27 read "skipped" as nothing done)
	const both = await versionsCall(versionsStub(tempRepo(), [versionsPlace({ pluginVersion: "0.21.0" })]), {}, { connection: "0.22.5" });
	assert.equal(allStepsOf(both)[2], "versions:done");
	assert.equal(both.structuredContent.versions.needsUser.length, 1);
});

test("ensure versions: everything current is one 'all on' line, no reopen and no wait", async () => {
	const repo = tempRepo();
	const stub = versionsStub(repo, [versionsPlace()]);
	const result = await versionsCall(stub);
	assert.deepEqual(stub.reopened, []);
	assert.deepEqual(result.structuredContent.versions, { service: SERVICE_VERSION, current: true, needsUser: [], reopened: [], outdatedElsewhere: [] });
	assert.deepEqual(allStepsOf(result), ["start:already", "serve:already", "versions:already", "open_place:already", "wait_for_studio:already"]);
	assert.equal(result.structuredContent.steps[2].detail, `all on ${SERVICE_VERSION}`);
	assert.equal(result.structuredContent.ready, true);
});

test("ensure versions: a failed ensure carries versions null before the step ran, and the schema accepts it", async () => {
	const stub = versionsStub(tempRepo(), []);
	const result = await versionsCall(stub, { path: "" });
	assert.equal(result.structuredContent.failure.reason, "no_project");
	assert.equal(result.structuredContent.versions, null);
	assert.deepEqual(check(result.structuredContent, TOOLS.find((tool) => tool.name === "ensure")!.outputSchema as Schema), []);
});

test("ensure and the instructions say ensure also brings Rojo-Hub's parts to the current version", async () => {
	assert.match(TOOLS.find((tool) => tool.name === "ensure")!.description, /current version/);
	const init = (await new Mcp({ claimMinutes: 15 } as never).handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as { result: { instructions: string } };
	assert.match(init.result.instructions, /run ensure" is the whole setup/);
});

test("relocate (spec 016): a moved project keeps its id, port and place assignments; a different repo or a running project is refused", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-relocate-home-"));
	const parent = mkdtempSync(join(tmpdir(), "rojo-hub-relocate-"));
	const repo = join(parent, "old");
	mkdirSync(repo);
	const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
	run(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "default.project.json"), JSON.stringify({ name: "Moved", tree: { $className: "DataModel" } }));
	run(repo, "add", ".");
	run(repo, "commit", "-q", "-m", "one");
	const hub = new Hub(home);
	const added = await hub.add(repo);
	hub.registry.placeChoices["111"] = added.id;
	hub.registry.placeAccepted["111"] = ["Moved"];
	hub.registry.save();

	const moved = join(parent, "new");
	// Windows will not rename a folder the service watches, so copy it and point the record at a folder that is gone.
	cpSync(repo, moved, { recursive: true });
	const record = hub.registry.get(added.id);
	record.repoPath = join(parent, "gone");
	record.target = { kind: "worktree", path: join(parent, "gone") };
	assert.match(hub.view(hub.registry.get(added.id)).error ?? "", /Folder missing/, "a gone folder says so");

	const other = join(parent, "other");
	mkdirSync(other);
	run(other, "init", "-q", "-b", "main");
	writeFileSync(join(other, "default.project.json"), JSON.stringify({ name: "Moved" }));
	run(other, "add", ".");
	run(other, "commit", "-q", "-m", "different first commit");
	await assert.rejects(hub.relocate(added.id, other), /different repository/);

	const relocated = await hub.relocate(added.id, moved);
	assert.equal(pathKey(relocated.repoPath), pathKey(moved));
	assert.equal(relocated.id, added.id);
	assert.equal(relocated.port, added.port, "the port follows the first commit, not the folder");
	assert.equal(relocated.error, null);
	assert.equal(pathKey((relocated.target as { path: string }).path), pathKey(moved), "a worktree target in the old folder moved with it");
	assert.equal(hub.registry.placeChoices["111"], added.id, "place assignments survive");
	assert.deepEqual(hub.registry.placeAccepted["111"], ["Moved"]);
	assert.equal(pathKey(new Registry(home).slots[0].repoPath), pathKey(moved), "saved");

	(hub as any).runtime(added.id).state = "running";
	await assert.rejects(hub.relocate(added.id, moved), /serving/);
	hub.targetCache.dispose();
});

test("log tail: DEBUG and TRACE lines are left out unless verbose, and counted", () => {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-logtail-"));
	const file = join(dir, "rojo.log");
	const lines = ["[INFO  rojo] started", ...Array.from({ length: 50 }, (_, i) => `[DEBUG librojo::web::api] WebSocket batch ${i}`), "[ERROR rojo] a real problem", "[TRACE x] noise"];
	writeFileSync(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
	const log = new LogFollower(file);
	const quiet = log.tailOf(10, false);
	assert.equal(quiet.text, ["[INFO  rojo] started", "[ERROR rojo] a real problem"].join(String.fromCharCode(10)));
	assert.equal(quiet.hidden, 51);
	assert.equal(log.tailOf(3, true).text.split(String.fromCharCode(10)).length, 3, "verbose keeps everything");
	assert.match(log.tail(100), /DEBUG/, "tail() is unfiltered for the service's own use");
});

test("ensure versions: the outdated-connection note is not in the step's lines (the footer says it)", async () => {
	const result = await versionsCall(versionsStub(tempRepo(), []), {}, { connection: "0.22.5" });
	assert.ok(!/needs you: This chat's/.test(result.structuredContent.steps[2].detail));
	assert.equal(result.structuredContent.versions.needsUser.length, 1, "still counted, so current is false");
	assert.equal(result.structuredContent.versions.current, false);
});

test("relocate: an errored project can be relocated; a worktree under the old folder remaps, one outside keeps its place, and the claim is dropped", async () => {
	const home = mkdtempSync(join(tmpdir(), "rojo-hub-relocate2-home-"));
	const parent = mkdtempSync(join(tmpdir(), "rojo-hub-relocate2-"));
	const repo = join(parent, "old");
	mkdirSync(repo);
	const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
	run(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "default.project.json"), JSON.stringify({ name: "Moved2", tree: { $className: "DataModel" } }));
	run(repo, "add", ".");
	run(repo, "commit", "-q", "-m", "one");
	const hub = new Hub(home);
	const added = await hub.add(repo);
	const moved = join(parent, "new");
	cpSync(repo, moved, { recursive: true });
	mkdirSync(join(moved, "wt"));
	const record = hub.registry.get(added.id);
	record.repoPath = join(parent, "gone");
	record.target = { kind: "worktree", path: join(parent, "gone", "wt") };
	hub.setClaim(added.id, { key: "worktree:" + pathKey(join(parent, "gone", "wt")), label: "wt", until: Date.now() + 600_000 });
	(hub as any).runtime(added.id).state = "error";

	const relocated = await hub.relocate(added.id, moved);
	assert.equal(pathKey((relocated.target as { path: string }).path), pathKey(join(moved, "wt")), "a worktree under the old folder moved with it");
	assert.equal(hub.claimOf(added.id), null, "a claim keyed by the old path is dropped");
	assert.equal(new Hub((hub as any).home).claimOf(added.id), null, "and it does not come back from claims.json after a restart");
	assert.equal((hub as any).runtime(added.id).state, "stopped");

	const outside = join(parent, "orca-wt");
	mkdirSync(outside);
	record.target = { kind: "worktree", path: outside };
	record.repoPath = join(parent, "gone");
	await hub.relocate(added.id, moved);
	assert.equal(pathKey((record.target as { path: string }).path), pathKey(outside), "a worktree outside the old folder that still exists keeps its place");
	hub.targetCache.dispose();
});

test("status narrows to one project with project, or path and mine; mine without a path is refused", async () => {
	const repo = tempRepo();
	const stub = stubHub(repo, null);
	const mcp = new Mcp(stub.hub as never, undefined, { extensionLists: () => [], pollMs: 10 });
	const ask = async (args: object) => (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: args } }, "2025-06-18", {})) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: { projects: { id: string }[]; studioPlaces: unknown[] } } };
	const narrowed = await ask({ project: "Game" });
	assert.ok(!narrowed.result.isError, narrowed.result.content[0].text);
	assert.deepEqual(narrowed.result.structuredContent!.projects.map((entry) => entry.id), ["game"]);
	const mine = await ask({ path: repo, mine: true });
	assert.ok(!mine.result.isError, mine.result.content[0].text);
	assert.deepEqual(mine.result.structuredContent!.projects.map((entry) => entry.id), ["game"]);
	const lost = await ask({ mine: true });
	assert.equal(lost.result.isError, true);
	assert.match(lost.result.content[0].text, /mine needs path/);
});

test("version lists a place being reopened, and the claim refusal names release with a path release accepts", async () => {
	const repo = tempRepo();
	const stub = versionsStub(repo, []);
	(stub.slot as any).listedPlaces = [{ placeId: 111, placeName: "Lobby", open: false, busy: "reopening", error: null }];
	const mcp = new Mcp(stub.hub as never, undefined, { extensionLists: () => [], pollMs: 10 });
	const answer = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "version", arguments: { path: repo } } }, "2025-06-18", {})) as { result: { content: { text: string }[]; structuredContent: { reopening: unknown[] } } };
	assert.deepEqual(answer.result.structuredContent.reopening, [{ placeId: 111, name: "Lobby" }]);
	assert.ok(answer.result.content[0].text.includes("Reopening now (not listed above until it is back): Lobby (place 111)."));

	const claimed = stubHub(repo, { key: "worktree:" + pathKey(repo), label: "Elsewhere", until: Date.now() + 600_000 });
	const other = tempRepo();
	const refused = (await new Mcp(claimed.hub as never, undefined, { extensionLists: () => [], pollMs: 10 }).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "serve_here", arguments: { path: other, project: "Game" } } }, "2025-06-18", {})) as { result: { content: { text: string }[] } };
	assert.ok(refused.result.content[0].text.includes(`call release with path = ${pathKey(repo)}`), refused.result.content[0].text);
});
