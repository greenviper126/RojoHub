import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import { parse } from "smol-toml";

import { pathKey } from "../common/paths";
import { writeAudit } from "./audit";
import type { ResolvedRojo } from "./tools";

/*
	Setup commands for new worktrees (spec 012, design 1) and the install checks
	`ensure` reports (design 2).

	The commands are argv, never a shell line: the user wrote every one in their
	own application-scoped setting, and nothing an agent sends reaches a command,
	its arguments or its folder. The branch name is passed as an environment
	variable only.
*/

export const MAX_COMMANDS = 10;
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 3600;
/** The whole list of one worktree's setup. */
export const TOTAL_LIMIT_MS = 30 * 60 * 1000;
export const TAIL_LINES = 40;
export const TAIL_BYTES = 4096;
/** What an audit line keeps of a command's output. */
export const AUDIT_TAIL_BYTES = 2048;
/** Characters that cmd.exe would act on in the arguments of a .cmd or .bat file. */
const CMD_METACHARACTERS = /[&|<>^%!"`\r\n]/;

export interface SetupCommand {
	command: string;
	args: string[];
	/** Relative to the worktree, no "..", no absolute path. */
	cwd?: string;
	timeoutSeconds: number;
}

/** A repo path as the setting's key: case, slash style, trailing slash and a \\?\ prefix do not matter. */
export function normaliseRepoKey(path: string): string {
	return pathKey(path.replace(/^\\\\\?\\/, ""));
}

function isCmdFile(path: string): boolean {
	return /\.(cmd|bat)$/i.test(path);
}

/*
	Finds an executable the way a shell would: a path as given, else the PATH
	folders in order, each with PATHEXT's extensions on Windows. Null when
	nothing is there.
*/
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
	const windows = process.platform === "win32";
	const extensions = windows ? (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	const isFile = (path: string) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	const withExtension = (base: string): string | null => {
		const hasExt = windows && extname(base) !== "" && extensions.some((ext) => ext.toLowerCase() === extname(base).toLowerCase());
		if (hasExt && isFile(base)) return base;
		for (const ext of windows ? extensions : [""]) if (isFile(base + ext)) return base + ext;
		return null;
	};
	if (isAbsolute(command) || /[\\/]/.test(command)) return withExtension(resolve(cwd, command));
	const path = env.PATH ?? env.Path ?? "";
	for (const dir of path.split(delimiter).filter(Boolean)) {
		const found = withExtension(join(dir, command));
		if (found) return found;
	}
	return null;
}

export interface ParsedSetup {
	/** Normalised repo key -> its commands. */
	entries: Map<string, SetupCommand[]>;
	/** Problems by entry; an entry with one is left out, and its repo runs nothing. */
	problems: Map<string, string[]>;
}

/*
	Reads rojoHub.setupCommands. `resolver` finds a command's file (null: not
	found); the .cmd/.bat rule needs it to know that `npm` is npm.cmd.
*/
export function parseSetupCommands(value: unknown, resolver: (command: string) => string | null = (command) => resolveCommand(command)): ParsedSetup {
	const result: ParsedSetup = { entries: new Map(), problems: new Map() };
	if (value === undefined || value === null) return result;
	if (typeof value !== "object" || Array.isArray(value)) {
		result.problems.set("(setting)", ["rojoHub.setupCommands must be an object: repo path -> list of commands."]);
		return result;
	}
	for (const [rawKey, rawList] of Object.entries(value as Record<string, unknown>)) {
		const key = normaliseRepoKey(rawKey);
		const problems: string[] = [];
		const commands: SetupCommand[] = [];
		if (!Array.isArray(rawList)) problems.push(`${rawKey}: the value must be a list of commands.`);
		else {
			if (rawList.length > MAX_COMMANDS) problems.push(`${rawKey}: at most ${MAX_COMMANDS} commands (found ${rawList.length}).`);
			rawList.slice(0, MAX_COMMANDS).forEach((raw, index) => {
				const where = `${rawKey}, command ${index + 1}`;
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void problems.push(`${where}: must be an object { command, args?, cwd?, timeoutSeconds? }.`);
				const entry = raw as Record<string, unknown>;
				if (typeof entry.command !== "string" || entry.command.trim() === "") return void problems.push(`${where}: command must be a non-empty string.`);
				if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) return void problems.push(`${where}: args must be a list of strings.`);
				const args = (entry.args as string[] | undefined) ?? [];
				if (entry.cwd !== undefined) {
					if (typeof entry.cwd !== "string") return void problems.push(`${where}: cwd must be a string.`);
					if (isAbsolute(entry.cwd) || /^[a-z]:/i.test(entry.cwd) || entry.cwd.startsWith("\\") || entry.cwd.startsWith("/")) return void problems.push(`${where}: cwd must be relative to the worktree, not absolute.`);
					if (entry.cwd.split(/[\\/]+/).includes("..")) return void problems.push(`${where}: cwd must not contain "..".`);
				}
				let timeoutSeconds = DEFAULT_TIMEOUT_S;
				if (entry.timeoutSeconds !== undefined) {
					const seconds = entry.timeoutSeconds;
					if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S) return void problems.push(`${where}: timeoutSeconds must be 1 to ${MAX_TIMEOUT_S}.`);
					timeoutSeconds = seconds;
				}
				// Whatever the command resolves to, a .cmd or .bat runs through cmd.exe, which acts on these characters.
				const file = isCmdFile(entry.command) ? entry.command : process.platform === "win32" ? resolver(entry.command) : null;
				if (file && isCmdFile(file)) {
					const bad = args.find((arg) => CMD_METACHARACTERS.test(arg));
					if (bad !== undefined) return void problems.push(`${where}: ${entry.command} is run through cmd.exe, so an argument may not contain & | < > ^ % ! " \` or a line break (found in ${JSON.stringify(bad)}).`);
				}
				commands.push({ command: entry.command, args, ...(entry.cwd !== undefined ? { cwd: entry.cwd as string } : {}), timeoutSeconds });
			});
		}
		if (problems.length > 0) result.problems.set(key, problems);
		else result.entries.set(key, commands);
	}
	return result;
}

