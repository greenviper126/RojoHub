import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { pathKey } from "../common/paths";
import { fromEditor, parseSetupText, splitLine, toEditor } from "../common/setupText";
import { AUDIT_FILE, AUDIT_MAX_BYTES, AUDIT_OLD_FILE, writeAudit } from "../service/audit";
import { Hub, SetupFailed } from "../service/hub";
import { savePortSettings } from "../service/ports";
import { Conflict } from "../service/registry";
import { commandText, installChecks, normaliseRepoKey, parseSetupCommands, resolveCommand, runSetup, SetupJobs, tailOf, withPathFirst, type SetupCommand } from "../service/setup";

/*
	Setup commands (spec 012, designs 1 to 3), against temp git repos and node
	scripts as the "programs". Nothing here touches a real repo, the real hub
	home or the real Studio plugins folder.
*/

const NODE = process.execPath;
const windows = process.platform === "win32";
const temp = (name: string) => mkdtempSync(join(tmpdir(), `rojo-hub-${name}-`));
const script = (dir: string, name: string, body: string) => {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
};
const node = (file: string, ...args: string[]): SetupCommand => ({ command: NODE, args: [file, ...args], timeoutSeconds: 60 });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function repoWithProject(): string {
	const dir = temp("setup-repo");
	const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
	run("init", "-q", "-b", "main");
	writeFileSync(join(dir, "default.project.json"), JSON.stringify({ name: "SetupGame", tree: { $className: "DataModel" } }));
	run("add", ".");
	run("commit", "-q", "-m", "one");
	return dir;
}

/* ---------- the setting ---------- */

test("setupCommands: valid entries parse, keys are normalised, defaults filled", () => {
	const parsed = parseSetupCommands({ "C:\\Users\\Me\\Games\\Laundry\\": [{ command: "wally", args: ["install"] }, { command: "npm", args: ["ci"], cwd: "tools", timeoutSeconds: 300 }] }, () => null);
	assert.equal(parsed.problems.size, 0);
	const commands = parsed.entries.get(normaliseRepoKey("c:/users/me/games/laundry"))!;
	assert.equal(commands.length, 2);
	assert.deepEqual(commands[0], { command: "wally", args: ["install"], timeoutSeconds: 600 });
	assert.deepEqual(commands[1], { command: "npm", args: ["ci"], cwd: "tools", timeoutSeconds: 300 });
	assert.equal(normaliseRepoKey("\\\\?\\C:\\Repo\\"), normaliseRepoKey("c:/repo"), "case, slash style, trailing slash and the verbatim prefix do not matter");
	assert.equal(parseSetupCommands(undefined).entries.size, 0);
	assert.equal(parseSetupCommands({}).entries.size, 0);
});

test("setupCommands: every invalid shape is rejected with a message naming the entry", () => {
	const bad = (entry: unknown, pattern: RegExp) => {
		const parsed = parseSetupCommands({ "C:\\Repo": [entry] }, () => null);
		const problems = [...parsed.problems.values()].flat();
		assert.equal(parsed.entries.size, 0, "an entry with a problem is left out as a whole");
		assert.ok(problems.some((line) => pattern.test(line) && line.includes("C:\\Repo") && line.includes("command 1")), JSON.stringify(problems));
	};
	bad("npm ci", /must be an object/);
	bad({ args: ["x"] }, /command must be a non-empty string/);
	bad({ command: "npm", args: "ci" }, /args must be a list of strings/);
	bad({ command: "npm", args: [1] }, /args must be a list of strings/);
	bad({ command: "npm", cwd: "..\\evil" }, /"\.\."/);
	bad({ command: "npm", cwd: "a/../../b" }, /"\.\."/);
	bad({ command: "npm", cwd: "C:\\Windows" }, /relative/);
	bad({ command: "npm", cwd: "/etc" }, /relative/);
	bad({ command: "npm", timeoutSeconds: 0 }, /timeoutSeconds/);
	bad({ command: "npm", timeoutSeconds: 3601 }, /timeoutSeconds/);
	const eleven = parseSetupCommands({ "C:\\Repo": Array.from({ length: 11 }, () => ({ command: "x" })) }, () => null);
	assert.match([...eleven.problems.values()].flat().join(), /at most 10/);
	assert.match([...parseSetupCommands([] as never).problems.values()].flat().join(), /must be an object/);
	assert.match([...parseSetupCommands({ "C:\\Repo": "wally install" }).problems.values()].flat().join(), /list of commands/);
});

