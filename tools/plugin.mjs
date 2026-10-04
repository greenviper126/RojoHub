#!/usr/bin/env node
/*
	The Studio plugin is Rojo's plugin, unedited in plugin/upstream/, plus
	Rojo-Hub's patches (plugin/patches/) and its own code (plugin/RojoHub/),
	put together at build time (spec 010).

	node tools/plugin.mjs stage [dir]     assemble the plugin source into dir (default dist/plugin-src)
	node tools/plugin.mjs check           plugin/upstream/ matches upstream.json and every patch applies
	node tools/plugin.mjs save [dir]      rewrite plugin/patches/ from an edited stage (default dist/plugin-src)
	node tools/plugin.mjs update <tag>    move plugin/upstream/ to another Rojo release and carry the patches over

	Patches are applied here (no git needed to build). `save` and `update` use
	git for diffs and three-way merges.
*/
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugin");
const UPSTREAM = join(PLUGIN, "upstream");
const MANIFEST = join(PLUGIN, "upstream.json");
const PATCHES = join(PLUGIN, "patches");
const OURS = join(PLUGIN, "RojoHub");
const DEFAULT_STAGE = join(ROOT, "dist", "plugin-src");
const ROJO_REPO = "https://github.com/rojo-rbx/rojo";
// Upstream's plugin/ entries that are built; the rest (tests, upload details) are left out.
const PLUGIN_ENTRIES = ["src", "fmt", "http", "log", "rbx_dom_lua", "Version.txt"];
// Upstream uses TestEZ only in dev builds.
const SKIPPED_PACKAGES = new Set(["TestEZ"]);
// Files of Rojo-Hub's own that sit beside upstream's in the stage.
const EXTRA = [
	["default.project.json", "default.project.json"],
	["rbx_dom_lua.LICENSE.txt", "rbx_dom_lua/LICENSE.txt"],
];

const lf = (text) => text.replace(/\r\n/g, "\n");
const readText = (file) => lf(readFileSync(file, "utf8"));
const slash = (path) => path.split("\\").join("/");
const sha = (text) => createHash("sha256").update(text).digest("hex");

function walk(dir, base = dir, out = []) {
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, base, out);
		else out.push(slash(relative(base, full)));
	}
	return out;
}

function hashTree(dir) {
	return Object.fromEntries(walk(dir).map((file) => [file, sha(readText(join(dir, file)))]));
}

/* ---------- patches ---------- */

/** Parses a unified diff of one file: { path, hunks: [{ oldStart, lines: [" ctx" | "-old" | "+new"] }] }. */
function parsePatch(text) {
	const lines = lf(text).split("\n");
	let path = null;
	const hunks = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("+++ ")) path = line.slice(4).replace(/^b\//, "").trim();
		const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!head) continue;
		let oldCount = head[2] === undefined ? 1 : Number(head[2]);
		let newCount = head[4] === undefined ? 1 : Number(head[4]);
		const hunk = { oldStart: Number(head[1]), lines: [] };
		while (oldCount > 0 || newCount > 0) {
			const body = lines[++i];
			if (body === undefined) throw new Error(`truncated hunk in the patch for ${path}`);
			if (body.startsWith("\\")) continue;
			const kind = body[0] ?? " ";
			if (kind !== "-") newCount--;
			if (kind !== "+") oldCount--;
			hunk.lines.push(body.length === 0 ? " " : body);
		}
		hunks.push(hunk);
	}
	if (!path) throw new Error("a patch without a +++ line");
	return { path, hunks };
}

/** Applies parsed hunks to text; a hunk may have moved, never changed (no fuzz). */
function applyHunks(text, patch) {
	const lines = text.split("\n");
	let shift = 0;
	for (const hunk of patch.hunks) {
		const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
		const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
		// Where the hunk's old lines start (an insertion with no context goes after line oldStart).
		const base = before.length === 0 ? hunk.oldStart : hunk.oldStart - 1;
		const wanted = base + shift;
		const matches = (at) => at >= 0 && at + before.length <= lines.length && before.every((line, k) => lines[at + k] === line);
		let at = -1;
		for (let d = 0; d <= lines.length; d++) {
			if (matches(wanted - d)) { at = wanted - d; break; }
			if (matches(wanted + d)) { at = wanted + d; break; }
		}
		if (at < 0) throw new Error(`a hunk of ${patch.path} near line ${hunk.oldStart} no longer matches upstream`);
		lines.splice(at, before.length, ...after);
		shift = at - base + after.length - before.length;
	}
	return lines.join("\n");
}