/** `wally install` — how an answer names a command. */
export function commandText(command: SetupCommand | { command: string; args: string[] }): string {
	return [command.command, ...command.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/** The last TAIL_LINES lines of `text`, at most TAIL_BYTES of them. */
export function tailOf(text: string, bytes = TAIL_BYTES): string {
	let tail = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").slice(-TAIL_LINES).join("\n");
	if (Buffer.byteLength(tail) > bytes) {
		const buffer = Buffer.from(tail);
		tail = "…" + buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^\uFFFD+/, "");
	}
	return tail;
}

/** Kills a process and everything it started. */
export function killTree(pid: number): Promise<void> {
	return new Promise((done) => {
		if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => done());
		else {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			done();
		}
	});
}

/** Rokit's `bin` folder (its shims), so `wally` and other Rokit tools resolve however VS Code was started. */
export function rokitBin(rokitHome = process.env.ROKIT_ROOT ?? join(homedir(), ".rokit")): string {
	return join(rokitHome, "bin");
}

export interface StepResult {
	index: number;
	of: number;
	text: string;
	argv: string[];
	cwd: string;
	state: "ok" | "failed";
	exitCode: number | null;
	reason?: "exit" | "timeout" | "spawn" | "total";
	seconds: number;
	tail: string;
	/** For a failed spawn: why. */
	error?: string;
}

export interface SetupOutcome {
	ok: boolean;
	steps: StepResult[];
	failed: StepResult | null;
	worktree: string;
	branch: string | null;
}

export interface RunOptions {
	worktree: string;
	branch?: string | null;
	commands: SetupCommand[];
	home: string;
	actor: "panel" | "mcp";
	project: string;
	/** The environment to start from (tests); defaults to the service's with Rokit's bin in front. */
	env?: NodeJS.ProcessEnv;
	onStep?: (index: number, of: number, text: string) => void;
	totalLimitMs?: number;
}