test("setupCommands: a .cmd or .bat command refuses cmd.exe metacharacters in its arguments", () => {
	const resolver = (command: string) => (command === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : command === "wally" ? "C:\\x\\wally.exe" : null);
	for (const arg of ["a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", "!X!", 'say "hi"', "`x`", "a\nb"]) {
		const parsed = parseSetupCommands({ "C:\\Repo": [{ command: "npm", args: ["ci", arg] }] }, resolver);
		assert.equal(parsed.entries.size, 0, `${JSON.stringify(arg)} is refused for npm.cmd`);
		assert.match([...parsed.problems.values()].flat().join(), /cmd\.exe/);
	}
	assert.equal(parseSetupCommands({ "C:\\Repo": [{ command: "build.bat", args: ["a&b"] }] }, () => null).entries.size, 0, "a name ending in .bat counts without resolving");
	assert.equal(parseSetupCommands({ "C:\\Repo": [{ command: "npm", args: ["ci", "--ignore-scripts", "some thing"] }] }, resolver).entries.size, 1, "plain arguments, spaces included, are fine");
	if (windows) assert.equal(parseSetupCommands({ "C:\\Repo": [{ command: "wally", args: ["a&b"] }] }, resolver).entries.size, 1, "an .exe takes no shell, so any characters are fine");
});

test("resolveCommand: PATH and PATHEXT, a path as given, nothing for a missing program", () => {
	const dir = temp("resolve");
	const tool = script(dir, windows ? "mytool.cmd" : "mytool", windows ? "@echo hi\r\n" : "#!/bin/sh\necho hi\n");
	const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	assert.equal(resolveCommand("mytool", env)?.toLowerCase(), tool.toLowerCase());
	assert.equal(resolveCommand(tool, env)?.toLowerCase(), tool.toLowerCase(), "an absolute path");
	assert.equal(resolveCommand("no-such-tool-xyz", env), null);
	assert.equal(resolveCommand(join(dir, "missing"), env), null);
	if (windows) assert.equal(resolveCommand("mytool.cmd", env)?.toLowerCase(), tool.toLowerCase(), "with its extension");
});

/* ---------- the runner ---------- */

test("runSetup: commands run in order in the worktree, with only the documented environment, no shell", async () => {
	const home = temp("home");
	const worktree = temp("tree");
	mkdirSync(join(worktree, "tools"));
	const record = script(temp("scripts"), "record.cjs", `const fs=require("fs");fs.appendFileSync(process.argv[2],JSON.stringify({argv:process.argv.slice(3),cwd:process.cwd(),branch:process.env.ROJO_HUB_BRANCH,wt:process.env.ROJO_HUB_WORKTREE,setup:process.env.ROJO_HUB_SETUP})+"\\n");`);
	const out = join(worktree, "record.jsonl");
	const branch = "a&b|c;$(x) `y`";
	const seen: string[] = [];
	const outcome = await runSetup({
		worktree,
		branch,
		home,
		actor: "mcp",
		project: "Game",
		commands: [node(record, out, "one"), { ...node(record, out, "two"), cwd: "tools" }],
		onStep: (index, of, text) => seen.push(`${index}/${of}`),
	});
	assert.ok(outcome.ok, JSON.stringify(outcome.failed));
	assert.deepEqual(seen, ["1/2", "2/2"]);
	const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines.map((line) => line.argv), [["one"], ["two"]], "argv after the output path");
	assert.equal(pathOf(lines[0].cwd), pathOf(worktree));
	assert.equal(pathOf(lines[1].cwd), pathOf(join(worktree, "tools")));
	assert.equal(lines[0].branch, branch, "the branch name arrives in the environment, unchanged");
	assert.equal(pathOf(lines[0].wt), pathOf(worktree));
	assert.equal(lines[0].setup, "1");
	assert.ok(!JSON.stringify(lines.map((line) => line.argv)).includes("&"), "the branch name is in no argv");
	// one audit line per command, with or without anything else on
	const audit = readFileSync(join(home, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(audit.length, 2);
	assert.equal(audit[0].action, "setup");
	assert.equal(audit[0].actor, "mcp");
	assert.equal(audit[0].exitCode, 0);
	assert.deepEqual(audit[0].argv, [NODE, record, out, "one"]);
});
const pathOf = (path: string) => path.replace(/\\/g, "/").toLowerCase();

test("runSetup: a non-zero exit stops the list and names the command, code and output", async () => {
	const home = temp("home");
	const worktree = temp("tree");
	const dir = temp("scripts");
	const ok = script(dir, "ok.cjs", `console.log("fine");`);
	const bad = script(dir, "bad.cjs", `console.error("boom: wally could not install");process.exit(3);`);
	const never = script(dir, "never.cjs", `require("fs").writeFileSync(${JSON.stringify(join(worktree, "never.txt"))},"x");`);
	const outcome = await runSetup({ worktree, home, actor: "panel", project: "Game", commands: [node(ok), node(bad), node(never)] });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.steps.length, 2, "the third command never ran");
	assert.ok(!existsSync(join(worktree, "never.txt")));
	assert.equal(outcome.failed!.exitCode, 3);
	assert.equal(outcome.failed!.reason, "exit");
	assert.equal(outcome.failed!.index, 2);
	assert.match(outcome.failed!.tail, /boom: wally could not install/);
	const text = new SetupFailed(outcome).message;
	assert.match(text, /bad\.cjs/);
	assert.match(text, /step 2 of 3/);
	assert.match(text, /code 3/);
	assert.match(text, /boom/);
	assert.ok(text.includes(worktree), "the worktree path");
	assert.match(text, /setup 1 of 3: .*ok/, "the earlier command that succeeded is listed");
	assert.match(text, /call ensure/);
});

