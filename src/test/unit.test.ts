import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { expandGroup, pathBetween } from "../common/groups";
import { savedState } from "../extension/saved";
import { parseWorktrees } from "../service/git";
import { collectPaths, missingRoots, planTree, redirectPaths, slotProject, verbatim } from "../service/project";
import { assignPorts, parsePortSettings, preferredPort, type PortRequest } from "../service/ports";
import { slugify } from "../service/registry";
import { countConnections } from "../service/rojo";

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
	assert.deepEqual(savedState(home, []), { slots: [], groups: [] }, "no registry yet");
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
	assert.deepEqual(savedState(home, []), { slots: [], groups: [] }, "a broken file shows nothing rather than failing");
});