function patchFiles() {
	return existsSync(PATCHES) ? readdirSync(PATCHES).filter((name) => name.endsWith(".patch")).sort() : [];
}

/** Diffs two texts with git; the result names `path` on both sides. Empty when equal. */
function diff(path, oldText, newText) {
	const dir = mkdtempSync(join(tmpdir(), "rojo-hub-diff-"));
	try {
		writeFileSync(join(dir, "old"), oldText);
		writeFileSync(join(dir, "new"), newText);
		const result = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "-U3", "old", "new"], { cwd: dir, encoding: "utf8" });
		if (result.status === 0) return "";
		if (result.status !== 1) throw new Error(result.stderr);
		const body = lf(result.stdout).split("\n");
		const first = body.findIndex((line) => line.startsWith("@@"));
		return [`--- a/${path}`, `+++ b/${path}`, ...body.slice(first)].join("\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const patchName = (path) => `${path.replace(/[\\/]/g, "-")}.patch`;
const writePatch = (name, text) => writeFileSync(join(PATCHES, name), text.endsWith("\n") ? text : `${text}\n`);

/* ---------- commands ---------- */

function check() {
	const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	const actual = hashTree(UPSTREAM);
	const problems = [];
	for (const [file, hash] of Object.entries(manifest.files)) {
		if (!(file in actual)) problems.push(`missing: ${file}`);
		else if (actual[file] !== hash) problems.push(`edited: ${file} (put Rojo-Hub's changes in plugin/patches/, see plugin/UPSTREAM.md)`);
	}
	for (const file of Object.keys(actual)) if (!(file in manifest.files)) problems.push(`not from upstream: ${file} (Rojo-Hub's own files go in plugin/RojoHub/)`);
	for (const name of patchFiles()) {
		try {
			const patch = parsePatch(readFileSync(join(PATCHES, name), "utf8"));
			applyHunks(readText(join(UPSTREAM, patch.path)), patch);
		} catch (error) {
			problems.push(`${name}: ${error.message}`);
		}
	}
	if (problems.length > 0) throw new Error(`plugin/upstream is not Rojo ${manifest.tag} plus plugin/patches:\n  ${problems.join("\n  ")}`);
	return manifest;
}

export function stage(dir = DEFAULT_STAGE) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	cpSync(UPSTREAM, dir, { recursive: true });
	for (const name of patchFiles()) {
		const patch = parsePatch(readFileSync(join(PATCHES, name), "utf8"));
		const target = join(dir, patch.path);
		writeFileSync(target, applyHunks(readText(target), patch));
	}
	cpSync(OURS, join(dir, "src", "RojoHub"), { recursive: true });
	for (const [from, to] of EXTRA) cpSync(join(PLUGIN, from), join(dir, to));
	return dir;
}

function save(dir = DEFAULT_STAGE) {
	const written = new Set();
	for (const file of walk(UPSTREAM)) {
		const staged = join(dir, file);
		if (!existsSync(staged)) throw new Error(`${file} is missing from ${dir}; upstream files are never removed by a patch`);
		const text = diff(file, readText(join(UPSTREAM, file)), readText(staged));
		if (!text) continue;
		mkdirSync(PATCHES, { recursive: true });
		writePatch(patchName(file), text);
		written.add(patchName(file));
	}
	for (const name of patchFiles()) if (!written.has(name)) rmSync(join(PATCHES, name));
	// Rojo-Hub's own files edited in the stage go back to plugin/RojoHub/.
	cpSync(join(dir, "src", "RojoHub"), OURS, { recursive: true });
	console.log(`plugin/patches: ${[...written].join(", ") || "none"}`);
}

