import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { PlaceOpened, PlaceRequestView, PortMove, PortSettings, SlotView, StudioPlaceView, StudioPluginStatus, Target, TargetOption } from "../common/api";
import { longPath } from "../common/paths";
import { defaultProjectFile, DEFAULT_PROJECT_FILE, isProjectFileName, listProjectFiles } from "../common/projectFiles";
import { branchExists, checkBranchName, git, gitProblem, headFile, inOrca, listWorktrees, NO_HOOKS, orcaCreateWorktree, orcaNames, pathKey, primaryCheckout, pruneMissingWorktreesUnder, readHead, resolveBase, sameFolders, sameTarget } from "./git";
import { writeAudit } from "./audit";
import { OFF_MESSAGE, Places } from "./places";
import { planTree, readProject, slotProject, type Plan } from "./project";
import { assignPorts, loadPortConfig, loadPortSettings, repoSeed, savePortSettings, type PortAssignment, type PortRequest } from "./ports";
import { PlaceRequests, listersOf, type RequestProject } from "./requests";
import { Conflict, NotFound, Registry, slugify, type SlotRecord } from "./registry";
import { buildPlace, kill, LogFollower, portFree, rojoAlive, rojoInfo, startRojo, stopRojo, type StartedRojo } from "./rojo";
import { describeFailure, describeSteps, normaliseRepoKey, parseSetupCommands, runSetup, SetupJobs, type ParsedSetup, type SetupCommand, type SetupJob, type SetupOutcome } from "./setup";
import { mayWrite, SourcemapWatcher, stopStrayWatchers, writeSourcemap } from "./sourcemap";
import { StudioLinks, type PlaceCandidate } from "./studio";
import { installPlugin, PLUGIN_FILE } from "./studioPlugin";
import { TargetCache } from "./targets";
import { olderThan77, resolveRojo } from "./tools";

/** A project file's place fields; gameId is Rojo's name for the universe ID (spec 009). */
type PlaceFields = Pick<PlaceCandidate, "servePlaceIds" | "blockedPlaceIds" | "placeId"> & { gameId: number | null };

const READY_TIMEOUT_MS = 30000;
const PORT_FREE_TIMEOUT_MS = 5000;
/** A crash this soon after a checkout in the served worktree is put down to that checkout. */
const CHECKOUT_CRASH_MS = 120000;
/** How long a project's list of *.project.json files is reused before its folder is read again. */
const PROJECT_FILES_MS = 2000;
/*
	Status checks in a row that must go unanswered before a serving rojo is
	looked for as crashed. One slow answer (a big switch, a busy machine) is not
	a crash, and restarting a healthy rojo would disconnect Studio.
*/
const CRASH_MISSES = 3;
/** A new session disconnects Studio; Rojo-Hub's plugin reconnects by itself (spec 007), Rojo's own does not. */
const RECONNECT = "Places with Rojo-Hub's Studio plugin carry on by themselves, without showing a disconnect; with Rojo's own plugin, reconnect Studio.";
/** How long a new port assignment must hold before a slot is moved to it (see refreshPorts). */
const MOVE_SETTLE_MS = 2500;

interface Runtime {
	state: SlotView["state"];
	error: string | null;
	warnings: string[];
	/** Events worth telling the user about until they next start, stop or switch (e.g. a crash restart). */
	notes: string[];
	/** About the running rojo itself (an old pinned version); kept across switches, cleared on start. */
	toolWarnings: string[];
	mode: Plan["mode"] | null;
	sessionId: string | null;
	log: LogFollower;
	/** Watches the served tree's project file while serving a borrowed copy of it. */
	watcher: FSWatcher | null;
	/** Serializes operations on one slot. */
	queue: Promise<unknown>;
	targetLabel: string;
	branch: string | null;
	/** The served worktree's HEAD file and what it said, to notice a checkout made in it while serving. */
	headFile: string | null;
	head: string | null;
	/** The last such checkout, to explain a crash that follows it. */
	checkout: { branch: string; at: number } | null;
	/** Keeps the served worktree's sourcemap.json current while serving (spec 003). */
	sourcemap: SourcemapWatcher | null;
	/** Why there is no sourcemap watcher, for the panel. */
	sourcemapOff: string;
	/** The rojo this service started, while it runs; null for one adopted from an earlier service. */
	rojo: StartedRojo | null;
	/** Status checks in a row that went unanswered (see CRASH_MISSES). */
	misses: number;
	/** The version of the rojo serving, when known; the Studio plugin speaks only 7.7 and newer (spec 007). */
	rojoVersion: string | null;
	/** A status check is in flight, so the next tick does not start another. */
	probing: boolean;
	/** Rojo is being started again by the Hub itself (a crash, a port move), so Studio waits for it quietly (spec 010). */
	restarting: boolean;
	/** When the Hub last restarted a crashed rojo, so an agent's answer can say it happened meanwhile. */
	crashedAt: number;
	/** pathKeys of the worktrees this slot's rojo has been pointed at since it started: it has read them (spec 012). Emptied when it stops. */
	served: Set<string>;
	/** An adopted rojo whose served history was not saved (an older service ran it): any worktree may have been read. Until it stops. */
	servedUnknown: boolean;
}

/** A worktree's setup commands failed (spec 012): the worktree is kept, nothing is switched. */
export class SetupFailed extends Conflict {
	constructor(readonly outcome: SetupOutcome) {
		super(describeFailure(outcome));
	}
}

/*
	An agent's hold on a slot (spec 004): what it serves, a label for people,
	and when the hold runs out. `key` is claimKey() of the target.
*/
export interface Claim {
	key: string;
	label: string;
	until: number;
	/** What the slot served before this claim took it, when the agent asked to give it back (spec 013). */
	returnTo?: { target: Target; label: string };
}

/** What handBack did: it switched back, or why it left the project as it is. */
export type HandBack = { returned: true; label: string } | { returned: false; why: string };

export function claimKey(target: Target): string {
	return target.kind === "worktree" ? `worktree:${pathKey(target.path)}` : `branch:${target.ref}`;
}

/*
	Owns the slots: their files, their rojo processes, and switching them. All
	mutations of one slot run one at a time through that slot's queue.
*/
export class Hub {
	readonly registry: Registry;
	private readonly runtimes = new Map<string, Runtime>();
	private poller: NodeJS.Timeout | null = null;
	private ticks = 0;
	private assignments = new Map<string, PortAssignment>();
	private portProblems: string[] = [];
	/** Slots with a port move queued, so a slow restart is not queued twice. */
	private readonly moving = new Set<string>();

	/*
		Agents' claims by slot id (spec 004). Kept in claims.json too, so a service
		restarted by an update (or a crash) does not free a project an agent is in
		the middle of testing.
	*/
	private readonly claims = new Map<string, Claim>();
	/** Claims that ran out, so release can say so instead of "not claimed". */
	private readonly lapsed = new Map<string, Claim>();

	/** A port a slot is to move to, and since when it has been the one assigned (see refreshPorts). */
	private readonly pendingMoves = new Map<string, { port: number; since: number }>();

	/** The servePort last read from each slot's project file, kept while the file cannot be read (see portRequests). */
	private readonly servePorts = new Map<string, number | null>();

	/** Serializes add(), which checks the registry, awaits git, then adds to it. */
	private adding: Promise<unknown> = Promise.resolve();

	/** Each repo's *.project.json files and when they were read, so every status has them without a read each time (spec 005). */
	private readonly projectFiles = new Map<string, { at: number; files: string[] }>();

	/** The branch picker's lists, kept warm in the background (spec 002). */
	readonly targetCache: TargetCache;

	/** Each project file's place fields, reread only when the file changes (spec 007). */
	private readonly placeFields = new Map<string, { mtime: number; fields: PlaceFields }>();

	/** The Studio plugins connected to the service (spec 007). */
	readonly studio: StudioLinks;

	/** Opening a project's places in Studio (spec 009). */
	readonly places: Places;

	/** Agents' asks to move a Studio place to their project, waiting for the user (spec 014). */
	readonly requests: PlaceRequests;