/** A copy of `env` with `folder` first on the path, replacing the existing path variable whatever its case (Windows says `Path`). */
export function withPathFirst(env: NodeJS.ProcessEnv, folder: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	let key = "PATH";
	let current = "";
	for (const [name, value] of Object.entries(env)) {
		if (name.toUpperCase() !== "PATH") result[name] = value;
		else if (current === "") {
			key = name;
			current = value ?? "";
		}
	}
	result[key] = current ? `${folder}${delimiter}${current}` : folder;
	return result;
}

/*
	Runs the commands in order, in the worktree, stopping at the first failure.
	Each command writes an audit line whatever the outcome.
*/
export async function runSetup(options: RunOptions): Promise<SetupOutcome> {
	const { worktree, commands } = options;
	const baseEnv = options.env ?? withPathFirst(process.env, rokitBin());
	const env: NodeJS.ProcessEnv = { ...baseEnv, ROJO_HUB_SETUP: "1", ROJO_HUB_WORKTREE: worktree, ...(options.branch ? { ROJO_HUB_BRANCH: options.branch } : {}) };
	const steps: StepResult[] = [];
	const started = Date.now();
	const limit = options.totalLimitMs ?? TOTAL_LIMIT_MS;
	for (let index = 0; index < commands.length; index++) {
		const command = commands[index];
		const text = commandText(command);
		options.onStep?.(index + 1, commands.length, text);
		const cwd = command.cwd ? resolve(worktree, command.cwd) : worktree;
		const remaining = limit - (Date.now() - started);
		const step: StepResult = { index: index + 1, of: commands.length, text, argv: [command.command, ...command.args], cwd, state: "failed", exitCode: null, seconds: 0, tail: "" };
		if (remaining <= 0) {
			step.reason = "total";
			step.error = `the whole setup is limited to ${Math.round(limit / 60000)} minutes`;
		} else {
			await runOne(command, cwd, env, Math.min(command.timeoutSeconds * 1000, remaining), step);
		}
		steps.push(step);
		writeAudit(options.home, {
			actor: options.actor,
			action: "setup",
			project: options.project,
			worktree,
			argv: step.argv,
			cwd,
			exitCode: step.exitCode,
			seconds: step.seconds,
			state: step.state,
			...(step.reason ? { reason: step.reason } : {}),
			outputTail: tailOf(step.tail, AUDIT_TAIL_BYTES),
		});
		if (step.state === "failed") return { ok: false, steps, failed: step, worktree, branch: options.branch ?? null };
	}
	return { ok: true, steps, failed: null, worktree, branch: options.branch ?? null };
}

function runOne(command: SetupCommand, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, step: StepResult): Promise<void> {
	return new Promise((done) => {
		const at = Date.now();
		const finish = (patch: Partial<StepResult>) => {
			Object.assign(step, patch, { seconds: Math.round((Date.now() - at) / 100) / 10 });
			done();
		};
		if (!existsSync(cwd)) return finish({ reason: "spawn", error: `the folder ${cwd} does not exist`, tail: "" });
		const file = resolveCommand(command.command, env, cwd);
		if (!file) return finish({ reason: "spawn", error: `${command.command} was not found on PATH (Rokit's tool folder included)`, tail: "" });
		let child;
		try {
			if (isCmdFile(file)) {
				// Checked again with the final PATH: the command may resolve to a script the parse-time check did not see.
				const bad = command.args.find((arg) => CMD_METACHARACTERS.test(arg));
				if (bad !== undefined) return finish({ reason: "spawn", error: `${file} is run through cmd.exe, so an argument may not contain & | < > ^ % ! " \` or a line break (found in ${JSON.stringify(bad)})`, tail: "" });
				if (file.includes("%")) return finish({ reason: "spawn", error: `${file} contains %, which cmd.exe would expand` });
				const line = [file, ...command.args].map((part) => (/[\s]|^$/.test(part) ? `"${part}"` : part));
				line[0] = `"${file}"`;
				child = spawn(env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line.join(" ")}"`], { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] });
			} else {
				child = spawn(file, command.args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
			}
		} catch (error) {
			return finish({ reason: "spawn", error: error instanceof Error ? error.message : String(error) });
		}
		let output = "";
		const take = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			// Only the end is ever shown, so only the end is kept.
			if (output.length > 64 * 1024) output = output.slice(-32 * 1024);
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		let timedOut = false;
		let settled = false;
		const settle = (patch: Partial<StepResult>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			finish({ tail: tailOf(output), ...patch });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) void killTree(child.pid);
			// A grandchild that kept the pipes open must not hold the answer.
			setTimeout(() => settle({ reason: "timeout", exitCode: null, error: `timed out after ${Math.round(timeoutMs / 1000)} s` }), 2000).unref();
		}, timeoutMs);
		child.once("error", (error) => settle({ reason: "spawn", error: error.message }));
		child.once("close", (code) => {
			if (timedOut) return settle({ reason: "timeout", exitCode: code, error: `timed out after ${Math.round(timeoutMs / 1000)} s` });
			if (code === 0) settle({ state: "ok", exitCode: 0 });
			else settle({ reason: "exit", exitCode: code, error: `exited with code ${code}` });
		});
	});
}