test("runSetup: a missing command is a spawn failure that stops the list", async () => {
	const outcome = await runSetup({ worktree: temp("tree"), home: temp("home"), actor: "mcp", project: "Game", env: { PATH: temp("empty"), PATHEXT: ".EXE;.CMD" }, commands: [{ command: "definitely-not-installed", args: [], timeoutSeconds: 5 }] });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.failed!.reason, "spawn");
	assert.match(outcome.failed!.error!, /not found/);
});

test("runSetup: output is cut to the last 40 lines and 4 KB", async () => {
	const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
	assert.equal(tailOf(lines).split("\n").length, 40);
	assert.match(tailOf(lines), /^line 61\n/);
	assert.ok(tailOf(lines).endsWith("line 100"));
	const long = Array.from({ length: 40 }, () => "x".repeat(300)).join("\n");
	assert.ok(Buffer.byteLength(tailOf(long)) <= 4096 + 4, "at most 4 KB (plus the ellipsis)");
	const dir = temp("scripts");
	const noisy = script(dir, "noisy.cjs", `for(let i=1;i<=100;i++)console.log("line "+i);process.exit(1);`);
	const outcome = await runSetup({ worktree: temp("tree"), home: temp("home"), actor: "mcp", project: "Game", commands: [node(noisy)] });
	assert.equal(outcome.failed!.tail.split("\n").length, 40);
	assert.ok(outcome.failed!.tail.endsWith("line 100"));
});

test("runSetup: a timeout kills the whole process tree and stops the list", async () => {
	const dir = temp("scripts");
	const worktree = temp("tree");
	const marker = join(worktree, "grandchild.txt");
	const grandchild = script(dir, "grandchild.cjs", `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"),3000);`);
	const parent = script(dir, "parent.cjs", `require("child_process").spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:"inherit"});setTimeout(()=>{},60000);`);
	const started = Date.now();
	const outcome = await runSetup({ worktree, home: temp("home"), actor: "mcp", project: "Game", commands: [{ ...node(parent), timeoutSeconds: 1 }, node(grandchild)] });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.failed!.reason, "timeout");
	assert.match(outcome.failed!.error!, /timed out after 1 s/);
	assert.equal(outcome.steps.length, 1);
	assert.ok(Date.now() - started < 6000, "it did not wait for the 60 s sleeper");
	await sleep(3500);
	assert.ok(!existsSync(marker), "the grandchild was killed with its parent");
});

test("runSetup: the whole list is capped, and later commands are not run past it", async () => {
	const dir = temp("scripts");
	const slow = script(dir, "slow.cjs", `setTimeout(()=>{},400);`);
	const outcome = await runSetup({ worktree: temp("tree"), home: temp("home"), actor: "mcp", project: "Game", totalLimitMs: 300, commands: [node(slow), node(slow)] });
	assert.equal(outcome.ok, false);
	assert.ok(outcome.failed);
});

