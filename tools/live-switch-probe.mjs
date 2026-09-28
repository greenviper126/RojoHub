#!/usr/bin/env node
/*
	Measures whether Rojo 7.7 applies a rewritten $path live, over the session
	Studio is already connected to. Spec 001, "Live-switch measurement".

	It serves a generated project file by its verbatim (\\?\) path, which is
	what makes Rojo notice the rewrite on Windows: Rojo canonicalizes change
	events to \\?\C:\..., and the project root is registered under whatever
	path the serve command was given, so a plain C:\... path never matches and
	the rewrite is silently dropped. Every $path is absolute for the same
	reason: a verbatim path does no ".." processing.

	Usage:  node tools/live-switch-probe.mjs serve <tiny|repo> <repo>
	                                                             start rojo on the probe port, serving A
	        node tools/live-switch-probe.mjs switch <a|b>        rewrite the project file to the other tree
	        node tools/live-switch-probe.mjs edit <a|b>          append a line to Foo in that tree (tiny only)
	        node tools/live-switch-probe.mjs status              print the served project name and session id
	        node tools/live-switch-probe.mjs stop                stop the probe's rojo

	<repo> is a Rojo project's git checkout with a rokit.toml pinning rojo.
	"tiny" is a two-tree fixture made here, served with that repo's rojo.
	"repo" serves the repo's real default.project.json: A is the repo's
	folder, B an archive of its HEAD~40.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 34880;
const ROOT = join(tmpdir(), "rojo-hub-probe");
const PROJECT = join(ROOT, "slot.project.json");
const STATE = join(ROOT, "state.json");
const LOG = join(ROOT, "serve.log");
const PACKAGE_PATHS = new Set(["Packages", "ServerPackages"]);

const [command = "status", arg, repoArg] = process.argv.slice(2);
const USAGE = "Usage: node tools/live-switch-probe.mjs serve <tiny|repo> <path to a Rojo project's git checkout with a rokit.toml>";

function makeTiny() {
	const trees = {};
	for (const name of ["a", "b"]) {
		const tree = join(ROOT, "tiny", name);
		rmSync(tree, { recursive: true, force: true });
		mkdirSync(join(tree, "Server"), { recursive: true });
		mkdirSync(join(tree, "Shared"), { recursive: true });
		writeFileSync(join(tree, "Server", "Foo.server.luau"), `print("Foo from tree ${name.toUpperCase()}")\n`);
		writeFileSync(join(tree, "Shared", "Which.luau"), `return "${name.toUpperCase()}"\n`);
		trees[name] = tree;
	}
	writeFileSync(join(trees.b, "Server", "OnlyInB.server.luau"), `print("this script exists only in tree B")\n`);
	const base = {
		name: "RojoHubProbe",
		tree: {
			$className: "DataModel",
			ServerScriptService: { $className: "ServerScriptService", RojoHubProbe: { $path: "Server" } },
			ReplicatedStorage: { $className: "ReplicatedStorage", RojoHubProbe: { $path: "Shared" } },
		},
	};
	return { base, trees, packagesFrom: null };
}

function makeRepo(repo) {
	const old = join(ROOT, "repo-old");
	rmSync(old, { recursive: true, force: true });
	mkdirSync(old, { recursive: true });
	const archive = execFileSync("git", ["archive", "HEAD~40", "src"], { cwd: repo, maxBuffer: 1 << 28 });
	execFileSync("tar", ["-x", "-C", old], { input: archive });
	const base = JSON.parse(readFileSync(join(repo, "default.project.json"), "utf8"));
	return { base, trees: { a: repo, b: old }, packagesFrom: repo };
}

/*
	Every $path becomes absolute inside the chosen tree; package roots stay on
	packagesFrom when one is given, as ServeWorktree.mjs does for worktrees
	that have not run Wally.
*/
function redirect(node, tree, packagesFrom) {
	if (Array.isArray(node)) return node.map((item) => redirect(item, tree, packagesFrom));
	if (node === null || typeof node !== "object") return node;
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			out[key] = join(packagesFrom && PACKAGE_PATHS.has(value) ? packagesFrom : tree, value);
		} else {
			out[key] = redirect(value, tree, packagesFrom);
		}
	}
	return out;
}