/* ---------- jobs: one setup per worktree at a time ---------- */

export interface SetupJob {
	path: string;
	state: "running" | "ok" | "failed";
	step: number;
	of: number;
	text: string;
	actor: "panel" | "mcp";
	branch: string | null;
	promise: Promise<SetupOutcome>;
	outcome: SetupOutcome | null;
	startedAt: number;
}

export class SetupJobs {
	private readonly jobs = new Map<string, SetupJob>();

	/** Starts `run`, or joins the setup already running for this worktree. */
	start(worktree: string, actor: "panel" | "mcp", branch: string | null, of: number, run: (job: SetupJob) => Promise<SetupOutcome>): { job: SetupJob; joined: boolean } {
		const key = pathKey(worktree);
		const existing = this.jobs.get(key);
		if (existing?.state === "running") return { job: existing, joined: true };
		const job: SetupJob = { path: worktree, state: "running", step: 0, of, text: "", actor, branch, promise: Promise.resolve(null as unknown as SetupOutcome), outcome: null, startedAt: Date.now() };
		job.promise = run(job).then(
			(outcome) => {
				job.outcome = outcome;
				job.state = outcome.ok ? "ok" : "failed";
				return outcome;
			},
			(error) => {
				job.state = "failed";
				throw error;
			},
		);
		job.promise.catch(() => undefined);
		this.jobs.set(key, job);
		// Finished jobs stay for status, but not without limit.
		if (this.jobs.size > 20) {
			for (const [other, entry] of this.jobs) if (entry.state !== "running" && this.jobs.size > 20) this.jobs.delete(other);
		}
		return { job, joined: false };
	}

	/** Forgets a job that never ran (refused), so it does not show as a failed setup. */
	drop(worktree: string, job: SetupJob): void {
		if (this.jobs.get(pathKey(worktree)) === job) this.jobs.delete(pathKey(worktree));
	}

	running(worktree: string): SetupJob | null {
		const job = this.jobs.get(pathKey(worktree));
		return job?.state === "running" ? job : null;
	}

	get(worktree: string): SetupJob | null {
		return this.jobs.get(pathKey(worktree)) ?? null;
	}

	all(): SetupJob[] {
		return [...this.jobs.values()];
	}
}

/** How an answer describes a finished setup: one line per command that succeeded. */
export function describeSteps(outcome: SetupOutcome): string {
	return outcome.steps.filter((step) => step.state === "ok").map((step) => `setup ${step.index} of ${step.of}: ${step.text} ok (${step.seconds} s)`).join("\n");
}

/** The failure text: the command, why, the output tail, the worktree and what to do. */
export function describeFailure(outcome: SetupOutcome): string {
	const step = outcome.failed!;
	const why = step.reason === "timeout" ? step.error : step.reason === "spawn" ? `could not be started: ${step.error}` : step.reason === "total" ? `not run: ${step.error}` : `exited with code ${step.exitCode}`;
	const done = describeSteps(outcome);
	return [
		`Setup failed at "${step.text}" (step ${step.index} of ${step.of}): ${why}.`,
		...(done ? [done] : []),
		...(step.tail ? [`Last output:\n${step.tail}`] : []),
		`The worktree ${outcome.worktree} was kept and nothing was switched. Fix the cause, then call ensure from that worktree (setup runs again while the install checks fail), or run the command by hand there.`,
	].join("\n");
}

