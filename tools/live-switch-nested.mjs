// Nested variant: the slot file's root $path points at each tree's own project file.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@msgpack/msgpack";

const ROOT = join(tmpdir(), "rojo-hub-nested");
const PORT = 34992;
const HUB = join(ROOT, "hub");
const SLOT = join(HUB, "slot.project.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(HUB, { recursive: true });
writeFileSync(join(ROOT, "rokit.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n');

function treeProject(wt, extra = {}) {
	return {
		name: "Tree " + wt,
		globIgnorePaths: ["**/test.project.json", "**/*.ignored.luau"],
		tree: {
			$className: "DataModel",
			ServerScriptService: { $className: "ServerScriptService", $path: "src/Server" },
			ReplicatedStorage: { $className: "ReplicatedStorage", Shared: { $path: "src/Shared" }, ...extra },
		},
	};
}
for (const wt of ["wtA", "wtB"]) {
	mkdirSync(join(ROOT, wt, "src", "Server"), { recursive: true });
	mkdirSync(join(ROOT, wt, "src", "Shared"), { recursive: true });
	writeFileSync(join(ROOT, wt, "src", "Server", "Foo.server.luau"), `print("${wt} v1")\n`);
	writeFileSync(join(ROOT, wt, "src", "Shared", "Skip.ignored.luau"), `return "should be ignored"\n`);
	writeFileSync(join(ROOT, wt, "default.project.json"), JSON.stringify(treeProject(wt), null, 2));
}
writeFileSync(join(ROOT, "wtB", "src", "Server", "OnlyB.server.luau"), `print("only in B")\n`);

const MODE = process.argv[2] ?? "plain";
const nestedPath = (wt) => (MODE === "verbatim-inner" ? "\\\\?\\" : "") + join(ROOT, wt, "default.project.json");
const writeSlot = (wt) =>
	writeFileSync(SLOT, JSON.stringify({ name: "Nested", servePlaceIds: [1, 2], tree: { $path: nestedPath(wt) } }, null, 2));

async function info() {
	const r = await fetch(`http://localhost:${PORT}/api/rojo`);
	return decode(new Uint8Array(await r.arrayBuffer()));
}
function names(read) {
	return Object.values(read.instances).map((i) => i.Name).sort().join(",");
}

writeSlot("wtA");
const rojo = spawn("rojo.exe", ["serve", "\\\\?\\" + SLOT, "--port", String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
rojo.stdout.on("data", (d) => (log += d));
rojo.stderr.on("data", (d) => (log += d));
let first;
for (let i = 0; i < 60 && !first; i++) { try { first = await info(); } catch { await sleep(250); } }
if (!first) { console.log(log); process.exit(1); }
const read = decode(new Uint8Array(await (await fetch(`http://localhost:${PORT}/api/read/${first.rootInstanceId}`)).arrayBuffer()));
console.log("mode", MODE, "name", first.projectName, "placeIds", first.expectedPlaceIds, "\ninitial:", names(read));

const packets = [];
const ws = new WebSocket(`ws://localhost:${PORT}/api/socket/${read.messageCursor}`);
ws.binaryType = "arraybuffer";
let closed = false;
ws.onmessage = (e) => packets.push(decode(new Uint8Array(e.data)));
ws.onclose = () => (closed = true);
await new Promise((r) => (ws.onopen = r));

async function step(label, action) {
	const before = packets.length;
	action();
	await sleep(1500);
	const now = await info();
	const got = packets.slice(before).flatMap((p) => p.body.messages);
	const added = got.flatMap((m) => Object.values(m.added).map((i) => i.Name));
	const upd = got.flatMap((m) => m.updated.filter((u) => u.changedProperties?.Source).map((u) => u.changedProperties.Source.String.trim()));
	const removed = got.reduce((n, m) => n + m.removed.length, 0);
	console.log(`${label}: packets=${packets.length - before} added=[${added}] removed=${removed} sources=[${upd}] sameSession=${now.sessionId === first.sessionId} open=${!closed}`);
}
await step("switch A->B", () => writeSlot("wtB"));
await step("edit in B", () => writeFileSync(join(ROOT, "wtB", "src", "Server", "Foo.server.luau"), `print("wtB v2")\n`));
await step("new ignored file in B", () => writeFileSync(join(ROOT, "wtB", "src", "Shared", "Other.ignored.luau"), `return 1\n`));
await step("B's project file adds a mapping", () =>
	writeFileSync(join(ROOT, "wtB", "default.project.json"), JSON.stringify(treeProject("wtB", { Extra: { $path: "src/Server" } }), null, 2)));
await step("edit in A while serving B", () => writeFileSync(join(ROOT, "wtA", "src", "Server", "Foo.server.luau"), `print("wtA v2")\n`));
await step("switch B->A", () => writeSlot("wtA"));
await step("edit in A", () => writeFileSync(join(ROOT, "wtA", "src", "Server", "Foo.server.luau"), `print("wtA v3")\n`));
const errors = log.split(/\r?\n/).filter((l) => /ERROR|WARN/.test(l));
console.log("rojo errors:", errors.length ? errors.slice(0, 8).join("\n") : "none");
ws.close();
spawn("taskkill", ["/pid", String(rojo.pid), "/T", "/F"], { stdio: "ignore" });
await sleep(300);
process.exit(0);