test("runSetup: a .cmd file runs through cmd.exe with its arguments intact (Windows)", { skip: !windows }, async () => {
	const dir = temp("cmd");
	const worktree = temp("tree");
	const cmd = script(dir, "shim.cmd", `@echo off\r\necho %~1^|%~2> "${join(worktree, "cmd-out.txt")}"\r\n`);
	const outcome = await runSetup({ worktree, home: temp("home"), actor: "mcp", project: "Game", commands: [{ command: cmd, args: ["first", "second word"], timeoutSeconds: 30 }] });
	assert.ok(outcome.ok, JSON.stringify(outcome.failed));
	assert.equal(readFileSync(join(worktree, "cmd-out.txt"), "utf8").trim(), "first|second word");
	// found through PATH and PATHEXT as plain `shim`
	const viaPath = await runSetup({ worktree, home: temp("home"), actor: "mcp", project: "Game", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, commands: [{ command: "shim", args: ["x", "y"], timeoutSeconds: 30 }] });
	assert.ok(viaPath.ok, JSON.stringify(viaPath.failed));
	assert.equal(readFileSync(join(worktree, "cmd-out.txt"), "utf8").trim(), "x|y");
});

test("commandText: how an answer names a command", () => {
	assert.equal(commandText({ command: "wally", args: ["install"] }), "wally install");
	assert.equal(commandText({ command: "npm", args: ["run", "a b"] }), 'npm run "a b"');
});

/* ---------- jobs ---------- */

test("SetupJobs: a second request for a worktree joins the running setup, a finished one is run again", async () => {
	const jobs = new SetupJobs();
	let runs = 0;
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	const run = async () => {
		runs++;
		await gate;
		return { ok: true, steps: [], failed: null, worktree: "C:\\wt", branch: null };
	};
	const first = jobs.start("C:\\wt", "mcp", null, 1, run);
	const second = jobs.start("c:/WT/", "panel", null, 1, run);
	assert.equal(first.joined, false);
	assert.equal(second.joined, true);
	assert.equal(second.job, first.job);
	assert.equal(jobs.running("C:\\wt"), first.job);
	release();
	await first.job.promise;
	assert.equal(runs, 1);
	assert.equal(jobs.running("C:\\wt"), null);
	assert.equal(jobs.get("C:\\wt")!.state, "ok");
	assert.equal(jobs.start("C:\\wt", "mcp", null, 1, run).joined, false, "after it finished, a new request runs it again");
	assert.equal(runs, 2);
});

/* ---------- the audit log ---------- */