/* ---------- install checks (design 2) ---------- */

export interface CheckResult {
	name: "rojo" | "packages" | "node_modules" | "sourcemap";
	ok: boolean;
	detail: string;
}

const WALLY_SECTIONS: [string, string][] = [
	["dependencies", "Packages"],
	["server-dependencies", "ServerPackages"],
	["dev-dependencies", "DevPackages"],
];

export interface CheckContext {
	rojo: ResolvedRojo;
	/** The project serves this worktree from a borrowed copy that takes Packages from the main checkout. */
	borrowed: boolean;
	sourcemapsOn: boolean;
	/** The slot's sourcemap state, and the worktree it is kept for (null: not a worktree). */
	sourcemap: { state: string; detail: string };
	servedTree: string | null;
	/** Whether the worktree being checked is the served one. */
	serving: boolean;
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The four install checks for a worktree. Reads files only. */
export function installChecks(root: string, context: CheckContext): CheckResult[] {
	const checks: CheckResult[] = [];
	checks.push(context.rojo.ok ? { name: "rojo", ok: true, detail: `Rojo ${context.rojo.version}` } : { name: "rojo", ok: false, detail: context.rojo.error });

	// packages
	const wally = readText(join(root, "wally.toml"));
	if (wally === null) checks.push({ name: "packages", ok: true, detail: "no wally.toml" });
	else {
		let parsed: Record<string, unknown> = {};
		let broken = false;
		try {
			parsed = parse(wally) as Record<string, unknown>;
		} catch {
			broken = true;
		}
		const missing = broken
			? []
			: WALLY_SECTIONS.filter(([section, folder]) => {
					const table = parsed[section];
					return table && typeof table === "object" && Object.keys(table).length > 0 && !existsSync(join(root, folder));
				}).map(([, folder]) => folder);
		if (broken) checks.push({ name: "packages", ok: true, detail: "wally.toml could not be read; not checked" });
		else if (missing.length === 0) checks.push({ name: "packages", ok: true, detail: "wally.toml's package folders exist" });
		else checks.push({ name: "packages", ok: false, detail: `${missing.join(", ")} missing in ${root}${context.borrowed ? "; the project serves this worktree from the main checkout's copy" : ""}` });
	}

	// node_modules
	const manifest = readText(join(root, "package.json"));
	if (manifest === null) checks.push({ name: "node_modules", ok: true, detail: "no package.json" });
	else {
		let needs = false;
		try {
			const data = JSON.parse(manifest) as { dependencies?: object; devDependencies?: object };
			needs = Object.keys(data.dependencies ?? {}).length + Object.keys(data.devDependencies ?? {}).length > 0;
		} catch {
			// An unreadable package.json is not Rojo-Hub's to judge.
		}
		if (!needs) checks.push({ name: "node_modules", ok: true, detail: "package.json lists no dependencies" });
		else if (existsSync(join(root, "node_modules"))) checks.push({ name: "node_modules", ok: true, detail: "node_modules exists" });
		else checks.push({ name: "node_modules", ok: false, detail: `node_modules missing in ${root}` });
	}

	// sourcemap
	if (!context.sourcemapsOn) checks.push({ name: "sourcemap", ok: true, detail: "turned off (rojoHub.sourcemaps)" });
	else {
		const where = context.serving ? "" : `${context.servedTree ? "for the worktree being served, " : ""}not yet for ${root}: `;
		if (context.sourcemap.state !== "watching") checks.push({ name: "sourcemap", ok: false, detail: `${where}${context.sourcemap.detail || context.sourcemap.state}` });
		else if (!context.servedTree || !existsSync(join(context.servedTree, "sourcemap.json"))) checks.push({ name: "sourcemap", ok: false, detail: `${where}sourcemap.json not written yet` });
		else checks.push({ name: "sourcemap", ok: true, detail: `${where}sourcemap.json is kept up to date` });
	}
	return checks;
}
