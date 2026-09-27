// Bundles the extension and the background service into dist/ with esbuild.
import { context } from "esbuild";

const watch = process.argv.includes("--watch");
const shared = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, logLevel: "info" };
const builds = [
	{ ...shared, entryPoints: ["src/extension/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
	{ ...shared, entryPoints: ["src/service/main.ts"], outfile: "dist/service.js" },
];
for (const options of builds) {
	const ctx = await context(options);
	if (watch) await ctx.watch();
	else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