test("audit: appends one JSON line per entry and rotates at 1 MB", () => {
	const home = temp("audit");
	writeAudit(home, { action: "one", n: 1 });
	writeAudit(home, { action: "two" });
	const lines = readFileSync(join(home, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines.map((line) => line.action), ["one", "two"]);
	assert.match(lines[0].time, /^\d{4}-\d\d-\d\dT/);
	writeFileSync(join(home, AUDIT_FILE), "x".repeat(AUDIT_MAX_BYTES) + "\n");
	writeAudit(home, { action: "after" });
	assert.ok(existsSync(join(home, AUDIT_OLD_FILE)), "the full log moved aside");
	assert.ok(statSync(join(home, AUDIT_OLD_FILE)).size >= AUDIT_MAX_BYTES);
	assert.deepEqual(readFileSync(join(home, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line).action), ["after"]);
	writeAudit(join(home, "no", "such", "folder"), { action: "x" });
});

/* ---------- the install checks ---------- */

test("installChecks: wally.toml sections map to folders, package.json to node_modules, borrowed wording, sourcemap states", () => {
	const rojo = { ok: true as const, binary: "rojo.exe", version: "7.7.0", manifest: "rokit.toml" };
	const base = { rojo, borrowed: false, sourcemapsOn: false, sourcemap: { state: "off", detail: "" }, servedTree: null, serving: true };
	const by = (checks: ReturnType<typeof installChecks>) => Object.fromEntries(checks.map((check) => [check.name, check]));

	const empty = temp("checks");
	assert.ok(installChecks(empty, base).every((check) => check.ok), "no wally.toml, no package.json: all ok");

	const tree = temp("checks");
	writeFileSync(join(tree, "wally.toml"), `[package]\nname = "a/b"\n[dependencies]\nRoact = "a/roact@1"\n[server-dependencies]\nX = "a/x@1"\n[dev-dependencies]\n`);
	let checks = by(installChecks(tree, base));
	assert.equal(checks.packages.ok, false);
	assert.match(checks.packages.detail, /Packages, ServerPackages missing/);
	assert.ok(!/DevPackages/.test(checks.packages.detail), "an empty section needs no folder");
	assert.match(by(installChecks(tree, { ...base, borrowed: true })).packages.detail, /main checkout's copy/);
	mkdirSync(join(tree, "Packages"));
	mkdirSync(join(tree, "ServerPackages"));
	assert.equal(by(installChecks(tree, base)).packages.ok, true);

	writeFileSync(join(tree, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5" } }));
	checks = by(installChecks(tree, base));
	assert.equal(checks.node_modules.ok, false);
	mkdirSync(join(tree, "node_modules"));
	assert.equal(by(installChecks(tree, base)).node_modules.ok, true);
	writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "x" }));
	rmDir(join(tree, "node_modules"));
	assert.equal(by(installChecks(tree, base)).node_modules.ok, true, "a package.json without dependencies needs none");

	assert.equal(by(installChecks(tree, { ...base, rojo: { ok: false, error: "Rojo 7.7.0 is not installed" } })).rojo.detail, "Rojo 7.7.0 is not installed");

	// sourcemap
	const served = temp("served");
	const on = { ...base, sourcemapsOn: true, servedTree: served };
	assert.equal(by(installChecks(tree, { ...on, sourcemap: { state: "error", detail: "not gitignored" } })).sourcemap.detail, "not gitignored");
	assert.match(by(installChecks(tree, { ...on, sourcemap: { state: "watching", detail: "kept" } })).sourcemap.detail, /not written yet/);
	writeFileSync(join(served, "sourcemap.json"), "{}");
	assert.equal(by(installChecks(served, { ...on, sourcemap: { state: "watching", detail: "kept" } })).sourcemap.ok, true);
	assert.match(by(installChecks(tree, { ...on, serving: false, sourcemap: { state: "off", detail: "stopped" } })).sourcemap.detail, /for the worktree being served/, "says it reports on the served worktree");
});
function rmDir(path: string): void {
	execFileSync(process.execPath, ["-e", `require("fs").rmSync(${JSON.stringify(path)},{recursive:true,force:true})`]);
}

/* ---------- the hub: bookkeeping and new_branch ---------- */

async function hubWithRepo(commands: SetupCommand[] | null) {
	const home = temp("hub-home");
	const repo = repoWithProject();
	if (commands) savePortSettings(home, { setupCommands: { [repo]: commands } });
	const hub = new Hub(home);
	const view = await hub.add(repo);
	return { hub, home, repo, id: view.id, slot: hub.registry.get(view.id) };
}

test("hub: worktreeRead follows what a running rojo was pointed at, and forgets it when rojo stops", async () => {
	const { hub, repo, id, slot } = await hubWithRepo(null);
	try {
		const worktree = join(temp("wt"), "feature");
		execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: repo });
		const other = join(temp("wt"), "other");
		execFileSync("git", ["worktree", "add", "-q", "-b", "other", other], { cwd: repo });
		const runtime = (hub as unknown as { runtime(id: string): { state: string; served: Set<string> } }).runtime(id);
		assert.equal(hub.worktreeRead(worktree), false, "a stopped slot has read nothing");
		assert.equal(await hub.isLinkedWorktree(worktree), true);
		assert.equal(await hub.isLinkedWorktree(repo), false, "the main checkout is not a linked worktree");

		runtime.state = "running"; // as if rojo were serving: switch writes the files and records the target
		await hub.switch(id, { kind: "worktree", path: worktree });
		assert.equal(hub.worktreeRead(worktree), true, "now the slot's target");
		await hub.switch(id, { kind: "worktree", path: other });
		assert.equal(hub.worktreeRead(worktree), true, "no longer the target, but this rojo has read it");
		assert.equal(hub.worktreeRead(other), true);
		const third = join(temp("wt"), "third");
		execFileSync("git", ["worktree", "add", "-q", "-b", "third", third], { cwd: repo });
		assert.equal(hub.worktreeRead(third), false, "never served");
		assert.match((await hub.setupRefusal(slot, worktree)) ?? "", /being served/);
		assert.match((await hub.setupRefusal(slot, repo)) ?? "", /main checkout/);
		assert.equal(await hub.setupRefusal(slot, third), null);

		// stopping rojo forgets it
		await (hub as unknown as { stopLocked(slot: unknown): Promise<void> }).stopLocked(slot);
		assert.equal(hub.worktreeRead(worktree), false);
		assert.equal(await hub.setupRefusal(slot, worktree), null, "a stopped project may be set up in any linked worktree");
		runtime.state = "starting";
		runtime.served.add(pathKey(worktree)); // the service expands short Windows names (RUNNER~1) in its keys; so must the test
		assert.equal(hub.worktreeRead(worktree), true, "starting counts too");
	} finally {
		await hub.shutdown(false);
	}
});

