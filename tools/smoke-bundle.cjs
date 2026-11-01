// Loads the built bundles the way VS Code and the service runner do, with a stub
// "vscode" module, so a bundling mistake (a require esbuild could not follow)
// fails here instead of when the extension activates. Run after `npm run build`.
const Module = require("node:module");
const path = require("node:path");

const stub = new Proxy(function () {}, {
	get: (target, key) => (key === "__esModule" ? false : stub),
	apply: () => stub,
	construct: () => stub,
});
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: stub };

const dist = path.join(__dirname, "..", "dist");
const extension = require(path.join(dist, "extension.js"));
if (typeof extension.activate !== "function") throw new Error("dist/extension.js has no activate()");
console.log("dist/extension.js loads and exports activate()");

const { execFileSync, spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

// The uninstall hook, with a throwaway home so it cannot touch the real Claude Code or Codex config,
// and pointed at port 34869 (nothing listens there) with a throwaway Rojo-Hub home, so its
// shutdown of the service can never reach the real one on 34870.
const fakeHome = mkdtempSync(path.join(tmpdir(), "rojo-hub-smoke-home-"));
const fakePlugins = path.join(fakeHome, "Roblox", "Plugins");
require("node:fs").mkdirSync(fakePlugins, { recursive: true });
require("node:fs").writeFileSync(path.join(fakePlugins, "RojoHub.rbxm"), "installed plugin");
execFileSync(process.execPath, [path.join(dist, "uninstall.js")], {
	env: {
		...process.env,
		USERPROFILE: fakeHome,
		HOME: fakeHome,
		CODEX_HOME: fakeHome,
		CLAUDE_CONFIG_DIR: fakeHome,
		LOCALAPPDATA: fakeHome,
		ROJO_HUB_HOME: path.join(fakeHome, "RojoHub"),
		ROJO_HUB_PORT: "34869",
	},
	stdio: "inherit",
});
if (require("node:fs").existsSync(path.join(fakePlugins, "RojoHub.rbxm"))) {
	console.error("dist/uninstall.js left the Studio plugin in place");
	process.exit(1);
}
console.log("dist/uninstall.js runs and removes the Studio plugin");

// The service bundle: start it on a spare port with a throwaway home and plugins folder, ask /health,
// check it installed the Studio plugin built beside it, shut it down.
const port = 34868;
const home = mkdtempSync(path.join(tmpdir(), "rojo-hub-smoke-"));
const plugins = path.join(home, "Plugins");
const child = spawn(process.execPath, [path.join(dist, "service.js")], {
	env: { ...process.env, ROJO_HUB_HOME: home, ROJO_HUB_PORT: String(port), ROJO_HUB_STUDIO_PLUGINS: plugins, ROJO_HUB_VSCODE_USER: path.join(home, "vscode-user"), ROJO_HUB_VSCODE_EXTENSIONS: path.join(home, "vscode-extensions") },
	stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
(async () => {
	for (let i = 0; i < 50; i++) {
		try {
			const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
			console.log(`dist/service.js starts and answers /health (v${health.version})`);
			for (let j = 0; j < 50 && !require("node:fs").existsSync(path.join(plugins, "RojoHub.rbxm")); j++) await new Promise((done) => setTimeout(done, 100));
			if (!require("node:fs").existsSync(path.join(plugins, "RojoHub.rbxm"))) {
				console.error("dist/service.js did not install dist/RojoHub.rbxm into the plugins folder");
				await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", body: "{}" });
				process.exit(1);
			}
			console.log("dist/service.js installs the Studio plugin");
			await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", body: "{}" });
			return;
		} catch {
			if (child.exitCode !== null) break;
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	child.kill();
	console.error(`dist/service.js did not start:\n${stderr}`);
	process.exit(1);
})();

// The stdio launcher (spec 011): with no service up, run dist/mcp-stdio.js with ROJO_HUB_SERVICE pointing at the
// built service, a throwaway home and a spare port; check initialize, tools/list and tools/call status are answered
// and the service came up, kill the service and call again, then run the uninstall hook against the same throwaway
// home and check the launcher folder is gone. Nothing here touches a real agent config.
(async () => {
	const fs = require("node:fs");
	const launcherPort = 34867;
	const launcherHome = mkdtempSync(path.join(tmpdir(), "rojo-hub-smoke-launcher-"));
	const env = {
		...process.env,
		USERPROFILE: launcherHome,
		HOME: launcherHome,
		CODEX_HOME: launcherHome,
		CLAUDE_CONFIG_DIR: launcherHome,
		ROJO_HUB_HOME: launcherHome,
		ROJO_HUB_PORT: String(launcherPort),
		ROJO_HUB_SERVICE: path.join(dist, "service.js"),
		ROJO_HUB_STUDIO_PLUGINS: path.join(launcherHome, "Plugins"),
	};
	const fail = (message) => {
		console.error(message);
		process.exit(1);
	};
	const stdio = spawn(process.execPath, [path.join(dist, "mcp-stdio.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map();
	let text = "";
	stdio.stdout.on("data", (chunk) => {
		text += chunk;
		for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
			const message = JSON.parse(text.slice(0, end));
			text = text.slice(end + 1);
			waiting.get(message.id)?.(message);
		}
	});
	const ask = (id, method, params) =>
		new Promise((done) => {
			const timer = setTimeout(() => fail(`dist/mcp-stdio.js did not answer ${method}`), 40000);
			waiting.set(id, (message) => (clearTimeout(timer), done(message)));
			stdio.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	const health = async () => {
		try {
			return await (await fetch(`http://127.0.0.1:${launcherPort}/health`, { signal: AbortSignal.timeout(1500) })).json();
		} catch {
			return null;
		}
	};
	const gone = async () => {
		for (let i = 0; i < 50 && (await health()); i++) await new Promise((done) => setTimeout(done, 100));
		return !(await health());
	};
	if (await health()) fail(`something already answers on ${launcherPort}`);

	const init = await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
	if (init.result?.serverInfo?.name !== "rojo-hub") fail(`launcher initialize: ${JSON.stringify(init)}`);
	stdio.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	const tools = await ask(2, "tools/list", {});
	if (!tools.result?.tools?.some((tool) => tool.name === "status")) fail(`launcher tools/list: ${JSON.stringify(tools).slice(0, 300)}`);
	const status = await ask(3, "tools/call", { name: "status", arguments: {} });
	if (!status.result?.content?.[0]?.text || status.result.isError) fail(`launcher tools/call status: ${JSON.stringify(status).slice(0, 300)}`);
	if (!(await health())) fail("the launcher answered but no service is up");
	console.log("dist/mcp-stdio.js starts the service and answers initialize, tools/list and tools/call");

	const copy = path.join(launcherHome, "launcher", "rojohub-mcp.cjs");
	for (let i = 0; i < 50 && !fs.existsSync(copy); i++) await new Promise((done) => setTimeout(done, 100));
	if (!fs.existsSync(copy) || !fs.readFileSync(copy, "utf8").startsWith("// rojo-hub-launcher ")) fail("dist/service.js did not install the launcher");
	console.log("dist/service.js installs the launcher");

	await fetch(`http://127.0.0.1:${launcherPort}/shutdown`, { method: "POST", body: "{}" });
	if (!(await gone())) fail("the service did not shut down");
	const again = await ask(4, "tools/call", { name: "status", arguments: {} });
	if (!again.result?.content?.[0]?.text || again.result.isError) fail(`launcher after a restart: ${JSON.stringify(again).slice(0, 300)}`);
	console.log("dist/mcp-stdio.js restarts a service that went away");

	stdio.stdin.end();
	await new Promise((done) => stdio.on("exit", done));
	await fetch(`http://127.0.0.1:${launcherPort}/shutdown`, { method: "POST", body: "{}" });
	if (!(await gone())) fail("the service did not shut down");
	// The uninstall hook, on a port nothing listens on, against the same throwaway home: the launcher folder goes.
	execFileSync(process.execPath, [path.join(dist, "uninstall.js")], { env: { ...env, ROJO_HUB_PORT: "34866" }, stdio: "inherit" });
	if (fs.existsSync(path.join(launcherHome, "launcher"))) fail("dist/uninstall.js left the launcher folder");
	console.log("dist/uninstall.js removes the launcher folder");
})();