function git(cwd, args) {
	return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Copies the built part of Rojo's plugin/ at `tag` into `into`; returns the manifest. */
function fetchUpstream(tag, into) {
	const clone = mkdtempSync(join(tmpdir(), "rojo-hub-upstream-"));
	try {
		console.log(`Fetching ${ROJO_REPO} ${tag}…`);
		git(clone, ["clone", "--quiet", "--depth", "1", "--branch", tag, ROJO_REPO, "rojo"]);
		const repo = join(clone, "rojo");
		const commit = git(repo, ["rev-parse", "HEAD"]);
		const packages = {};
		const listed = git(repo, ["submodule", "status"]).split("\n");
		for (const line of listed) {
			const match = /^[-+ U]?([0-9a-f]+) plugin\/Packages\/([^ ]+)/.exec(line);
			if (!match || SKIPPED_PACKAGES.has(match[2])) continue;
			packages[match[2]] = match[1];
			git(repo, ["submodule", "update", "--init", "--quiet", "--depth", "1", `plugin/Packages/${match[2]}`]);
		}
		rmSync(into, { recursive: true, force: true });
		mkdirSync(into, { recursive: true });
		const copyText = (from, to) => {
			for (const file of statSync(from).isDirectory() ? walk(from).map((f) => [join(from, f), join(to, f)]) : [[from, to]]) {
				mkdirSync(dirname(file[1]), { recursive: true });
				writeFileSync(file[1], readText(file[0]));
			}
		};
		for (const entry of PLUGIN_ENTRIES) copyText(join(repo, "plugin", entry), join(into, entry));
		copyText(join(repo, "LICENSE.txt"), join(into, "LICENSE.txt"));
		for (const name of Object.keys(packages)) {
			const from = join(repo, "plugin", "Packages", name);
			const project = JSON.parse(readText(join(from, "default.project.json")));
			const root = String(project.tree.$path).split("/")[0];
			for (const entry of readdirSync(from)) {
				if (entry === "default.project.json" || entry === root || /^LICEN[CS]E/i.test(entry)) copyText(join(from, entry), join(into, "Packages", name, entry));
			}
		}
		return { tag, commit, packages, files: hashTree(into) };
	} finally {
		rmSync(clone, { recursive: true, force: true });
	}
}

function writeManifest(manifest) {
	writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function update(tag) {
	if (!tag) throw new Error("usage: node tools/plugin.mjs update <tag>, e.g. v7.7.1");
	const old = existsSync(MANIFEST) ? check() : null;
	const work = mkdtempSync(join(tmpdir(), "rojo-hub-update-"));
	try {
		const fresh = join(work, "upstream");
		const manifest = fetchUpstream(tag, fresh);
		const conflicts = [];
		const carried = [];
		for (const name of patchFiles()) {
			const patch = parsePatch(readFileSync(join(PATCHES, name), "utf8"));
			const base = readText(join(UPSTREAM, patch.path));
			const theirs = join(fresh, patch.path);
			if (!existsSync(theirs)) {
				conflicts.push(`${patch.path}: gone from ${tag}`);
				continue;
			}
			const files = { ours: join(work, "ours"), base: join(work, "base"), theirs: join(work, "theirs") };
			writeFileSync(files.ours, applyHunks(base, patch));
			writeFileSync(files.base, base);
			writeFileSync(files.theirs, readText(theirs));
			const merged = spawnSync("git", ["merge-file", "-p", "-L", "Rojo-Hub", "-L", old?.tag ?? "old", "-L", tag, files.ours, files.base, files.theirs], { encoding: "utf8" });
			if (merged.status !== 0) {
				const rejected = join(PATCHES, `${name}.merged`);
				writeFileSync(rejected, lf(merged.stdout));
				conflicts.push(`${patch.path}: conflicts; resolve ${relative(ROOT, rejected)} (the whole file), then run update again`);
				continue;
			}
			carried.push([name, diff(patch.path, readText(theirs), lf(merged.stdout))]);
		}
		if (conflicts.length > 0) throw new Error(`plugin/upstream left at ${old?.tag}:\n  ${conflicts.join("\n  ")}`);
		rmSync(UPSTREAM, { recursive: true, force: true });
		cpSync(fresh, UPSTREAM, { recursive: true });
		for (const [name, text] of carried) writePatch(name, text);
		writeManifest(manifest);
		console.log(`plugin/upstream is Rojo ${tag} (${manifest.commit.slice(0, 7)}); ${carried.length} patches carried over.`);
		console.log("Next: check protocolVersion in plugin/upstream/src/Config.lua, update tools/notices.mjs and run it, build, and try it in Studio.");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/* `init <tag>`: the first import, keeping the current files as patches (used once, by spec 010's move). */
function init(tag, from) {
	const manifest = fetchUpstream(tag, UPSTREAM);
	writeManifest(manifest);
	if (from) save(from);
	console.log(`plugin/upstream is Rojo ${tag} (${manifest.commit.slice(0, 7)}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, arg, extra] = process.argv.slice(2);
	try {
		if (command === "stage") console.log(stage(arg ? resolve(arg) : undefined));
		else if (command === "check") console.log(`plugin/upstream is Rojo ${check().tag}, and every patch applies.`);
		else if (command === "save") save(arg ? resolve(arg) : undefined);
		else if (command === "update") update(arg);
		else if (command === "init") init(arg, extra ? resolve(extra) : undefined);
		else throw new Error("usage: node tools/plugin.mjs stage [dir] | check | save [dir] | update <tag>");
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
