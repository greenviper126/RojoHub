import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { createServer } from "node:net";

import { decode } from "@msgpack/msgpack";

import { verbatim } from "./project";

/*
	Starting, stopping and observing one `rojo serve` per slot.
*/

export interface RojoInfo {
	sessionId: string;
	projectName: string;
	serverVersion: string;
}

/*
	Asks whatever answers on the port what it is serving. Rojo 7.7 answers
	/api/rojo in MessagePack; older Rojo (7.3, say) in JSON, so the content
	type decides. Null when nothing answers.
*/
export async function rojoInfo(port: number): Promise<RojoInfo | null> {
	try {
		const response = await fetch(`http://localhost:${port}/api/rojo`, { signal: AbortSignal.timeout(1500) });
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		const body = decodeInfo(bytes, response.headers.get("content-type"));
		if (typeof body.sessionId !== "string" || typeof body.projectName !== "string") return null;
		return { sessionId: body.sessionId, projectName: body.projectName, serverVersion: String(body.serverVersion ?? "") };
	} catch {
		return null;
	}
}

export function decodeInfo(bytes: Uint8Array, contentType: string | null): Partial<RojoInfo> {
	if (contentType?.includes("json")) return JSON.parse(new TextDecoder().decode(bytes)) as Partial<RojoInfo>;
	return decode(bytes) as Partial<RojoInfo>;
}

/** True when nothing is listening on the port on the loopback address Rojo binds. */
export function portFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer();
		server.once("error", () => done(false));
		server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
	});
}

/*
	Starts `rojo serve` for a slot file, detached so it outlives the service
	(Studio stays connected while the service restarts; the next service adopts
	it). `binary` is the pinned rojo from Rokit's tool storage (tools.ts), run
	directly and with no console, so no window opens.

	-v turns on Rojo's debug log, which is where it records each plugin websocket
	opening and closing; --color never keeps those lines plain in the file.
*/
export function startRojo(binary: string, slotFile: string, port: number, cwd: string, logFile: string): Promise<number> {
	return new Promise((done, fail) => {
		const log = openSync(logFile, "w");
		const child = spawn(binary, ["serve", verbatim(slotFile), "--port", String(port), "-v", "--color", "never"], {
			cwd,
			detached: true,
			windowsHide: true,
			stdio: ["ignore", log, log],
		});
		closeSync(log);
		child.once("error", (error) => fail(new Error(`${binary} could not be started: ${error.message}`)));
		child.once("spawn", () => {
			child.unref();
			done(child.pid ?? 0);
		});
	});
}

/*
	Stops every rojo.exe whose command line names this slot file, and only
	those. Rokit's shim and the real binary are both rojo.exe with the same
	command line, so the pair goes together (as in ServeWorktree.mjs); another
	project's serve is left alone because its slot file differs.
*/
export function stopRojo(slotFile: string): void {
	if (process.platform === "win32") {
		const needle = slotFile.replace(/'/g, "''");
		const script =
			`$needle = '${needle}'\n` +
			"Get-CimInstance Win32_Process -Filter \"Name='rojo.exe'\" | " +
			"Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
			"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
		spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
	} else {
		spawnSync("pkill", ["-f", slotFile], { stdio: "ignore" });
	}
}

/** True when a rojo.exe serving this slot file is alive. */
export function rojoAlive(slotFile: string): boolean {
	if (process.platform !== "win32") {
		return spawnSync("pgrep", ["-f", slotFile]).status === 0;
	}
	const needle = slotFile.replace(/'/g, "''");
	const script =
		`$needle = '${needle}'\n` +
		"@(Get-CimInstance Win32_Process -Filter \"Name='rojo.exe'\" | " +
		"Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count";
	const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
	return Number(out.stdout.trim()) > 0;
}

/*
	Rojo's own log lines for a plugin websocket (src/web/api.rs,
	handle_websocket_subscription). Every subscription that is established logs
	OPENED once, and every way out of its loop logs one of CLOSED.
*/
const OPENED = "WebSocket subscription established";
const CLOSED = [
	"WebSocket subscription closed by client",
	"WebSocket stream ended",
	"WebSocket error:",
	"Message queue disconnected; closing WebSocket subscription",
];

export function countConnections(lines: string[], start = 0): number {
	let open = start;
	for (const line of lines) {
		if (line.includes(OPENED)) open++;
		else if (CLOSED.some((marker) => line.includes(marker))) open = Math.max(0, open - 1);
	}
	return open;
}

/*
	Follows a rojo log file: the number of plugins connected, and the error and
	warning lines since the last time they were taken.
*/
export class LogFollower {
	private offset = 0;
	private partial = "";
	private recent: string[] = [];
	connections = 0;

	constructor(readonly file: string) {}

	poll(): void {
		if (!existsSync(this.file)) return;
		const size = statSync(this.file).size;
		if (size < this.offset) {
			this.offset = 0;
			this.partial = "";
			this.connections = 0;
		}
		if (size === this.offset) return;
		const buffer = Buffer.alloc(size - this.offset);
		const fd = openSync(this.file, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, this.offset);
		} finally {
			closeSync(fd);
		}
		this.offset = size;
		const text = this.partial + buffer.toString("utf8");
		const lines = text.split(/\r?\n/);
		this.partial = lines.pop() ?? "";
		this.connections = countConnections(lines, this.connections);
		for (const line of lines) {
			if (/^\[(ERROR|WARN)/.test(line) || /^\s+Caused by:/.test(line)) this.recent.push(line.trim());
		}
		if (this.recent.length > 50) this.recent = this.recent.slice(-50);
	}

	takeProblems(): string[] {
		const problems = this.recent;
		this.recent = [];
		return problems;
	}

	tail(count: number): string {
		if (!existsSync(this.file)) return "";
		const fd = openSync(this.file, "r");
		try {
			const size = statSync(this.file).size;
			const length = Math.min(size, 16384);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			return buffer.toString("utf8").trim().split(/\r?\n/).slice(-count).join("\n");
		} finally {
			closeSync(fd);
		}
	}
}

/*
	`rojo build` of a slot file into a place file, with the same pinned binary
	and verbatim path as serving. Failures carry Rojo's own message.
*/
export function buildPlace(binary: string, slotFile: string, output: string, cwd: string): Promise<void> {
	return new Promise((done, fail) => {
		execFile(binary, ["build", verbatim(slotFile), "--output", output, "--color", "never"], { cwd, windowsHide: true, timeout: 300000, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
			if (error) fail(new Error(`rojo build failed: ${(stderr || stdout || error.message).trim().split(/\r?\n/).slice(-6).join("\n")}`));
			else done();
		});
	});
}
