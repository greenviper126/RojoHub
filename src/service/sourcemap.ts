import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { SlotView } from "../common/api";
import { git } from "./git";

const RESTART_MS = 1000;
const MAX_CRASHES_PER_MINUTE = 5;

/*
	The arguments luau-lsp's VS Code extension uses (sourcemap <project>
	--include-non-scripts, run in the folder), so both write the same file;
	measured identical byte for byte (spec 003). The output is given as an
	absolute path, which does not change the file but tells this watcher's
	command line apart from luau-lsp's, whose output is relative.
*/
function args(tree: string, projectFile: string, watch: boolean): string[] {
	return ["sourcemap", projectFile, "--output", join(tree, "sourcemap.json"), "--include-non-scripts", "--color", "never", ...(watch ? ["--watch"] : [])];
}

/** Whether the service may create sourcemap.json in `tree` without it showing up in git. */
export async function mayWrite(tree: string): Promise<boolean> {
	if (existsSync(join(tree, "sourcemap.json"))) return true;
	return git(tree, ["check-ignore", "-q", "sourcemap.json"]).then(
		() => true,
		() => false,
	);
}

/** Writes `tree`'s sourcemap.json once. */
export function writeSourcemap(binary: string, tree: string, projectFile: string): Promise<void> {
	return new Promise((done, fail) => {
		execFile(binary, args(tree, projectFile, false), { cwd: tree, windowsHide: true, timeout: 120000 }, (error, _stdout, stderr) => {
			if (error) fail(new Error(`rojo sourcemap failed: ${(stderr || error.message).trim().split(/\r?\n/).slice(-4).join("\n")}`));
			else done();
		});
	});
}

/*
	Stops rojo sourcemap watchers writing into `tree` that this service did not
	start: left by a service that died. Matched by the absolute output path in
	their command line, so luau-lsp's watchers are never touched.
*/
export function stopStrayWatchers(tree: string): void {
	if (process.platform !== "win32") return;
	const needle = join(tree, "sourcemap.json").replace(/'/g, "''");
	const script =
		`$needle = '${needle}'\n` +
		"Get-CimInstance Win32_Process -Filter \"Name='rojo.exe'\" | " +
		"Where-Object { $_.CommandLine -and $_.CommandLine.Contains(' sourcemap ') -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
		"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
	spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 });
}

/*
	Keeps one worktree's sourcemap.json current with `rojo sourcemap --watch`.
	Rojo 7.7's watcher panics when a watched folder is deleted (rojo-rbx/rojo#1305),
	as serve does; a sourcemap is no Studio session, so it is started again after
	a second, and given up on after five crashes in a minute.
*/
export class SourcemapWatcher {
	private child: ChildProcess | null = null;
	private stopped = false;
	private crashes: number[] = [];
	private timer: NodeJS.Timeout | null = null;
	status: SlotView["sourcemap"];

	constructor(
		private readonly binary: string,
		readonly tree: string,
		private readonly projectFile: string,
	) {
		this.status = { state: "watching", detail: `Kept up to date in ${basename(tree)}` };
		this.launch();
	}

	private launch(): void {
		if (this.stopped) return;
		let stderr = "";
		const child = spawn(this.binary, args(this.tree, this.projectFile, true), { cwd: this.tree, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		this.child = child;
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
		child.once("error", (error) => {
			this.status = { state: "error", detail: `rojo sourcemap could not start: ${error.message}` };
		});
		child.once("exit", () => {
			if (this.stopped || this.child !== child) return;
			const now = Date.now();
			this.crashes = [...this.crashes.filter((at) => now - at < 60000), now];
			const reason = stderr.split(/\r?\n/).find((line) => line.includes("Details:"))?.replace(/^\[ERROR rojo\]\s*/, "") ?? stderr.trim().split(/\r?\n/).pop() ?? "";
			if (this.crashes.length >= MAX_CRASHES_PER_MINUTE) {
				this.status = { state: "error", detail: `rojo sourcemap keeps stopping, so it was left off: ${reason}`.trim() };
				return;
			}
			this.status = { state: "watching", detail: `Kept up to date in ${basename(this.tree)} (restarted after: ${reason || "it stopped"})` };
			this.timer = setTimeout(() => this.launch(), RESTART_MS);
		});
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.child?.kill();
		this.child = null;
	}
}