	/** The Studio plugin's install, for the panel (spec 007). */
	studioPlugin: StudioPluginStatus = { state: "off", detail: "", removed: [], officialRojo: false };

	constructor(readonly home: string) {
		this.registry = new Registry(home);
		this.loadClaims();
		this.studio = new StudioLinks(() => this.placeCandidates(), {
			assigned: (placeId) => this.registry.placeChoices[String(placeId)] ?? null,
			assign: (placeId, slotId) => {
				if (slotId) this.registry.placeChoices[String(placeId)] = slotId;
				else delete this.registry.placeChoices[String(placeId)];
				this.registry.save();
			},
			accepted: (placeId, projectName) => this.registry.placeAccepted[String(placeId)]?.includes(projectName) ?? false,
			accept: (placeId, projectName) => {
				const names = (this.registry.placeAccepted[String(placeId)] ??= []);
				if (!names.includes(projectName)) names.push(projectName);
				this.registry.save();
			},
			synced: (placeId) => this.registry.placeSynced[String(placeId)] ?? null,
			sync: (placeId, projectName) => {
				this.registry.placeSynced[String(placeId)] = projectName;
				this.registry.save();
			},
		});
		this.studio.rememberedAutoConnect = loadPortSettings(home).studioAutoConnect !== "listed";
		this.requests = new PlaceRequests({
			projects: () => this.requestProjects(),
			holderOf: (placeId) => this.placeHolder(placeId),
			assigned: (placeId) => this.registry.placeChoices[String(placeId)] ?? null,
			assign: (placeId, slotId) => this.studio.assign(String(placeId), slotId),
			claimKeyOf: (slotId) => this.claimOf(slotId)?.key ?? null,
		});
		this.places = new Places(
			home,
			() => this.openPlacesOn,
			() => this.studio.places().filter((place) => !place.unsaved),
		);
		mkdirSync(join(home, "views"), { recursive: true });
		this.viewRoots = sameFolders(join(home, "views"));
		this.targetCache = new TargetCache((path) => this.isHubView(path));
	}