test("hub.createBranch: setup runs after the worktree exists and before the switch; a failure keeps the worktree and does not switch", async () => {
	const dir = temp("scripts");
	const marker = script(dir, "marker.cjs", `const fs=require("fs"),path=require("path");fs.mkdirSync("Packages",{recursive:true});fs.writeFileSync(path.join("Packages","marker.txt"),process.env.ROJO_HUB_BRANCH);`);
	const { hub, repo, id } = await hubWithRepo([node(marker)]);
	try {
		const real = hub.switch.bind(hub);
		const order: string[] = [];
		let markerSeen: string | null = null;
		hub.switch = async (slotId, target) => {
			order.push("switch");
			if (target.kind === "worktree") markerSeen = existsSync(join(target.path, "Packages", "marker.txt")) ? readFileSync(join(target.path, "Packages", "marker.txt"), "utf8") : null;
			return real(slotId, target);
		};
		const targetBefore = hub.registry.get(id).target;
		const made = await hub.createBranch(id, "feat/with-setup", "main", { actor: "mcp" });
		assert.deepEqual(order, ["switch"]);
		assert.equal(markerSeen, "feat/with-setup", "the setup had finished (and saw the branch in its environment) when the switch happened");
		assert.equal(made.switched, true);
		assert.equal(made.setupNotes.length, 1);
		assert.match(made.setupNotes[0], /setup 1 of 1/);
		assert.notDeepEqual(hub.registry.get(id).target, targetBefore);

		// a failing command
		const bad = script(dir, "bad.cjs", `console.error("wally: no network");process.exit(7);`);
		savePortSettings(hub.home, { setupCommands: { [repo]: [node(bad)] } });
		(hub as unknown as { setupParsed: unknown }).setupParsed = null;
		order.length = 0;
		const targetNow = JSON.stringify(hub.registry.get(id).target);
		let error: unknown;
		try {
			await hub.createBranch(id, "feat/broken", "main", { actor: "mcp" });
		} catch (caught) {
			error = caught;
		}
		assert.ok(error instanceof SetupFailed, String(error));
		assert.ok(error instanceof Conflict);
		assert.match((error as Error).message, /bad\.cjs/);
		assert.match((error as Error).message, /code 7/);
		assert.match((error as Error).message, /wally: no network/);
		assert.deepEqual(order, [], "nothing was switched");
		assert.equal(JSON.stringify(hub.registry.get(id).target), targetNow, "the project serves what it served");
		const worktree = (error as SetupFailed).outcome.worktree;
		assert.ok(existsSync(worktree), "the worktree is kept");
		assert.ok(execFileSync("git", ["branch", "--list", "feat/broken"], { cwd: repo, encoding: "utf8" }).includes("feat/broken"), "so is the branch");
		assert.equal(hub.claimOf(id), null, "no claim");
	} finally {
		await hub.shutdown(false);
	}
});

test("hub.createBranch: without an entry nothing runs; a broken entry is reported before anything is made", async () => {
	const none = await hubWithRepo(null);
	try {
		const made = await none.hub.createBranch(none.id, "plain", "main");
		assert.equal(made.switched, true);
		assert.deepEqual(made.setupNotes, []);
		assert.equal(none.hub.setupJobs.all().length, 0);
	} finally {
		await none.hub.shutdown(false);
	}
	const home = temp("hub-home");
	const repo = repoWithProject();
	savePortSettings(home, { setupCommands: { [repo]: [{ command: "npm", cwd: "..\\x" }] } });
	const hub = new Hub(home);
	try {
		await hub.add(repo);
		assert.ok(hub.setupProblems().length > 0);
		await assert.rejects(hub.createBranch("setupgame", "never", "main"), /invalid, so no setup was run/);
		assert.equal(execFileSync("git", ["branch", "--list", "never"], { cwd: repo, encoding: "utf8" }).trim(), "", "no branch was made");
	} finally {
		await hub.shutdown(false);
	}
});

test("hub.createBranch: setup still running after the wait leaves the worktree unswitched, joins, and refuses a switch meanwhile", async () => {
	const dir = temp("scripts");
	const slow = script(dir, "slow.cjs", `setTimeout(()=>require("fs").writeFileSync("done.txt","x"),1200);`);
	const { hub, id } = await hubWithRepo([node(slow)]);
	try {
		const made = await hub.createBranch(id, "slow", "main", { actor: "mcp", setupWaitMs: 200 });
		assert.equal(made.switched, false);
		assert.match(made.setupNotes[0], /still running/);
		assert.equal(hub.setupJobs.running(made.path)?.state, "running");
		await assert.rejects(hub.switch(id, { kind: "worktree", path: made.path }), /Setup is still running.*ensure/);
		// ensure from that worktree joins it: one run, not two
		const joined = await hub.setupWorktree(id, made.path, { actor: "mcp", branch: null, waitMs: 20000 });
		assert.equal(joined!.joined, true);
		assert.equal(joined!.outcome!.ok, true);
		assert.ok(existsSync(join(made.path, "done.txt")));
		assert.equal(hub.setupJobs.running(made.path), null);
		const view = await hub.switch(id, { kind: "worktree", path: made.path });
		assert.equal(view.target.kind, "worktree");
	} finally {
		await hub.shutdown(false);
	}
});

