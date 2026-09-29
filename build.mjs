// Bundles the extension, the background service, the uninstall hook and the sidebar panel into dist/ with esbuild,
// copies VS Code's codicon font next to the panel, and builds the Studio plugin (plugin/, spec 007) into
// dist/RojoHub.rbxm with Rojo 7.7.0 from Rokit's tool storage, or `rojo` on PATH.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { context } from "esbuild";

const PLUGIN_ROJO = "7.7.0";

const watch = process.argv.includes("--watch");
// mainFields prefers ES module builds: some packages (jsonc-parser) ship a UMD "main" whose
// dynamic require()s esbuild cannot follow, which breaks the bundle at load time.
const shared = { bundle: true, sourcemap: true, logLevel: "info", mainFields: ["module", "main"] };
const builds = [
	{ ...shared, platform: "node", target: "node20", format: "cjs", entryPoints: ["src/extension/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
	{ ...shared, platform: "node", target: "node20", format: "cjs", entryPoints: ["src/service/main.ts"], outfile: "dist/service.js" },
	{ ...shared, platform: "node", target: "node20", format: "cjs", entryPoints: ["src/extension/uninstall.ts"], outfile: "dist/uninstall.js" },
	{ ...shared, platform: "browser", target: "es2022", format: "iife", entryPoints: ["src/webview/main.ts"], outfile: "dist/webview.js" },
];

mkdirSync("dist/codicons", { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) cpSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);

function buildPlugin() {
	const exe = process.platform === "win32" ? "rojo.exe" : "rojo";
	const stored = join(process.env.ROKIT_ROOT ?? join(homedir(), ".rokit"), "tool-storage", "rojo-rbx", "rojo", PLUGIN_ROJO, exe);
	const rojo = existsSync(stored) ? stored : "rojo";
	const version = execFileSync(rojo, ["--version"], { encoding: "utf8" }).trim();
	if (!version.endsWith(PLUGIN_ROJO)) throw new Error(`The Studio plugin is built with Rojo ${PLUGIN_ROJO}; found "${version}". Install it with Rokit (rokit add rojo-rbx/rojo@${PLUGIN_ROJO}).`);
	execFileSync(rojo, ["build", "plugin/default.project.json", "--output", "dist/RojoHub.rbxm"], { stdio: "inherit", windowsHide: true });
}

buildPlugin();

for (const options of builds) {
	const ctx = await context(options);
	if (watch) await ctx.watch();
	else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
