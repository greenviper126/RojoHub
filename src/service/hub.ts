import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { SlotView, Target, TargetOption } from "../common/api";
import { git, listTargets, listWorktrees, orcaNames, pathKey, primaryCheckout, sameTarget } from "./git";
import { planTree, readProject, slotProject, type Plan } from "./project";
import { allocatePort, Conflict, NotFound, Registry, slugify, type SlotRecord } from "./registry";
import { LogFollower, portFree, rojoAlive, rojoInfo, startRojo, stopRojo } from "./rojo";

const READY_TIMEOUT_MS = 30000;
const PORT_FREE_TIMEOUT_MS = 5000;

interface Runtime {
	state: SlotView["state"];
	error: string | null;
	warnings: string[];
	/** Events worth telling the user about until they next start, stop or switch (e.g. a crash restart). */
	notes: string[];
	mode: Plan["mode"] | null;
	sessionId: string | null;
	log: LogFollower;
	/** Watches the served tree's project file while serving a borrowed copy of it. */
	watcher: FSWatcher | null;
	/** Serializes operations on one slot. */
	queue: Promise<unknown>;
	targetLabel: string;
	branch: string | null;
}

/*
	Owns the slots: their files, their rojo processes, and switching them. All
	mutations of one slot run one at a time through that slot's queue.
*/
export class Hub {
	readonly registry: Registry;
	private readonly runtimes = new Map<string, Runtime>();
	private poller: NodeJS.Timeout | null = null;

	constructor(readonly home: string) {
		this.registry = new Registry(home);
	}

	private slotDir(id: string): string {
		return join(this.home, "slots", id);
	}
	private slotFile(id: string): string {
		return join(this.slotDir(id), "slot.project.json");
	}
	private borrowedFile(id: string): string {
		return join(this.slotDir(id), "borrowed.project.json");
	}
	private logFile(id: string): string {
		return join(this.slotDir(id), "rojo.log");
	}
	private viewsDir(id: string): string {
		return join(this.home, "views", id);
	}
	isHubView = (path: string): boolean => pathKey(path).startsWith(pathKey(join(this.home, "views")) + "/");

	private runtime(id: string): Runtime {
		let runtime = this.runtimes.get(id);
		if (!runtime) {
			runtime = {
				state: "stopped",
				error: null,
				warnings: [],
				notes: [],
				mode: null,
				sessionId: null,
				log: new LogFollower(this.logFile(id)),
				watcher: null,
				queue: Promise.resolve(),
				targetLabel: "",
				branch: null,
			};
			this.runtimes.set(id, runtime);
		}
		return runtime;
	}