test("hub.setupWorktree: concurrent requests run the commands once; the main checkout and a served worktree are refused", async () => {
	const dir = temp("scripts");
	const append = script(dir, "append.cjs", `require("fs").appendFileSync("runs.txt","run\\n");setTimeout(()=>{},300);`);
	const { hub, repo, id } = await hubWithRepo([node(append)]);
	try {
		const worktree = join(temp("wt"), "manual");
		execFileSync("git", ["worktree", "add", "-q", "-b", "manual", worktree], { cwd: repo });
		const [a, b] = await Promise.all([hub.setupWorktree(id, worktree, { actor: "mcp", branch: null }), hub.setupWorktree(id, worktree, { actor: "mcp", branch: null })]);
		assert.equal(a!.job, b!.job);
		assert.equal(readFileSync(join(worktree, "runs.txt"), "utf8"), "run\n", "one run");
		// after a failure-free run a later request runs it again (the caller decides by the checks)
		await assert.rejects(hub.setupWorktree(id, repo, { actor: "mcp", branch: null }), /main checkout/);
		assert.equal(existsSync(join(repo, "runs.txt")), false, "never in the main checkout");
		const runtime = (hub as unknown as { runtime(id: string): { state: string } }).runtime(id);
		runtime.state = "running";
		await hub.switch(id, { kind: "worktree", path: worktree });
		await assert.rejects(hub.setupWorktree(id, worktree, { actor: "mcp", branch: null }), /being served/);
	} finally {
		await hub.shutdown(false);
	}
});

test("withPathFirst: replaces the path variable whatever its case, leaving exactly one", () => {
	const env = withPathFirst({ Path: "C:\a", Other: "x" }, "C:\rokit");
	assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase() === "PATH"), ["Path"]);
	assert.equal(env.Path, `C:\rokit${delimiter}C:\a`);
	assert.equal(env.Other, "x");
	assert.equal(withPathFirst({}, "C:\rokit").PATH, "C:\rokit");
});

test("runSetup: a .cmd the parse-time check never saw is re-checked after resolution", { skip: !windows }, async () => {
	const dir = temp("recheck");
	const tool = script(dir, "t.cmd", "@echo hi\r\n");
	const outcome = await runSetup({ worktree: dir, commands: [{ command: tool, args: ["a!b"], timeoutSeconds: 20 }], home: temp("recheck-home"), actor: "mcp", branch: null, project: "P", env: { ...process.env } });
	assert.equal(outcome.ok, false);
	assert.match(outcome.failed!.error ?? "", /cmd\.exe/);
});

test("hub.setupWorktree: a worktree of another repo is refused, whoever asks", async () => {
	const dir = temp("scripts");
	const mark = script(dir, "mark.cjs", `require("fs").writeFileSync("ran.txt","x");`);
	const { hub, id, slot } = await hubWithRepo([node(mark)]);
	try {
		const foreign = repoWithProject();
		const foreignTree = join(temp("wt"), "foreign");
		execFileSync("git", ["worktree", "add", "-q", "-b", "foreign", foreignTree], { cwd: foreign });
		assert.match((await hub.setupRefusal(slot, foreignTree)) ?? "", /not a worktree of/);
		await assert.rejects(hub.setupWorktree(id, foreignTree, { actor: "mcp", branch: null }), /not a worktree of/);
		assert.equal(existsSync(join(foreignTree, "ran.txt")), false, "nothing ran in the other repo");
		assert.equal(hub.setupJobs.running(foreignTree), null);
		assert.equal(hub.setupJobs.get(foreignTree), null, "a refused job is forgotten");
	} finally {
		await hub.shutdown(false);
	}
});

