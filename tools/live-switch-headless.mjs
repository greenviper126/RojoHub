#!/usr/bin/env node
/*
	Headless half of spec 001's live-switch measurement: plays the Studio
	plugin's part (GET /api/rojo, /api/read, the /api/socket websocket) and
	records what Rojo sends while the project file's $paths are rewritten.

	Usage:  node tools/live-switch-headless.mjs verbatim [version]   serve by \\?\ path (switches apply)
	        node tools/live-switch-headless.mjs plain [version]      serve by C:\ path (switches are dropped on Windows by 7.7.0)

	version is the rojo to pin through Rokit (default 7.7.0). The last step
	deletes a folder rojo served earlier (rojo-rbx/rojo#1305).
*/
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@msgpack/msgpack";

const ROOT = join(tmpdir(), "rojo-hub-headless");
const PORT = 34990;
const HUB = join(ROOT, "hub");
const PROJECT = join(HUB, "slot.project.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(ROOT, { recursive: true, force: true });
rmSync(join(ROOT, "wtA"), { recursive: true, force: true });
rmSync(join(ROOT, "wtB"), { recursive: true, force: true });
for (const wt of ["wtA", "wtB"]) {
	mkdirSync(join(ROOT, wt, "src", "Server"), { recursive: true });
	mkdirSync(join(ROOT, wt, "src", "Shared"), { recursive: true });
	writeFileSync(join(ROOT, wt, "src", "Server", "Foo.server.luau"), `print("${wt} v1")\n`);
	writeFileSync(join(ROOT, wt, "src", "Shared", "Mod.luau"), `return "${wt}"\n`);
}
writeFileSync(join(ROOT, "wtB", "src", "Server", "OnlyB.server.luau"), `print("only in B")\n`);
mkdirSync(HUB, { recursive: true });

function writeProject(wt) {
	const project = {
		name: "ProbeProject",
		tree: {
			$className: "DataModel",
			ServerScriptService: { $className: "ServerScriptService", $path: join(ROOT, wt, "src", "Server") },
			ReplicatedStorage: { $className: "ReplicatedStorage", Shared: { $path: join(ROOT, wt, "src", "Shared") } },
		},
	};
	writeFileSync(PROJECT, JSON.stringify(project, null, 2) + "\n");
}

async function info() {
	const r = await fetch(`http://localhost:${PORT}/api/rojo`);
	return decode(new Uint8Array(await r.arrayBuffer()));
}

function summarize(message) {
	const out = [];
	for (const id of message.removed ?? []) out.push(`  removed ${id}`);
	for (const [id, inst] of Object.entries(message.added ?? {}))
		out.push(`  added ${inst.ClassName ?? inst.className} "${inst.Name ?? inst.name}" ${JSON.stringify(inst.Properties?.Source ?? inst.properties?.Source ?? "")}`);
	for (const u of message.updated ?? [])
		out.push(`  updated ${u.id} name=${u.changedName ?? ""} props=${JSON.stringify(u.changedProperties)}`);
	return out.join("\n");
}

writeProject("wtA");
const MODE = process.argv[2] ?? "verbatim";
const servePath = MODE === "verbatim" ? "\\\\?\\" + PROJECT : PROJECT;
console.log("serving", servePath);
const VERSION = process.argv[3] ?? "7.7.0";
console.log("rojo", VERSION);
writeFileSync(join(ROOT, "rokit.toml"), `[tools]\nrojo = "rojo-rbx/rojo@${VERSION}"\n`);
const rojo = spawn("rojo.exe", ["serve", servePath, "--port", String(PORT)], { cwd: HUB, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
rojo.stdout.on("data", (d) => (log += d));
rojo.stderr.on("data", (d) => (log += d));

let first;
for (let i = 0; i < 60; i++) {
	try { first = await info(); break; } catch { await sleep(250); }
}
if (!first) { console.log("rojo never came up\n" + log); process.exit(1); }
console.log("session", first.sessionId, "name", first.projectName);

const read = decode(new Uint8Array(await (await fetch(`http://localhost:${PORT}/api/read/${first.rootInstanceId}`)).arrayBuffer()));
console.log("initial cursor", read.messageCursor, "instances", Object.keys(read.instances).length);

const events = [];
let closed = false;
const ws = new WebSocket(`ws://localhost:${PORT}/api/socket/${read.messageCursor}`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
	const packet = decode(new Uint8Array(e.data));
	events.push(packet);
	console.log(`<< packet session=${packet.sessionId} cursor=${packet.body?.messageCursor}`);
	for (const m of packet.body?.messages ?? []) console.log(summarize(m));
};
ws.onclose = () => { closed = true; console.log("<< SOCKET CLOSED"); };
await new Promise((r) => (ws.onopen = r));

async function step(label, action) {
	console.log(`\n== ${label}`);
	const before = events.length;
	action();
	await sleep(1500);
	const now = await info().catch(() => null);
	console.log(`   packets=${events.length - before} sameSession=${now?.sessionId === first.sessionId} socketOpen=${!closed}${now ? "" : " ROJO GONE"}`);
}

await step("switch A -> B (rewrite project file)", () => writeProject("wtB"));
await step("edit file in B after switch", () => writeFileSync(join(ROOT, "wtB", "src", "Server", "Foo.server.luau"), `print("wtB v2")\n`));
await step("add file in B after switch", () => writeFileSync(join(ROOT, "wtB", "src", "Shared", "New.luau"), `return "new in B"\n`));
await step("edit file in A while serving B (expect nothing)", () => writeFileSync(join(ROOT, "wtA", "src", "Server", "Foo.server.luau"), `print("wtA v2")\n`));
await step("switch B -> A", () => writeProject("wtA"));
await step("edit file in A after switching back", () => writeFileSync(join(ROOT, "wtA", "src", "Server", "Foo.server.luau"), `print("wtA v3")\n`));
await step("edit file in B while serving A (expect nothing)", () => writeFileSync(join(ROOT, "wtB", "src", "Server", "Foo.server.luau"), `print("wtB v3")\n`));
await step("switch A -> B again", () => writeProject("wtB"));
await step("edit file in B after second switch", () => writeFileSync(join(ROOT, "wtB", "src", "Server", "Foo.server.luau"), `print("wtB v4")\n`));
await step("delete a subfolder of A, served earlier (rojo-rbx/rojo#1305)", () => rmSync(join(ROOT, "wtA", "src", "Shared"), { recursive: true, force: true }));
console.log(`   rojo alive=${rojo.exitCode === null}`);

ws.close();
spawn("taskkill", ["/pid", String(rojo.pid), "/T", "/F"], { stdio: "ignore" });
console.log("\n-- rojo log --\n" + log);
await sleep(500);
process.exit(0);
