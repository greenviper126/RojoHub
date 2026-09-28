// Bundles the extension, the background service, the uninstall hook and the sidebar panel into dist/ with esbuild,
// and copies VS Code's codicon font next to the panel.
import { cpSync, mkdirSync } from "node:fs";
import { context } from "esbuild";

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

for (const options of builds) {
	const ctx = await context(options);
	if (watch) await ctx.watch();
	else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