	private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
		const runtime = this.runtime(id);
		const next = runtime.queue.then(work, work);
		runtime.queue = next.catch(() => undefined);
		return next;
	}

	/*
		Restores slots that were serving when the service last stopped: adopts a
		rojo that is still up and serving the same project, else starts one.
	*/
	async restore(): Promise<void> {
		this.poller = setInterval(() => this.pollLogs(), 1000);
		this.poller.unref();
		await Promise.all(
			this.registry.slots.map((slot) =>
				this.enqueue(slot.id, async () => {
					const runtime = this.runtime(slot.id);
					await this.describeTarget(slot);
					if (!slot.wantRunning) return;
					const info = await rojoInfo(slot.port);
					if (info && info.projectName === slot.projectName && rojoAlive(this.slotFile(slot.id))) {
						runtime.state = "running";
						runtime.sessionId = info.sessionId;
						runtime.log.poll();
						runtime.log.takeProblems();
						this.watchBorrowed(slot, this.treeOfCurrent(slot));
						return;
					}
					await this.startLocked(slot).catch(() => undefined);
				}),
			),
		);
	}

	/*
		Once a second: new log lines (connections, errors) for every serving slot,
		and whether its rojo still answers, so a crash shows up as an error
		instead of a slot that claims to be running.
	*/
	private pollLogs(): void {
		for (const slot of this.registry.slots) {
			const runtime = this.runtime(slot.id);
			if (runtime.state !== "running") continue;
			runtime.log.poll();
			const problems = runtime.log.takeProblems();
			if (problems.length > 0) runtime.error = problems.slice(-6).join("\n");
			void rojoInfo(slot.port).then((info) => {
				if (runtime.state !== "running" || (info && info.sessionId === runtime.sessionId)) return;
				if (info) {
					runtime.state = "error";
					runtime.error = `Port ${slot.port} now answers with a different Rojo session ("${info.projectName}").`;
					return;
				}
				this.restartAfterCrash(slot);
			});
		}
	}

	/*
		Rojo went away without the Hub stopping it; in 7.7 that is almost always
		the folder-deletion panic (rojo-rbx/rojo#1305). Start it again so the port
		comes back. The new process is a new session, so the Studio plugin has to
		be reconnected by hand; the slot says so.
	*/
	private restartAfterCrash(slot: SlotRecord): void {
		const runtime = this.runtime(slot.id);
		runtime.log.poll();
		const reason = runtime.log.tail(40).split(/\r?\n/).find((line) => line.includes("Details:"))?.replace(/^\[ERROR rojo\]\s*/, "");
		runtime.state = "error";
		runtime.error = `Rojo stopped unexpectedly${reason ? `: ${reason}` : ""}`;
		void this.enqueue(slot.id, async () => {
			if (runtime.state !== "error" || !slot.wantRunning) return;
			runtime.notes = [
				`Rojo crashed at ${new Date().toLocaleTimeString()} and was restarted on the same port; reconnect Studio. ${reason ?? ""}`.trim(),
			];
			await this.startLocked(slot);
		}).catch(() => undefined);
	}

	view(slot: SlotRecord): SlotView {
		const runtime = this.runtime(slot.id);
		return {
			id: slot.id,
			projectName: slot.projectName,
			repoPath: slot.repoPath,
			projectFile: slot.projectFile,
			port: slot.port,
			state: runtime.state,
			connections: runtime.state === "running" ? runtime.log.connections : 0,
			target: slot.target,
			targetLabel: runtime.targetLabel,
			branch: runtime.branch,
			mode: runtime.mode,
			warnings: [...runtime.notes, ...runtime.warnings],
			error: runtime.error,
			sessionId: runtime.sessionId,
			logFile: this.logFile(slot.id),
		};
	}

	list(): SlotView[] {
		return this.registry.slots.map((slot) => this.view(slot));
	}

	/*
		Registers the repo containing `path`. The project name must be unique
		across slots, because the Studio plugin auto-connects a place only to a
		server reporting the name it saved.
	*/
	async add(path: string, projectFile = "default.project.json"): Promise<SlotView> {
		const repoPath = await primaryCheckout(resolve(path));
		const file = join(repoPath, projectFile);
		if (!existsSync(file)) throw new NotFound(`${repoPath} has no ${projectFile}`);
		const name = readProject(file).name;
		if (typeof name !== "string" || name.length === 0) throw new Conflict(`${file} has no "name"`);
		if (this.registry.slots.some((slot) => pathKey(slot.repoPath) === pathKey(repoPath) && slot.projectFile === projectFile)) {
			throw new Conflict(`${repoPath} is already registered`);
		}
		const clash = this.registry.slots.find((slot) => slot.projectName === name);
		if (clash) {
			throw new Conflict(`Another project (${clash.repoPath}) is already named "${name}". Studio auto-connects by name, so names must be unique.`);
		}
		let id = slugify(name);
		while (this.registry.slots.some((slot) => slot.id === id)) id += "-2";
		const port = await allocatePort(
			this.registry.slots.map((slot) => slot.port),
			portFree,
		);
		const slot: SlotRecord = {
			id,
			projectName: name,
			repoPath,
			projectFile,
			port,
			target: { kind: "worktree", path: repoPath },
			wantRunning: false,
			activeView: null,
		};
		this.registry.slots.push(slot);
		this.registry.save();
		await this.describeTarget(slot);
		return this.view(slot);
	}

	remove(id: string): Promise<void> {
		const slot = this.registry.get(id);
		return this.enqueue(id, async () => {
			await this.stopLocked(slot);
			slot.activeView = null;
			await this.collectViews(slot);
			rmSync(this.slotDir(id), { recursive: true, force: true });
			this.registry.slots = this.registry.slots.filter((entry) => entry.id !== id);
			this.registry.save();
			this.runtimes.delete(id);
		});
	}

	targets(id: string): Promise<TargetOption[]> {
		const slot = this.registry.get(id);
		return listTargets(slot.repoPath, this.isHubView);
	}

	start(id: string): Promise<SlotView> {
		const slot = this.registry.get(id);
		return this.enqueue(id, async () => {
			this.runtime(id).notes = [];
			await this.startLocked(slot);
			return this.view(slot);
		});
	}

	stop(id: string): Promise<SlotView> {
		const slot = this.registry.get(id);
		return this.enqueue(id, async () => {
			slot.wantRunning = false;
			this.registry.save();
			this.runtime(id).notes = [];
			await this.stopLocked(slot);
			return this.view(slot);
		});
	}

	/*
		Points the slot at another tree. When the slot is serving, this rewrites
		the project files in place under the running rojo, which applies the
		difference over the same session (spec 001). It never restarts rojo.
	*/
	switch(id: string, target: Target): Promise<SlotView> {
		const slot = this.registry.get(id);
		return this.enqueue(id, async () => {
			const runtime = this.runtime(slot.id);
			const tree = await this.prepareTree(slot, target);
			const plan = this.writeFiles(slot, tree);
			slot.target = target;
			this.registry.save();
			runtime.mode = plan.mode;
			runtime.warnings = plan.warnings;
			runtime.notes = [];
			runtime.error = null;
			runtime.log.poll();
			runtime.log.takeProblems();
			this.watchBorrowed(slot, tree);
			await this.describeTarget(slot);
			if (runtime.state !== "running") await this.collectViews(slot);
			return this.view(slot);
		});
	}

	async shutdown(stopServing: boolean): Promise<void> {
		if (this.poller) clearInterval(this.poller);
		for (const slot of this.registry.slots) {
			const runtime = this.runtime(slot.id);
			runtime.watcher?.close();
			if (stopServing) await this.stopLocked(slot);
		}
	}

	private async startLocked(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		runtime.state = "starting";
		runtime.error = null;
		try {
			const tree = await this.prepareTree(slot, slot.target);
			const plan = this.writeFiles(slot, tree);
			runtime.mode = plan.mode;
			runtime.warnings = plan.warnings;
			stopRojo(this.slotFile(slot.id));
			await this.waitForPortFree(slot.port);
			await this.collectViews(slot);
			if (existsSync(this.logFile(slot.id))) renameSync(this.logFile(slot.id), this.logFile(slot.id).replace(/\.log$/, ".previous.log"));
			runtime.log = new LogFollower(this.logFile(slot.id));
			await startRojo(this.slotFile(slot.id), slot.port, slot.repoPath, this.logFile(slot.id));
			runtime.sessionId = await this.waitForRojo(slot);
			runtime.state = "running";
			slot.wantRunning = true;
			this.registry.save();
			this.watchBorrowed(slot, tree);
			runtime.log.poll();
			runtime.log.takeProblems();
			await this.describeTarget(slot);
		} catch (error) {
			runtime.state = "error";
			runtime.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	private async stopLocked(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		runtime.watcher?.close();
		runtime.watcher = null;
		runtime.state = "stopped";
		runtime.sessionId = null;
		runtime.error = null;
		stopRojo(this.slotFile(slot.id));
		await this.waitForPortFree(slot.port).catch(() => undefined);
		await this.collectViews(slot);
	}

	private async waitForPortFree(port: number): Promise<void> {
		const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await portFree(port)) return;
			await new Promise((done) => setTimeout(done, 100));
		}
		const info = await rojoInfo(port);
		throw new Conflict(
			info
				? `Port ${port} is held by another Rojo serving "${info.projectName}". Stop it (it is not one of the Hub's).`
				: `Port ${port} is held by another program.`,
		);
	}

	/*
		Polls until Rojo answers with this slot's name. The deadline only bounds
		how long a broken start takes to report; readiness itself is the answer.
	*/
	private async waitForRojo(slot: SlotRecord): Promise<string> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		const runtime = this.runtime(slot.id);
		while (Date.now() < deadline) {
			const info = await rojoInfo(slot.port);
			if (info && info.projectName === slot.projectName) return info.sessionId;
			if (!rojoAlive(this.slotFile(slot.id))) break;
			await new Promise((done) => setTimeout(done, 250));
		}
		stopRojo(this.slotFile(slot.id));
		throw new Error(`Rojo did not come up on port ${slot.port}.\n${runtime.log.tail(12)}`);
	}

	/*
		The folder to serve for a target. A worktree is served in place. A branch
		is served from a Hub-owned view: a detached worktree of that branch's
		commit, in a folder of its own that is never modified afterwards.

		Views are never reused for another commit and never deleted while the
		slot's rojo runs, because Rojo 7.7 keeps watching every folder it has read
		and crashes when one of them loses a subfolder (change_processor.rs
		unwraps the canonicalized parent of a removed path; rojo-rbx/rojo#1305).
		A checkout that deletes a folder would trigger exactly that.
	*/
	private async prepareTree(slot: SlotRecord, target: Target): Promise<string> {
		if (target.kind === "worktree") {
			if (!existsSync(target.path)) throw new NotFound(`${target.path} does not exist`);
			slot.activeView = null;
			return resolve(target.path);
		}
		const commit = (await git(slot.repoPath, ["rev-parse", "--verify", `${target.ref}^{commit}`])).trim();
		const worktrees = await listWorktrees(slot.repoPath);
		const existing = worktrees.find((w) => this.isViewOf(slot, w.path) && w.head === commit && existsSync(w.path));
		if (existing) {
			slot.activeView = basename(existing.path);
			return existing.path;
		}
		let name = commit.slice(0, 12);
		for (let n = 2; existsSync(join(this.viewsDir(slot.id), name)); n++) name = `${commit.slice(0, 12)}-${n}`;
		const dir = join(this.viewsDir(slot.id), name);
		mkdirSync(this.viewsDir(slot.id), { recursive: true });
		await git(slot.repoPath, ["worktree", "add", "--detach", dir, commit]);
		slot.activeView = name;
		return dir;
	}

	private isViewOf(slot: SlotRecord, path: string): boolean {
		return pathKey(path).startsWith(pathKey(this.viewsDir(slot.id)) + "/");
	}

	/*
		Writes the borrowed copy (when needed) and then the slot file, the latter
		only when its contents change. Either write alone is one patch.
	*/
	private writeFiles(slot: SlotRecord, tree: string): Plan {
		mkdirSync(this.slotDir(slot.id), { recursive: true });
		const plan = planTree(tree, slot.repoPath, slot.projectFile, this.borrowedFile(slot.id));
		if (plan.borrowedProject) {
			writeFileSync(this.borrowedFile(slot.id), JSON.stringify(plan.borrowedProject, null, "\t") + "\n");
		}
		const primaryProject = readProject(join(slot.repoPath, slot.projectFile));
		const contents = JSON.stringify(slotProject(slot.projectName, primaryProject, plan.nestedFile), null, "\t") + "\n";
		const file = this.slotFile(slot.id);
		if (!existsSync(file) || readFileSync(file, "utf8") !== contents) writeFileSync(file, contents);
		return plan;
	}

	/*
		While a borrowed copy is served, edits to the tree's real project file
		must be carried into the copy; natively served trees need nothing, Rojo
		watches their project file itself.
	*/
	private watchBorrowed(slot: SlotRecord, tree: string | null): void {
		const runtime = this.runtime(slot.id);
		runtime.watcher?.close();
		runtime.watcher = null;
		if (runtime.mode !== "borrowed" || !tree) return;
		const source = join(tree, slot.projectFile);
		if (!existsSync(source)) return;
		const watched = slot.target;
		runtime.watcher = watch(source, () => {
			void this.enqueue(slot.id, async () => {
				if (!sameTarget(slot.target, watched) || runtime.state !== "running") return;
				try {
					const plan = this.writeFiles(slot, tree);
					runtime.mode = plan.mode;
					runtime.warnings = plan.warnings;
					if (plan.mode === "native") this.watchBorrowed(slot, tree);
				} catch (error) {
					runtime.error = error instanceof Error ? error.message : String(error);
				}
			});
		});
	}

	private treeOfCurrent(slot: SlotRecord): string | null {
		if (slot.target.kind === "worktree") return slot.target.path;
		return slot.activeView ? join(this.viewsDir(slot.id), slot.activeView) : null;
	}

	/*
		Removes every view of the slot except the one it is set to serve. Only
		called while the slot's rojo is not running (see prepareTree for why).
	*/
	private async collectViews(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		const root = this.viewsDir(slot.id);
		if (!existsSync(root)) return;
		for (const name of readdirSync(root)) {
			if (name === slot.activeView) continue;
			const dir = join(root, name);
			try {
				await git(slot.repoPath, ["worktree", "remove", "--force", dir]).catch(() => undefined);
				rmSync(dir, { recursive: true, force: true });
			} catch (error) {
				runtime.warnings = [...runtime.warnings, `Could not remove view ${dir}: ${error instanceof Error ? error.message : error}`];
			}
		}
		await git(slot.repoPath, ["worktree", "prune"]).catch(() => undefined);
	}

	private async describeTarget(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		if (slot.target.kind === "branch") {
			runtime.branch = slot.target.ref.replace(/^refs\/(heads|remotes)\//, "");
			runtime.targetLabel = runtime.branch;
			return;
		}
		const path = slot.target.path;
		try {
			const [worktrees, names] = await Promise.all([listWorktrees(slot.repoPath), orcaNames()]);
			const entry = worktrees.find((w) => pathKey(w.path) === pathKey(path));
			runtime.branch = entry?.branch ?? null;
			runtime.targetLabel = names.get(pathKey(path)) ?? entry?.branch ?? path;
		} catch {
			runtime.branch = null;
			runtime.targetLabel = path;
		}
	}
}