	private trackRepos(): void {
		this.targetCache.track([...new Set(this.registry.slots.map((slot) => slot.repoPath))]);
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
	/** Worktrees the slot's running rojo has read, kept so a restarted service that adopts the rojo still knows (rojo-rbx/rojo#1305). */
	private servedFile(id: string): string {
		return join(this.slotDir(id), "served.json");
	}
	private saveServed(id: string, runtime: Runtime): void {
		try {
			if (runtime.served.size === 0) rmSync(this.servedFile(id), { force: true });
			else {
				mkdirSync(this.slotDir(id), { recursive: true });
				writeFileSync(this.servedFile(id), JSON.stringify([...runtime.served]));
			}
		} catch {
			// Best effort: the history is also kept in memory.
		}
	}
	private loadServed(id: string): Set<string> | null {
		try {
			const list = JSON.parse(readFileSync(this.servedFile(id), "utf8")) as unknown;
			return Array.isArray(list) ? new Set(list.filter((entry): entry is string => typeof entry === "string")) : null;
		} catch {
			return null;
		}
	}
	private logFile(id: string): string {
		return join(this.slotDir(id), "rojo.log");
	}
	private viewsDir(id: string): string {
		return join(this.home, "views", id);
	}
	/** The views folder, by its own path and its real one (see sameFolders). */
	private viewRoots: string[] = [];
	isHubView = (path: string): boolean => this.viewRoots.some((root) => pathKey(path).startsWith(root + "/"));

	private runtime(id: string): Runtime {
		let runtime = this.runtimes.get(id);
		if (!runtime) {
			runtime = {
				state: "stopped",
				error: null,
				warnings: [],
				notes: [],
				toolWarnings: [],
				mode: null,
				sessionId: null,
				log: new LogFollower(this.logFile(id)),
				watcher: null,
				queue: Promise.resolve(),
				targetLabel: "",
				branch: null,
				headFile: null,
				head: null,
				checkout: null,
				sourcemap: null,
				sourcemapOff: "Kept up to date while the project is serving",
				rojo: null,
				misses: 0,
				probing: false,
				restarting: false,
				crashedAt: 0,
				rojoVersion: null,
				served: new Set(),
				servedUnknown: false,
			};
			this.runtimes.set(id, runtime);
		}
		return runtime;
	}

	/*
		Runs work on a slot after the work already queued for it. Work that was
		queued behind a Remove finds the slot gone and is refused, so it never
		starts a rojo or writes files for a project that no longer exists.
	*/
	private enqueue<T>(slot: SlotRecord, work: () => Promise<T>): Promise<T> {
		const runtime = this.runtime(slot.id);
		const guarded = () => {
			if (!this.registry.slots.includes(slot)) throw new NotFound(`${slot.projectName} was removed from Rojo-Hub`);
			return work();
		};
		const next = runtime.queue.then(guarded, guarded);
		runtime.queue = next.catch(() => undefined);
		return next;
	}

	/*
		Restores slots that were serving when the service last stopped: adopts a
		rojo that is still up and serving the same project, else starts one.
	*/
	async restore(): Promise<void> {
		this.syncStudioPlugin();
		this.poller = setInterval(() => {
			this.pollLogs();
			this.returnLapsed();
		}, 1000);
		this.poller.unref();
		for (const slot of this.registry.slots) {
			if (!slot.seed) slot.seed = await repoSeed(slot.repoPath, slot.projectName);
		}
		this.refreshPorts();
		this.trackRepos();
		await Promise.all(
			this.registry.slots.map((slot) =>
				this.enqueue(slot, async () => {
					const runtime = this.runtime(slot.id);
					await this.describeTarget(slot);
					if (!slot.wantRunning) return;
					const info = await rojoInfo(slot.port);
					if (info && info.projectName === slot.projectName && (await rojoAlive(this.slotFile(slot.id)))) {
						runtime.state = "running";
						runtime.sessionId = info.sessionId;
						runtime.rojoVersion = info.serverVersion || null;
						// What the adopted rojo has read: the saved history, else unknown (setup is refused for this project until it stops).
						const history = this.loadServed(slot.id);
						runtime.served = history ?? new Set();
						runtime.servedUnknown = history === null;
						if (slot.target.kind === "worktree") runtime.served.add(pathKey(slot.target.path));
						runtime.log.poll();
						runtime.log.takeProblems();
						this.watchBorrowed(slot, this.treeOfCurrent(slot));
						this.trackHead(slot);
						await this.syncSourcemap(slot);
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
		if (++this.ticks % 3 === 0) this.refreshPorts();
		// The plugins folder changes behind the service's back (Rojo's plugin removed, ours deleted): look again.
		if (this.ticks % 5 === 0) this.syncStudioPlugin();
		for (const slot of this.registry.slots) {
			const runtime = this.runtime(slot.id);
			if (runtime.state !== "running") continue;
			this.checkHead(slot);
			runtime.log.poll();
			const problems = runtime.log.takeProblems();
			if (problems.length > 0) runtime.error = problems.slice(-6).join("\n");
			if (runtime.probing) continue;
			runtime.probing = true;
			void this.probe(slot, runtime).finally(() => (runtime.probing = false));
		}
	}

	/*
		Asks the slot's rojo whether it is still the session the Hub started. Only
		after CRASH_MISSES unanswered checks in a row, and only when no rojo for
		the slot is running any more, is it treated as a crash.
	*/
	private async probe(slot: SlotRecord, runtime: Runtime): Promise<void> {
		const session = runtime.sessionId;
		const info = await rojoInfo(slot.port);
		if (runtime.state !== "running" || runtime.sessionId !== session) return;
		if (info && info.sessionId === session) {
			runtime.misses = 0;
			return;
		}
		if (info) {
			runtime.state = "error";
			runtime.error = `Port ${slot.port} now answers with a different Rojo session ("${info.projectName}").`;
			return;
		}
		// A rojo this service started reports its own exit, so its crash needs no waiting and no lookup.
		const own = runtime.rojo;
		if (own ? own.alive() : ++runtime.misses < CRASH_MISSES) return;
		if (!own && (await rojoAlive(this.slotFile(slot.id)))) {
			// Alive but not answering (hung, or very busy): not a crash. Look again only after a while, not with PowerShell every second.
			runtime.misses = -3 * CRASH_MISSES;
			return;
		}
		if (runtime.state !== "running" || runtime.sessionId !== session) return;
		runtime.misses = 0;
		this.restartAfterCrash(slot);
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
		runtime.restarting = slot.wantRunning;
		runtime.crashedAt = Date.now();
		void this.enqueue(slot, async () => {
			if (runtime.state !== "error" || !slot.wantRunning) {
				runtime.restarting = false;
				return;
			}
			const checkout = runtime.checkout && Date.now() - runtime.checkout.at < CHECKOUT_CRASH_MS ? runtime.checkout : null;
			runtime.notes = [
				checkout && slot.target.kind === "worktree"
					? `Checking out ${checkout.branch} in ${basename(slot.target.path)} removed a folder Rojo was watching, and Rojo 7.7 crashed (rojo-rbx/rojo#1305). Rojo-Hub restarted it on the same port; ${RECONNECT} Picking a branch in Rojo-Hub's picker switches without this.`
					: `Rojo crashed at ${new Date().toLocaleTimeString()} and was restarted on the same port; ${RECONNECT} ${reason ?? ""}`.trim(),
			];
			await this.startLocked(slot);
		}).catch(() => undefined);
	}

	/*
		Recomputes every slot's port from the port settings, the project files'
		servePort and the repo seeds (src/service/ports.ts). A slot whose port
		changed gets it through its queue; a running one is restarted on the new
		port, which Studio sees as a new session.
	*/
	private refreshPorts(settle = true): void {
		const config = loadPortConfig(this.home);
		this.portProblems = config.problems;
		this.assignments = assignPorts(this.portRequests(this.registry.slots), config);
		for (const slot of this.registry.slots) {
			const assigned = this.assignments.get(slot.id);
			if (!assigned?.port || assigned.port === slot.port) {
				this.pendingMoves.delete(slot.id);
				continue;
			}
			if (slot.port === 0) {
				slot.port = assigned.port;
				this.registry.save();
				continue;
			}
			/*
				A move restarts a serving rojo, so it waits until the new port has held
				for a while: an auto-saved servePort being typed (3, 34, 349…) or a line
				deleted and put back must not restart it at every step. A change of the
				port settings, which the user saved on purpose, moves at once.
			*/
			const pending = this.pendingMoves.get(slot.id);
			if (settle && (!pending || pending.port !== assigned.port)) {
				this.pendingMoves.set(slot.id, { port: assigned.port, since: Date.now() });
				continue;
			}
			if (settle && Date.now() - pending!.since < MOVE_SETTLE_MS) continue;
			this.pendingMoves.delete(slot.id);
			if (this.moving.has(slot.id)) continue;
			this.moving.add(slot.id);
			void this.enqueue(slot, async () => {
				const now = this.assignments.get(slot.id);
				if (!now?.port || now.port === slot.port) return;
				const from = slot.port;
				const runtime = this.runtime(slot.id);
				const wasServing = runtime.state === "running" || runtime.state === "error";
				runtime.restarting = wasServing && slot.wantRunning;
				if (wasServing) await this.stopLocked(slot);
				slot.port = now.port;
				this.registry.save();
				runtime.notes = [`Port moved from ${from} to ${slot.port}${wasServing ? `. ${RECONNECT}` : "."}`];
				if (wasServing && slot.wantRunning) await this.startLocked(slot);
			})
				.catch(() => undefined)
				.finally(() => this.moving.delete(slot.id));
		}
	}

	private portRequests(slots: SlotRecord[]): PortRequest[] {
		return slots.map((slot) => {
			let servePort: number | null;
			try {
				const value = readProject(join(slot.repoPath, slot.projectFile)).servePort;
				servePort = Number.isInteger(value) ? (value as number) : null;
				this.servePorts.set(slot.id, servePort);
			} catch {
				// Mid-edit (an auto-save of half-typed JSON) or briefly locked: keep the servePort last read,
				// or the port would move to the hashed one and back, restarting rojo twice.
				servePort = this.servePorts.get(slot.id) ?? null;
			}
			return { id: slot.id, name: slot.projectName, seed: slot.seed ?? `name:${slot.projectName}`, servePort };
		});
	}

	/*
		The projects whose port would change if this one were removed: a project
		that was pushed off its own port by it moves back. Worked out with the same
		assignment that refreshPorts runs after the removal, so the Remove
		confirmation can say it first.
	*/
	portMovesOnRemove(id: string): PortMove[] {
		this.registry.get(id);
		const rest = this.registry.slots.filter((slot) => slot.id !== id);
		const after = assignPorts(this.portRequests(rest), loadPortConfig(this.home));
		const moves: PortMove[] = [];
		for (const slot of rest) {
			const to = after.get(slot.id)?.port;
			if (!to || !slot.port || to === slot.port) continue;
			const state = this.runtime(slot.id).state;
			moves.push({ id: slot.id, projectName: slot.projectName, from: slot.port, to, serving: state === "running" || state === "starting" || state === "error" });
		}
		return moves;
	}

	/** rojoHub.openPlaces (spec 009), read from settings.json once and then kept with each change. */
	private openPlacesSetting: boolean | null = null;
	get openPlacesSwitchOn(): boolean {
		this.openPlacesSetting ??= loadPortSettings(this.home).openPlaces === true;
		return this.openPlacesSetting;
	}
	/** Whether agents and the panel may open places: rojoHub.openPlaces, or yolo mode (spec 012). */
	get openPlacesOn(): boolean {
		return this.openPlacesSwitchOn || this.yoloOn;
	}
	/** rojoHub.yolo (spec 012, design 4), as the extension pushed it after the user accepted the warning. */
	private yoloSetting: boolean | null = null;
	get yoloOn(): boolean {
		this.yoloSetting ??= loadPortSettings(this.home).yolo === true;
		return this.yoloSetting;
	}

	/* ---------- setup commands (spec 012) ---------- */

	/** The setup jobs, one per worktree at a time. */
	readonly setupJobs = new SetupJobs();
	private setupParsed: ParsedSetup | null = null;

	private setupSettings(): ParsedSetup {
		this.setupParsed ??= parseSetupCommands(loadPortSettings(this.home).setupCommands);
		return this.setupParsed;
	}

	/** Problems with rojoHub.setupCommands, one line each, for the answer to a settings push. */
	setupProblems(): string[] {
		return [...this.setupSettings().problems.values()].flat();
	}

	/** The setup configured for a repo: its commands, a problem with its entry, or null for none. */
	setupFor(repoPath: string): { commands: SetupCommand[] } | { problem: string } | null {
		const settings = this.setupSettings();
		const key = normaliseRepoKey(repoPath);
		const problems = settings.problems.get(key);
		if (problems) return { problem: `rojoHub.setupCommands for ${repoPath} is invalid, so no setup was run: ${problems.join(" ")}` };
		const commands = settings.entries.get(key);
		return commands && commands.length > 0 ? { commands } : null;
	}

	/*
		True when a running or starting rojo has read this worktree: it is that
		slot's target now, or was since the rojo started. Rojo 7.7 never unwatches
		a folder it has read and panics when one loses a subfolder
		(rojo-rbx/rojo#1305), so setup must not touch such a worktree. A stopped
		slot has read nothing.
	*/
	worktreeRead(path: string): boolean {
		const key = pathKey(path);
		for (const slot of this.registry.slots) {
			const runtime = this.runtime(slot.id);
			if (runtime.state !== "running" && runtime.state !== "starting") continue;
			if (slot.target.kind === "worktree" && pathKey(slot.target.path) === key) return true;
			if (runtime.served.has(key)) return true;
		}
		return false;
	}

	/** Whether `path` is a linked worktree (its git dir differs from the repo's common dir), not a main checkout. */
	async isLinkedWorktree(path: string): Promise<boolean> {
		try {
			const dir = (await git(path, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
			const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
			return pathKey(dir) !== pathKey(common);
		} catch {
			return false;
		}
	}

	/*
		Why setup may not run in this worktree, or null. Never the main checkout
		(worktrees borrow its Packages), never one Rojo has read.
	*/
	async setupRefusal(slot: SlotRecord, worktree: string): Promise<string | null> {
		if (pathKey(worktree) === pathKey(slot.repoPath) || !(await this.isLinkedWorktree(worktree))) return `${worktree} is the main checkout, not a linked worktree; setup never runs there (other worktrees borrow its Packages).`;
		if (pathKey(await primaryCheckout(worktree)) !== pathKey(slot.repoPath)) return `${worktree} is not a worktree of ${slot.projectName}'s repo (${slot.repoPath}); setup never runs in another repo's folder.`;
		const owner = this.runtime(slot.id);
		if (owner.servedUnknown && (owner.state === "running" || owner.state === "starting")) return `${slot.projectName}'s Rojo was adopted from an older service, so which worktrees it has read is unknown; stop the project to install, or install by hand.`;
		if (this.worktreeRead(worktree)) return "the worktree is being served (or was, since Rojo started); stop the project to install, or install by hand.";
		return null;
	}

	/*
		Runs the repo's setup commands in a worktree, or joins the setup already
		running there. Null when the repo has none. `waitMs` bounds how long the
		caller waits; the setup carries on past it (outcome null then).
	*/
	async setupWorktree(id: string, worktree: string, options: { actor: "panel" | "mcp"; branch: string | null; waitMs?: number }): Promise<{ job: SetupJob; outcome: SetupOutcome | null; joined: boolean } | null> {
		const slot = this.registry.get(id);
		const configured = this.setupFor(slot.repoPath);
		if (configured && "problem" in configured) throw new Conflict(configured.problem);
		const running = this.setupJobs.running(worktree);
		if (!configured && !running) return null;
		let started: { job: SetupJob; joined: boolean };
		if (running) started = { job: running, joined: true };
		else {
			// The job is reserved before the first await, so a switch that arrives while git is being asked sees setup running.
			const commands = (configured as { commands: SetupCommand[] }).commands;
			let refused: string | null = null;
			started = this.setupJobs.start(worktree, options.actor, options.branch, commands.length, async (job) => {
				refused = await this.setupRefusal(slot, worktree);
				if (refused) throw new Conflict(`Setup was not run: ${refused}`);
				return runSetup({
					worktree,
					branch: options.branch,
					commands,
					home: this.home,
					actor: options.actor,
					project: slot.projectName,
					onStep: (step, of, text) => Object.assign(job, { step, of, text }),
				});
			});
			started.job.promise.catch(() => {
				if (refused) this.setupJobs.drop(worktree, started.job);
			});
		}
		if (options.waitMs === undefined) return { ...started, outcome: await started.job.promise };
		const timer = new Promise<null>((done) => setTimeout(() => done(null), options.waitMs).unref());
		return { ...started, outcome: await Promise.race([started.job.promise, timer]) };
	}

	/** Stores new global port settings and moves any slot whose port changes. */
	setPortSettings(settings: PortSettings): void {
		const pluginWasOn = loadPortSettings(this.home).studioPlugin !== false;
		const yoloWas = this.yoloOn;
		savePortSettings(this.home, settings);
		// Fields left out of the push keep their saved value.
		const saved = loadPortSettings(this.home);
		this.setupParsed = parseSetupCommands(saved.setupCommands);
		this.openPlacesSetting = settings.openPlaces === true;
		if ((saved.yolo === true) !== yoloWas) writeAudit(this.home, { actor: "extension", action: saved.yolo === true ? "yolo_on" : "yolo_off" });
		this.yoloSetting = saved.yolo === true;
		this.studio.rememberedAutoConnect = settings.studioAutoConnect !== "listed";
		if ((settings.studioPlugin !== false) !== pluginWasOn) this.syncStudioPlugin();
		this.refreshPorts(false);
		for (const slot of this.registry.slots) void this.enqueue(slot, () => this.syncSourcemap(slot)).catch(() => undefined);
	}

	/*
		Installs or updates the Studio plugin built beside the service bundle, unless
		rojoHub.studioPlugin is off; then the plugins folder is left alone.
	*/
	syncStudioPlugin(): void {
		if (loadPortSettings(this.home).studioPlugin === false) {
			this.studioPlugin = { state: "off", detail: "rojoHub.studioPlugin is off; Rojo-Hub leaves Studio's plugins folder alone.", removed: [], officialRojo: false };
			return;
		}
		this.studioPlugin = installPlugin(join(__dirname, PLUGIN_FILE));
	}

	/** The last `count` lines of the slot's rojo log (agents' `log` tool, spec 008). */
	logTail(id: string, count: number): string {
		this.registry.get(id);
		return this.runtime(id).log.tail(count);
	}

	/** The slot's claim, or null when there is none or it ran out. */
	claimOf(id: string): Claim | null {
		const claim = this.claims.get(id);
		if (claim && claim.until <= Date.now()) {
			this.claims.delete(id);
			this.lapsed.set(id, claim);
		}
		return this.claims.get(id) ?? null;
	}

	/** The slot's claim that ran out, until it is claimed again or released. */
	lapsedClaim(id: string): Claim | null {
		this.claimOf(id);
		return this.lapsed.get(id) ?? null;
	}

	/*
		Gives back the projects whose claim ran out with a return to make (spec
		013). Runs every second; claimOf moves the claim to `lapsed`, and
		handBack checks, inside the slot's queue, that nobody has taken the
		project since and that it is serving.
	*/
	private returnLapsed(): void {
		for (const id of [...this.claims.keys()]) this.claimOf(id);
		for (const [id, claim] of [...this.lapsed]) {
			if (!claim.returnTo) continue;
			this.lapsed.set(id, { key: claim.key, label: claim.label, until: claim.until });
			void this.handBack(id, claim, "expiry").catch(() => undefined);
		}
	}

	/*
		Switches a slot back to what it served before `claim` took it, live (the
		same switch as any other, never a restart). Only when: it is serving,
		it still serves the claim's target, no other claim holds it, and the
		old worktree's folder exists. `how` "release": the claim is still in
		place (the caller clears it afterwards). "expiry": it ran out, so any
		unexpired claim now belongs to someone who took the project since.
	*/
	async handBack(id: string, claim: Claim, how: "release" | "expiry"): Promise<HandBack> {
		const back = claim.returnTo;
		if (!back) return { returned: false, why: "it was not asked to return" };
		let slot: SlotRecord;
		try {
			slot = this.registry.get(id);
		} catch {
			return { returned: false, why: "the project is gone" };
		}
		return this.enqueue(slot, async () => {
			const current = this.claims.get(id);
			if (current && (how === "expiry" ? current.until > Date.now() : current.key !== claim.key)) return { returned: false, why: `another agent (${current.label}) holds it now` } as HandBack;
			if (this.runtime(id).state !== "running") return { returned: false, why: "the project is not serving" } as HandBack;
			if (claimKey(slot.target) !== claim.key) return { returned: false, why: "it serves something else now" } as HandBack;
			if (back.target.kind === "worktree" && !existsSync(back.target.path)) return { returned: false, why: `${back.target.path} no longer exists` } as HandBack;
			try {
				await this.switchLocked(slot, back.target);
			} catch (error) {
				return { returned: false, why: `the switch failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` } as HandBack;
			}
			return { returned: true, label: back.label } as HandBack;
		});
	}

	/** When the Hub last restarted a crashed rojo on the slot (0: never). */
	crashedAt(id: string): number {
		return this.runtime(id).crashedAt;
	}

	setClaim(id: string, claim: Claim | null): void {
		this.lapsed.delete(id);
		if (claim) this.claims.set(id, claim);
		else this.claims.delete(id);
		try {
			const temporary = join(this.home, "claims.json.tmp");
			writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.claims), null, "\t") + "\n");
			renameSync(temporary, join(this.home, "claims.json"));
		} catch {
			// Claims still work for this service's life; only surviving a restart is lost.
		}
	}

	private loadClaims(): void {
		try {
			const saved = JSON.parse(readFileSync(join(this.home, "claims.json"), "utf8")) as Record<string, Partial<Claim>>;
			for (const [id, claim] of Object.entries(saved)) {
				if (typeof claim?.key === "string" && typeof claim.label === "string" && typeof claim.until === "number") {
					const back = claim.returnTo;
					const returnTo = back && typeof back.label === "string" && back.target && (back.target.kind === "worktree" || back.target.kind === "branch") ? { target: back.target, label: back.label } : undefined;
					const loaded: Claim = { key: claim.key, label: claim.label, until: claim.until, ...(returnTo ? { returnTo } : {}) };
					// One that ran out while the service was down still gives its project back (returnLapsed).
					if (claim.until > Date.now()) this.claims.set(id, loaded);
					else if (returnTo) this.claims.set(id, loaded);
				}
			}
		} catch {
			// none saved, or unreadable: start with none, as before
		}
	}

	/*
		The project file list for a slot's folder. Read at most every two seconds,
		about as often as the panel asks for status, so a file added or removed
		shows up in the open list by itself.
	*/
	private filesOf(repoPath: string): string[] {
		const key = pathKey(repoPath);
		const cached = this.projectFiles.get(key);
		if (cached && Date.now() - cached.at < PROJECT_FILES_MS) return cached.files;
		const files = listProjectFiles(repoPath);
		this.projectFiles.set(key, { at: Date.now(), files });
		return files;
	}

	view(slot: SlotRecord): SlotView {
		const runtime = this.runtime(slot.id);
		const claim = this.claimOf(slot.id);
		return {
			id: slot.id,
			projectName: slot.projectName,
			repoPath: slot.repoPath,
			projectFile: slot.projectFile,
			projectFiles: this.filesOf(slot.repoPath),
			port: slot.port,
			state: runtime.state,
			connections: runtime.state === "running" ? runtime.log.connections : 0,
			target: slot.target,
			targetLabel: runtime.targetLabel,
			branch: runtime.branch,
			mode: runtime.mode,
			warnings: [
				...runtime.notes,
				...(this.assignments.get(slot.id)?.note ? [this.assignments.get(slot.id)!.note!] : []),
				...this.portProblems,
				...runtime.toolWarnings,
				...runtime.warnings,
			],
			error: this.assignments.get(slot.id)?.error ?? runtime.error,
			portSource: this.assignments.get(slot.id)?.source ?? "hash",
			sessionId: runtime.sessionId,
			logFile: this.logFile(slot.id),
			targetsAt: this.targetCache.stamp(slot.repoPath),
			sourcemap: runtime.sourcemap?.status ?? { state: "off", detail: runtime.sourcemapOff },
			claim: claim ? { label: claim.label, until: claim.until } : null,
			places: runtime.state === "running" ? this.studio.placesOn(slot.port, runtime.sessionId) : [],
			listedPlaces: this.places.listed(this.listedPlaceIds(slot)),
			rojoVersion: runtime.rojoVersion,
		};
	}

	/*
		The places a slot's project file names, in order: servePlaceIds, then
		placeId; never one in blockedPlaceIds (spec 009).
	*/
	listedPlaceIds(slot: SlotRecord): number[] {
		const fields = this.placeFieldsOf(slot);
		const ids = [...(fields.servePlaceIds ?? []), ...(fields.placeId ? [fields.placeId] : [])].filter((id) => id > 0 && !fields.blockedPlaceIds?.includes(id));
		return [...new Set(ids)];
	}

	/** Every project with the places it lists, for place requests and for spotting shared places (spec 014). */
	requestProjects(): RequestProject[] {
		return this.registry.slots.map((slot) => ({ id: slot.id, projectName: slot.projectName, listed: this.listedPlaceIds(slot) }));
	}

	/*
		The project an open place is synced with, else the one it is connecting to
		(a place whose plugin has not reported yet), else none. A place that is
		not open, or that no project answers for, is nobody's to take (spec 014).
	*/
	placeHolder(placeId: number): string | null {
		const open = this.studio.places().find((place) => !place.unsaved && place.placeId === placeId);
		if (!open) return null;
		if (open.syncedWith) return this.registry.slots.find((slot) => slot.projectName === open.syncedWith)?.id ?? null;
		return open.status === "connect" ? open.projectId : null;
	}

	/** The open Studio places for the panel, each with the projects that list it. */
	studioPlaces(): StudioPlaceView[] {
		const projects = this.requestProjects();
		return this.studio.places().map((place) => ({ ...place, listedBy: place.unsaved ? [] : listersOf(projects, place.placeId).map((project) => project.projectName) }));
	}

	/** The pending asks, for the panel and the notification. */
	requestViews(): PlaceRequestView[] {
		const names = new Map(this.registry.slots.map((slot) => [slot.id, slot.projectName]));
		const open = this.studio.places();
		return this.requests.pending().map((request) => {
			const holderId = this.placeHolder(request.placeId) ?? request.holderId;
			return {
				id: request.id,
				placeId: request.placeId,
				placeName: open.find((place) => place.placeId === request.placeId)?.placeName ?? this.places.listed([request.placeId])[0]?.placeName ?? null,
				askerId: request.askerId,
				asker: names.get(request.askerId) ?? request.askerId,
				holderId,
				holder: holderId ? (names.get(holderId) ?? null) : null,
				holderClaimed: holderId !== null && this.claimOf(holderId) !== null,
				since: request.since,
			};
		});
	}

	/** Looks up the names of every project's places for the panel, in the background, while opening places is on. */
	warmPlaceNames(): void {
		if (!this.openPlacesOn) return;
		this.places.warm(this.registry.slots.flatMap((slot) => this.listedPlaceIds(slot)));
	}

	/** A place of the slot's, checked against its project file; the project's gameId comes along as its universe. */
	private placeOf(id: string, placeId: number): { placeId: number; gameId: number | null } {
		const slot = this.registry.get(id);
		const listed = this.listedPlaceIds(slot);
		if (!listed.includes(placeId)) {
			throw new Conflict(`Place ${placeId} is not one of ${slot.projectName}'s places. Its project file names ${listed.length ? listed.join(", ") : "none"} (servePlaceIds, placeId).`);
		}
		return { placeId, gameId: this.placeFieldsOf(slot).gameId };
	}

	/** Opens one of the slot's places in Studio, unless it is open already (spec 009). */
	openPlace(id: string, placeId: number): Promise<PlaceOpened> {
		const place = this.placeOf(id, placeId);
		return this.places.open(place.placeId, place.gameId);
	}

	/** Opens every one of the slot's places that is not open; one failing does not stop the others. */
	async openAllPlaces(id: string): Promise<(PlaceOpened | { placeId: number; error: string })[]> {
		const slot = this.registry.get(id);
		if (!this.openPlacesOn) throw new Conflict(OFF_MESSAGE);
		const gameId = this.placeFieldsOf(slot).gameId;
		const results: (PlaceOpened | { placeId: number; error: string })[] = [];
		for (const placeId of this.listedPlaceIds(slot)) {
			results.push(await this.places.open(placeId, gameId).catch((error: unknown) => ({ placeId, error: error instanceof Error ? error.message : String(error) })));
		}
		return results;
	}

	closePlace(id: string, placeId: number): Promise<void> {
		return this.places.close(this.placeOf(id, placeId).placeId);
	}

	reopenPlace(id: string, placeId: number): Promise<void> {
		const place = this.placeOf(id, placeId);
		return this.places.reopen(place.placeId, place.gameId);
	}

	/*
		What the Studio plugin's place matching needs about every project. The
		place fields come from the primary checkout's project file, the one the
		slot file copies them from (see SESSION_FIELDS in project.ts).
	*/
	placeCandidates(): PlaceCandidate[] {
		return this.registry.slots.map((slot) => {
			const runtime = this.runtime(slot.id);
			return {
				slotId: slot.id,
				projectName: slot.projectName,
				port: slot.port,
				state: runtime.state,
				sessionId: runtime.sessionId,
				branch: runtime.branch,
				targetLabel: runtime.targetLabel,
				rojoVersion: runtime.rojoVersion,
				restarting: runtime.restarting,
				...this.placeFieldsOf(slot),
			};
		});
	}

	private placeFieldsOf(slot: SlotRecord): PlaceFields {
		const file = join(slot.repoPath, slot.projectFile);
		const cached = this.placeFields.get(file);
		let mtime: number;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			return cached?.fields ?? { servePlaceIds: null, blockedPlaceIds: null, placeId: null, gameId: null };
		}
		if (cached && cached.mtime === mtime) return cached.fields;
		const ids = (value: unknown): number[] | null => (Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : null);
		try {
			const project = readProject(file);
			const fields = {
				servePlaceIds: ids(project.servePlaceIds),
				blockedPlaceIds: ids(project.blockedPlaceIds),
				placeId: Number.isInteger(project.placeId) ? (project.placeId as number) : null,
				gameId: Number.isInteger(project.gameId) && (project.gameId as number) > 0 ? (project.gameId as number) : null,
			};
			this.placeFields.set(file, { mtime, fields });
			return fields;
		} catch {
			// Mid-edit (half-typed JSON): keep what was read last, like servePort (see portRequests).
			return cached?.fields ?? { servePlaceIds: null, blockedPlaceIds: null, placeId: null, gameId: null };
		}
	}

	/** Nothing serving and nothing meant to be (see IDLE_EXIT_MS in main.ts). */
	idle(): boolean {
		return this.registry.slots.every((slot) => !slot.wantRunning && this.runtime(slot.id).state === "stopped");
	}

	list(): SlotView[] {
		this.refreshPorts();
		return this.snapshot();
	}

	/** Every slot's view as it stands, without re-reading ports (they are re-read every few seconds anyway); for GET /events. */
	snapshot(): SlotView[] {
		this.warmPlaceNames();
		return this.registry.slots.map((slot) => this.view(slot));
	}

	/*
		Registers the repo containing `path`. The project name must be unique
		across slots, because the Studio plugin auto-connects a place only to a
		server reporting the name it saved. Without a `projectFile`, the folder's
		default.project.json, or its only *.project.json (spec 005).
	*/
	add(path: string, projectFile?: string): Promise<SlotView> {
		// Two adds at once (two windows, a double click) must not both pass the checks below before either is saved.
		const run = () => this.addLocked(path, projectFile);
		const next = this.adding.then(run, run);
		this.adding = next.catch(() => undefined);
		return next;
	}

	private async addLocked(path: string, projectFile?: string): Promise<SlotView> {
		const problem = await gitProblem();
		if (problem) throw new Conflict(problem);
		const repoPath = await primaryCheckout(resolve(path));
		if (projectFile === undefined) {
			const files = listProjectFiles(repoPath);
			const chosen = defaultProjectFile(files);
			if (!chosen) {
				throw files.length === 0
					? new NotFound(`${repoPath} has no ${DEFAULT_PROJECT_FILE} or other *.project.json`)
					: new Conflict(`${repoPath} has several project files (${files.join(", ")}); say which one`);
			}
			projectFile = chosen;
		}
		if (!isProjectFileName(projectFile)) throw new Conflict(`${projectFile} is not a *.project.json file name`);
		if (this.registry.slots.some((slot) => pathKey(slot.repoPath) === pathKey(repoPath) && slot.projectFile === projectFile)) {
			throw new Conflict(`${repoPath} is already registered`);
		}
		const name = this.nameIn(repoPath, projectFile, null);
		let id = slugify(name);
		while (this.registry.slots.some((slot) => slot.id === id)) id += "-2";
		const slot: SlotRecord = {
			id,
			projectName: name,
			repoPath,
			projectFile,
			seed: await repoSeed(repoPath, name),
			port: 0,
			target: { kind: "worktree", path: repoPath },
			wantRunning: false,
			activeView: null,
		};
		this.registry.slots.push(slot);
		this.refreshPorts();
		const assigned = this.assignments.get(slot.id);
		if (!assigned?.port) {
			this.registry.slots.pop();
			throw new Conflict(assigned?.error ?? "No port could be assigned");
		}
		this.registry.save();
		this.trackRepos();
		await this.describeTarget(slot);
		return this.view(slot);
	}

	/*
		The `name` in a project file, which must be unique across slots other than
		`except` (see add).
	*/
	private nameIn(repoPath: string, projectFile: string, except: string | null): string {
		const file = join(repoPath, projectFile);
		if (!existsSync(file)) throw new NotFound(`${repoPath} has no ${projectFile}`);
		const name = readProject(file).name;
		if (typeof name !== "string" || name.length === 0) throw new Conflict(`${file} has no "name"`);
		const clash = this.registry.slots.find((slot) => slot.id !== except && slot.projectName === name);
		if (clash) {
			throw new Conflict(`Another project (${clash.repoPath}) is already named "${name}". Studio auto-connects by name, so names must be unique.`);
		}
		return name;
	}

	/*
		Changes which project file a slot serves (spec 005). Rojo reads the name,
		servePort and place IDs once per session, so a serving slot is stopped and
		started again on the new file: a new session, which Studio reconnects to.
		The extension asks before doing that. A stopped slot only records it.
	*/
	setProjectFile(id: string, projectFile: string): Promise<SlotView> {
		const slot = this.registry.get(id);
		if (!isProjectFileName(projectFile)) throw new Conflict(`${projectFile} is not a *.project.json file name`);
		return this.enqueue(slot, async () => {
			if (slot.projectFile === projectFile) return this.view(slot);
			if (this.registry.slots.some((other) => other.id !== id && pathKey(other.repoPath) === pathKey(slot.repoPath) && other.projectFile === projectFile)) {
				throw new Conflict(`Another project already serves ${projectFile} from ${slot.repoPath}`);
			}
			const name = this.nameIn(slot.repoPath, projectFile, id);
			const runtime = this.runtime(id);
			const serving = runtime.state !== "stopped";
			if (serving) await this.stopLocked(slot);
			slot.projectFile = projectFile;
			slot.projectName = name;
			// A servePort in the new file (or gone from the old one) moves the port; take it now, not in a queued move.
			this.refreshPorts();
			const assigned = this.assignments.get(id);
			if (assigned?.port) slot.port = assigned.port;
			this.registry.save();
			runtime.notes = [];
			runtime.error = null;
			if (serving && slot.wantRunning) await this.startLocked(slot);
			return this.view(slot);
		});
	}

	remove(id: string): Promise<void> {
		const slot = this.registry.get(id);
		return this.enqueue(slot, async () => {
			await this.stopLocked(slot);
			slot.activeView = null;
			await this.collectViews(slot);
			rmSync(this.slotDir(id), { recursive: true, force: true });
			this.registry.slots = this.registry.slots.filter((entry) => entry.id !== id);
			for (const group of this.registry.groups) group.slotIds = group.slotIds.filter((member) => member !== id);
			for (const [place, chosen] of Object.entries(this.registry.placeChoices)) if (chosen === id) delete this.registry.placeChoices[place];
			// A project added again later with the same name asks each place's first sync again.
			for (const [place, names] of Object.entries(this.registry.placeAccepted)) {
				this.registry.placeAccepted[place] = names.filter((name) => name !== slot.projectName);
				if (this.registry.placeAccepted[place].length === 0) delete this.registry.placeAccepted[place];
			}
			this.registry.save();
			this.runtimes.delete(id);
			this.claims.delete(id);
			this.servePorts.delete(id);
			this.trackRepos();
			this.refreshPorts();
		});
	}

	targets(id: string): Promise<TargetOption[]> {
		return this.targetCache.get(this.registry.get(id).repoPath);
	}

	/** Fetches every remote of the slot's repo (pruning deleted branches), then reads the picker's list again. */
	async fetch(id: string): Promise<TargetOption[]> {
		const slot = this.registry.get(id);
		await git(slot.repoPath, ["fetch", "--all", "--prune"], { timeout: 120000 });
		await this.targetCache.refresh(slot.repoPath);
		return this.targetCache.get(slot.repoPath);
	}

	/*
		A new branch from `base` in a folder of its own, so it can be edited, and
		the slot switched to it: an Orca worktree when the repo is in Orca, else
		a git worktree beside the repo (<repo>-worktrees/<name>). Never a
		checkout in a folder rojo is serving (see prepareTree).
	*/
	async createBranch(id: string, name: string, base: string, options: { actor?: "panel" | "mcp"; setupWaitMs?: number } = {}): Promise<{ slot: SlotView; path: string; branch: string; via: "orca" | "git"; from: string; notes: string[]; switched: boolean; setupNotes: string[] }> {
		const slot = this.registry.get(id);
		// A broken setup entry is reported before anything is made.
		const configured = this.setupFor(slot.repoPath);
		if (configured && "problem" in configured) throw new Conflict(configured.problem);
		const clean = await checkBranchName(slot.repoPath, name.trim());
		if (await branchExists(slot.repoPath, clean)) throw new Conflict(`A branch named ${clean} already exists; pick it under Local branches.`);
		try {
			await git(slot.repoPath, ["rev-parse", "--verify", `${base}^{commit}`]);
		} catch {
			throw new NotFound(`${base} is not a branch or commit of ${basename(slot.repoPath)}`);
		}
		let path: string;
		let branch = clean;
		let via: "orca" | "git";
		let from = base;
		let notes: string[] = [];
		if (await inOrca(slot.repoPath)) {
			// Orca gets `base` as given: it does its own start-point handling and takes only a branch name.
			const made = await orcaCreateWorktree(slot.repoPath, clean, base);
			path = made.path;
			branch = made.branch ?? clean;
			via = "orca";
		} else {
			({ ref: from, notes } = await resolveBase(slot.repoPath, base));
			const parent = join(dirname(slot.repoPath), `${basename(slot.repoPath)}-worktrees`);
			path = join(parent, clean.replace(/[\\/]+/g, "-"));
			if (existsSync(path)) throw new Conflict(`${path} already exists`);
			mkdirSync(parent, { recursive: true });
			// --no-track: a branch started from a remote ref (origin/main) would otherwise track it, and a plain git push would aim at main.
			await git(slot.repoPath, ["worktree", "add", "--no-track", "-b", clean, path, from]);
			via = "git";
		}
		void this.targetCache.refresh(slot.repoPath).catch(() => undefined);
		/*
			Setup (spec 012) runs here: the worktree exists and no rojo has read it,
			so installs may delete and recreate Packages. Only a success switches; a
			failure keeps the worktree and the branch.
		*/
		const setupNotes: string[] = [];
		const setup = await this.setupWorktree(id, path, { actor: options.actor ?? "panel", branch, waitMs: options.setupWaitMs });
		if (setup) {
			if (!setup.outcome) {
				setupNotes.push(`Setup is still running in ${path} (command ${setup.job.step} of ${setup.job.of}: ${setup.job.text}).`);
				return { slot: this.view(slot), path, branch, via, from, notes, switched: false, setupNotes };
			}
			if (!setup.outcome.ok) throw new SetupFailed(setup.outcome);
			setupNotes.push(...describeSteps(setup.outcome).split("\n").filter(Boolean));
		}
		return { slot: await this.switch(id, { kind: "worktree", path }), path, branch, via, from, notes, switched: true, setupNotes };
	}

	/** Writes the served worktree's sourcemap.json once, on request, even where the watcher would not. */
	async writeSourcemap(id: string): Promise<{ path: string }> {
		const slot = this.registry.get(id);
		if (slot.target.kind !== "worktree") throw new Conflict("This project serves a branch from a Hub copy, which nothing edits, so it has no sourcemap. Switch it to a worktree first.");
		const tree = resolve(slot.target.path);
		const rojo = resolveRojo(slot.repoPath);
		if (!rojo.ok) throw new Conflict(rojo.error);
		await writeSourcemap(rojo.binary, tree, slot.projectFile);
		return { path: join(tree, "sourcemap.json") };
	}

	/*
		Builds a place file of exactly what the slot serves: its slot file, so a
		borrowed project file and Packages from the primary checkout match what
		Studio gets. A stopped slot has its files written first, as a start would.
	*/
	async build(id: string, output: string): Promise<{ output: string; bytes: number }> {
		const slot = this.registry.get(id);
		if (!isAbsolute(output) || !/\.rbxlx?$/i.test(output)) throw new Conflict("output must be an absolute path ending in .rbxl or .rbxlx");
		const rojo = resolveRojo(slot.repoPath);
		if (!rojo.ok) throw new Conflict(rojo.error);
		await this.enqueue(slot, async () => {
			if (this.runtime(id).state !== "running") this.writeFiles(slot, await this.prepareTree(slot, slot.target));
		});
		mkdirSync(dirname(output), { recursive: true });
		await buildPlace(rojo.binary, this.slotFile(slot.id), output, slot.repoPath);
		return { output, bytes: statSync(output).size };
	}

	start(id: string): Promise<SlotView> {
		const slot = this.registry.get(id);
		return this.enqueue(slot, async () => {
			this.runtime(id).notes = [];
			await this.startLocked(slot);
			return this.view(slot);
		});
	}

	stop(id: string): Promise<SlotView> {
		const slot = this.registry.get(id);
		return this.enqueue(slot, async () => {
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
		const setting = target.kind === "worktree" ? this.setupJobs.running(target.path) : null;
		if (setting) return Promise.reject(new Conflict(`Setup is still running in ${setting.path} (command ${setting.step} of ${setting.of}); call ensure from that worktree to wait for it.`));
		return this.enqueue(slot, () => this.switchLocked(slot, target));
	}

	/** switch() inside the slot's queue. */
	private async switchLocked(slot: SlotRecord, target: Target): Promise<SlotView> {
		const runtime = this.runtime(slot.id);
		const tree = await this.prepareTree(slot, target);
		const plan = this.writeFiles(slot, tree);
		// The label from the picker's list, so no status is sent with the new target under the old branch's name.
		const known = this.targetCache.peek(slot.repoPath)?.find((option) => sameTarget(option.target, target));
		if (known) {
			runtime.targetLabel = known.label;
			runtime.branch = known.branch;
		} else if (target.kind === "branch") {
			runtime.branch = runtime.targetLabel = target.ref.replace(/^refs\/(heads|remotes)\//, "");
		}
		// The same folder again (serve_here from where the checkout happened) keeps the note about that checkout.
		const changed = !sameTarget(slot.target, target);
		slot.target = target;
		if (target.kind === "worktree" && (runtime.state === "running" || runtime.state === "starting")) runtime.served.add(pathKey(target.path));
		if (target.kind === "worktree") this.saveServed(slot.id, runtime);
		this.registry.save();
		runtime.mode = plan.mode;
		runtime.warnings = plan.warnings;
		if (changed) runtime.notes = [];
		runtime.error = null;
		runtime.log.poll();
		runtime.log.takeProblems();
		this.watchBorrowed(slot, tree);
		this.trackHead(slot);
		await this.describeTarget(slot);
		await this.syncSourcemap(slot);
		if (runtime.state !== "running") await this.collectViews(slot);
		return this.view(slot);
	}

	async shutdown(stopServing: boolean): Promise<void> {
		if (this.poller) clearInterval(this.poller);
		this.targetCache.dispose();
		for (const slot of this.registry.slots) {
			const runtime = this.runtime(slot.id);
			runtime.watcher?.close();
			// Sourcemap watchers are the service's own children; a service that takes over starts them again.
			runtime.sourcemap?.stop();
			runtime.sourcemap = null;
			// Through the slot's queue, so a start already under way finishes first and its rojo is stopped too.
			if (stopServing) await this.enqueue(slot, () => this.stopLocked(slot)).catch(() => undefined);
		}
	}

	private async startLocked(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		runtime.state = "starting";
		runtime.error = null;
		try {
			const assigned = this.assignments.get(slot.id);
			if (assigned?.error) throw new Conflict(assigned.error);
			// Checked first: a missing Rojo is the commonest reason a start fails, and says so without waiting on anything.
			const rojo = resolveRojo(slot.repoPath);
			if (!rojo.ok) throw new Conflict(rojo.error);
			const tree = await this.prepareTree(slot, slot.target);
			const plan = this.writeFiles(slot, tree);
			runtime.mode = plan.mode;
			runtime.warnings = plan.warnings;
			// A new rojo has read only what it starts on.
			const starting = slot.target;
			runtime.served = new Set(starting.kind === "worktree" ? [pathKey(starting.path)] : []);
			runtime.servedUnknown = false;
			this.saveServed(slot.id, runtime);
			await stopRojo(this.slotFile(slot.id));
			await this.waitForPortFree(slot.port);
			await this.collectViews(slot);
			if (existsSync(this.logFile(slot.id))) renameSync(this.logFile(slot.id), this.logFile(slot.id).replace(/\.log$/, ".previous.log"));
			runtime.log = new LogFollower(this.logFile(slot.id));
			runtime.toolWarnings = [];
			if (olderThan77(rojo.version)) {
				runtime.toolWarnings = [
					`Serving with Rojo ${rojo.version} (pinned in ${rojo.manifest}), which speaks Rojo protocol 4. The Rojo 7.7 Studio plugin only connects to Rojo 7.7 (protocol 5) and will refuse this server; pin rojo-rbx/rojo@7.7.0 to use it. The Studio-connected light also needs Rojo 7.7.`,
				];
			}
			runtime.rojoVersion = rojo.version;
			runtime.rojo = await startRojo(rojo.binary, this.slotFile(slot.id), slot.port, slot.repoPath, this.logFile(slot.id));
			runtime.sessionId = await this.waitForRojo(slot);
			runtime.misses = 0;
			runtime.state = "running";
			slot.wantRunning = true;
			this.registry.save();
			this.watchBorrowed(slot, tree);
			this.trackHead(slot);
			runtime.log.poll();
			runtime.log.takeProblems();
			await this.describeTarget(slot);
			await this.syncSourcemap(slot);
		} catch (error) {
			runtime.state = "error";
			runtime.error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			runtime.restarting = false;
		}
	}

	private async stopLocked(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		runtime.watcher?.close();
		runtime.watcher = null;
		runtime.state = "stopped";
		runtime.sessionId = null;
		runtime.error = null;
		runtime.served.clear();
		runtime.servedUnknown = false;
		this.saveServed(slot.id, runtime);
		await this.stopProcess(slot);
		await this.syncSourcemap(slot);
		await this.waitForPortFree(slot.port).catch(() => undefined);
		await this.collectViews(slot);
	}

	/*
		Stops the slot's rojo. One this service started and that is still running
		is killed by its id straight away; otherwise (adopted from an earlier
		service, or already gone) every rojo for the slot file is looked up by
		command line, which takes PowerShell about half a second.
	*/
	private async stopProcess(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		const own = runtime.rojo;
		runtime.rojo = null;
		if (own?.alive()) kill(own.pid);
		else await stopRojo(this.slotFile(slot.id));
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
				: `Port ${port} is held by another program. Add it to rojoHub.excludedPorts in VS Code's settings and this project moves to the next free port.`,
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
			if (!runtime.rojo?.alive()) break;
			await new Promise((done) => setTimeout(done, 250));
		}
		await this.stopProcess(slot);
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
			// Long form: the tree's paths go into the slot and borrowed files Rojo watches (see verbatim).
			return longPath(target.path);
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
		// NO_HOOKS: a view is Rojo-Hub's own copy, so the repo's post-checkout hook (husky and the like) is not run for it.
		await git(slot.repoPath, [...NO_HOOKS, "worktree", "add", "--detach", dir, commit]);
		slot.activeView = name;
		return dir;
	}

	private isViewOf(slot: SlotRecord, path: string): boolean {
		return this.viewRoots.some((root) => pathKey(path).startsWith(`${root}/${slot.id.toLowerCase()}/`));
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
		const watcher = watch(source, () => {
			void this.enqueue(slot, async () => {
				if (!sameTarget(slot.target, watched) || runtime.state !== "running") return;
				try {
					const plan = this.writeFiles(slot, tree);
					runtime.mode = plan.mode;
					runtime.warnings = plan.warnings;
					if (plan.mode === "native") this.watchBorrowed(slot, tree);
				} catch (error) {
					runtime.error = error instanceof Error ? error.message : String(error);
				}
			}).catch(() => undefined);
		});
		// Deleting the served worktree makes Windows report EPERM on this watch; without a listener that would end the service.
		watcher.on("error", () => {
			watcher.close();
			if (runtime.watcher === watcher) runtime.watcher = null;
		});
		runtime.watcher = watcher;
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
		// Only the Hub's own views: a repo-wide `git worktree prune` would also drop the user's worktrees on a drive that is not plugged in.
		await pruneMissingWorktreesUnder(slot.repoPath, root).catch(() => undefined);
	}

	/*
		Starts, moves or stops the slot's sourcemap watcher to match what it
		serves (spec 003): only while serving a worktree in place, only where
		sourcemap.json is gitignored or already there, and not when
		rojoHub.sourcemaps is off. Otherwise it records why not.
	*/
	private async syncSourcemap(slot: SlotRecord): Promise<void> {
		const runtime = this.runtime(slot.id);
		const off = (detail: string) => {
			runtime.sourcemap?.stop();
			runtime.sourcemap = null;
			runtime.sourcemapOff = detail;
		};
		const tree = slot.target.kind === "worktree" ? resolve(slot.target.path) : null;
		if (loadPortSettings(this.home).sourcemaps === false) return off("Turned off (rojoHub.sourcemaps)");
		if (runtime.state !== "running") return off("Kept up to date while the project is serving");
		if (!tree) return off("Not kept for a branch served from a Hub copy, which nothing edits");
		if (!existsSync(join(tree, slot.projectFile))) return off(`${basename(tree)} has no ${slot.projectFile}`);
		if (!(await mayWrite(tree))) return off(`Not kept: sourcemap.json is not gitignored in ${basename(tree)}, so it would show up in git`);
		if (runtime.sourcemap && pathKey(runtime.sourcemap.tree) === pathKey(tree)) return;
		runtime.sourcemap?.stop();
		runtime.sourcemap = null;
		const rojo = resolveRojo(slot.repoPath);
		if (!rojo.ok) return off(rojo.error);
		await stopStrayWatchers(tree);
		if (runtime.state !== "running" || runtime.sourcemap) return;
		runtime.sourcemap = new SourcemapWatcher(rojo.binary, tree, slot.projectFile);
	}

	private trackHead(slot: SlotRecord): void {
		const runtime = this.runtime(slot.id);
		runtime.headFile = slot.target.kind === "worktree" ? headFile(slot.target.path) : null;
		runtime.head = runtime.headFile ? readHead(runtime.headFile) : null;
	}

	/*
		A checkout made in the served worktree (in a terminal, Source Control,
		Orca) changes what Studio gets, and when it removes a folder Rojo 7.7
		crashes. The Hub cannot stop it, so it says what happened.
	*/
	private checkHead(slot: SlotRecord): void {
		const runtime = this.runtime(slot.id);
		if (!runtime.headFile || slot.target.kind !== "worktree") return;
		const now = readHead(runtime.headFile);
		if (!now || now === runtime.head) return;
		const before = runtime.head;
		runtime.head = now;
		runtime.checkout = { branch: now, at: Date.now() };
		runtime.notes = [
			`${now} was checked out in ${basename(slot.target.path)} while it was being served${before ? ` (it was on ${before})` : ""}, so Studio now gets ${now}. Agents: never check out in a served folder; use new_branch. Users: pick the branch in Rojo-Hub's picker, which switches without touching the folder.`,
		];
		void this.describeTarget(slot);
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