test("hub.setupWorktree: the job is reserved before git is asked, so a switch in that window is refused", async () => {
	const dir = temp("scripts");
	const slow = script(dir, "slow.cjs", `setTimeout(()=>{},500);`);
	const { hub, repo, id } = await hubWithRepo([node(slow)]);
	try {
		const worktree = join(temp("wt"), "race");
		execFileSync("git", ["worktree", "add", "-q", "-b", "race", worktree], { cwd: repo });
		const pending = hub.setupWorktree(id, worktree, { actor: "mcp", branch: null });
		assert.ok(hub.setupJobs.running(worktree), "running before any await returned");
		await assert.rejects(hub.switch(id, { kind: "worktree", path: worktree }), /Setup is still running/);
		assert.equal((await pending)!.outcome!.ok, true);
	} finally {
		await hub.shutdown(false);
	}
});

test("hub: what a running rojo has read is kept in served.json, restored, and unknown history refuses setup until it stops", async () => {
	const { hub, repo, id, slot, home } = await hubWithRepo(null);
	try {
		const worktree = join(temp("wt"), "kept");
		execFileSync("git", ["worktree", "add", "-q", "-b", "kept", worktree], { cwd: repo });
		const fresh = join(temp("wt"), "fresh");
		execFileSync("git", ["worktree", "add", "-q", "-b", "fresh", fresh], { cwd: repo });
		const inner = hub as unknown as { runtime(id: string): { state: string; served: Set<string>; servedUnknown: boolean }; loadServed(id: string): Set<string> | null; stopLocked(slot: unknown): Promise<void> };
		const runtime = inner.runtime(id);
		runtime.state = "running";
		await hub.switch(id, { kind: "worktree", path: worktree });
		assert.ok(existsSync(join(home, "slots", id, "served.json")));
		assert.ok(inner.loadServed(id)!.has(pathKey(worktree)), "a restarted service would read it back");
		// adoption without a saved history
		runtime.servedUnknown = true;
		assert.match((await hub.setupRefusal(slot, fresh)) ?? "", /adopted from an older service/);
		await inner.stopLocked(slot);
		assert.equal(runtime.servedUnknown, false);
		assert.equal(existsSync(join(home, "slots", id, "served.json")), false, "cleared when rojo stops");
		assert.equal(inner.loadServed(id), null);
		assert.equal(await hub.setupRefusal(slot, fresh), null);
	} finally {
		await hub.shutdown(false);
	}
});

/* ---------- the panel editor's text and the setting's declaration ---------- */

test("setup editor text: quotes group words, no escapes; round trip keeps commands set aside in settings.json", () => {
	assert.deepEqual(splitLine('npm ci --ignore-scripts'), { argv: ["npm", "ci", "--ignore-scripts"] });
	assert.deepEqual(splitLine('tool "a b" "" c'), { argv: ["tool", "a b", "", "c"] });
	assert.deepEqual(splitLine("   "), { argv: [] });
	assert.deepEqual(splitLine("a&b | c"), { argv: ["a&b", "|", "c"] }, "no shell syntax: those are just arguments");
	assert.ok("error" in splitLine('tool "open'));
	const list = [{ command: "rokit", args: ["install"] }, { command: "npm", args: ["ci"], cwd: "tools", timeoutSeconds: 300 }, { command: "wally", args: ["install", "some thing"] }];
	const editor = toEditor(list);
	assert.equal(editor.fixed.length, 1);
	assert.match(editor.text, /^rokit install\n#fixed 1  npm ci  \(cwd tools, 300 s\)\nwally install "some thing"$/);
	assert.deepEqual(fromEditor(editor.text, editor.fixed), { commands: [{ command: "rokit", args: ["install"] }, list[1], { command: "wally", args: ["install", "some thing"] }] });
	assert.deepEqual(fromEditor("wally install\n\n  \n", []), { commands: [{ command: "wally", args: ["install"] }] });
	assert.deepEqual(fromEditor("wally install\n#fixed 1", editor.fixed), { commands: [{ command: "wally", args: ["install"] }, list[1]] }, "a fixed line can be moved");
	assert.ok("error" in fromEditor("tool \"open", []));
	assert.ok("error" in fromEditor("#fixed 3", editor.fixed));
	assert.equal(parseSetupText("a b\n#fixed 2\nc \"d").map((line) => (line.fixed !== undefined ? "fixed" : line.argv ? "ok" : "bad")).join(), "ok,fixed,bad");
});

test("package.json declares rojoHub.setupCommands as an application-scoped, unsynced setting that defaults to nothing", () => {
	const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, Record<string, unknown>> } } };
	const setting = manifest.contributes.configuration.properties["rojoHub.setupCommands"];
	assert.equal(setting.scope, "application");
	assert.equal(setting.ignoreSync, true);
	assert.deepEqual(setting.default, {});
	assert.match(String(setting.markdownDescription), /^\*\*DANGEROUS/);
});