function writeProject(state, which) {
	const project = redirect(state.base, state.trees[which], state.packagesFrom);
	writeFileSync(PROJECT, JSON.stringify(project, null, 2) + "\n");
	writeFileSync(STATE, JSON.stringify({ ...state, serving: which }, null, 2));
}

async function info() {
	try {
		const response = await fetch(`http://localhost:${PORT}/api/rojo`, { signal: AbortSignal.timeout(1500) });
		const bytes = Buffer.from(await response.arrayBuffer());
		const read = (key) => {
			let at = bytes.indexOf(key);
			if (at < 0) return null;
			at += key.length;
			const tag = bytes[at++];
			let length;
			if (tag >= 0xa0 && tag <= 0xbf) length = tag & 0x1f;
			else if (tag === 0xd9) length = bytes[at++];
			else if (tag === 0xda) (length = bytes.readUInt16BE(at)), (at += 2);
			else return null;
			return bytes.toString("utf8", at, at + length);
		};
		return { projectName: read("projectName"), sessionId: read("sessionId") };
	} catch {
		return null;
	}
}

function stop() {
	const script =
		"Get-CimInstance Win32_Process -Filter \"Name='rojo.exe'\" | " +
		`Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape('--port ${PORT}') } | ` +
		"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
	spawnSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

async function main() {
	mkdirSync(ROOT, { recursive: true });
	if (command === "serve") {
		if ((arg !== "tiny" && arg !== "repo") || !repoArg || !existsSync(join(repoArg, "rokit.toml"))) throw new Error(USAGE);
		const repo = resolve(repoArg);
		stop();
		const fixture = arg === "repo" ? makeRepo(repo) : makeTiny();
		const state = { fixture: arg, ...fixture };
		writeProject(state, "a");
		const log = openSync(LOG, "w");
		const cwd = state.fixture === "repo" ? repo : ROOT;
		if (state.fixture === "tiny") writeFileSync(join(ROOT, "rokit.toml"), readFileSync(join(repo, "rokit.toml")));
		const child = spawn("rojo.exe", ["serve", "\\\\?\\" + PROJECT, "--port", String(PORT)], {
			cwd,
			detached: true,
			windowsHide: true,
			stdio: ["ignore", log, log],
		});
		child.unref();
		for (let i = 0; i < 60; i++) {
			const now = await info();
			if (now) return console.log(`Serving ${state.fixture} tree A on localhost:${PORT} (session ${now.sessionId}).`);
			await new Promise((done) => setTimeout(done, 250));
		}
		throw new Error(`Rojo did not come up:\n${readFileSync(LOG, "utf8")}`);
	} else if (command === "switch") {
		if (arg !== "a" && arg !== "b") throw new Error("switch needs a or b");
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		const before = await info();
		writeProject(state, arg);
		console.log(`Project file now points at tree ${arg.toUpperCase()} (${state.trees[arg]}). Session ${before?.sessionId ?? "none"}.`);
	} else if (command === "edit") {
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		if (state.fixture !== "tiny") throw new Error("edit only works on the tiny fixture");
		const file = join(state.trees[arg ?? state.serving], "Server", "Foo.server.luau");
		appendFileSync(file, `print("edited at ${new Date().toLocaleTimeString()}")\n`);
		console.log(`Appended a line to ${file}.`);
	} else if (command === "status") {
		const now = await info();
		const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
		console.log(now ? `Rojo on ${PORT}: "${now.projectName}", session ${now.sessionId}, serving tree ${state?.serving?.toUpperCase()}.` : `Nothing on ${PORT}.`);
	} else if (command === "stop") {
		stop();
		console.log(`Stopped the probe's rojo on ${PORT}.`);
	} else {
		throw new Error(`Unknown command ${command}`);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
