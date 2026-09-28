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

// The uninstall hook, with a throwaway home so it cannot touch the real Claude Code or Codex config.
const fakeHome = mkdtempSync(path.join(tmpdir(), "rojo-hub-smoke-home-"));
execFileSync(process.execPath, [path.join(dist, "uninstall.js")], { env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, CODEX_HOME: fakeHome }, stdio: "inherit" });
console.log("dist/uninstall.js runs");

// The service bundle: start it on a spare port with a throwaway home, ask /health, shut it down.
const port = 34868;
const home = mkdtempSync(path.join(tmpdir(), "rojo-hub-smoke-"));
const child = spawn(process.execPath, [path.join(dist, "service.js")], {
	env: { ...process.env, ROJO_HUB_HOME: home, ROJO_HUB_PORT: String(port) },
	stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
(async () => {
	for (let i = 0; i < 50; i++) {
		try {
			const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
			console.log(`dist/service.js starts and answers /health (v${health.version})`);
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
