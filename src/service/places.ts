import { execFile, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ListedPlace, PlaceOpened } from "../common/api";
import { Conflict } from "./registry";

/*
	Opening a project's Studio places from VS Code and from agents (spec 009).
	Off unless rojoHub.openPlaces is on. A place is opened through the link the
	website's Edit in Studio uses, which needs the place's universe ID (M1),
	looked up once and kept. A place already open is never opened again: Studio
	would open a second copy (M4). Closing asks the window to close, as its X
	does, so Studio still asks about unsaved work; nothing is ever killed.
*/

export const OFF_MESSAGE = "Opening Studio places is turned off in Rojo-Hub's settings (rojoHub.openPlaces). The user can turn it on in VS Code.";

/** How long a launched place counts as opening, until its plugin reports it. */
const OPENING_MS = 2 * 60 * 1000;
/** How long Reopen waits for Studio to close (the user may be answering its save prompt). */
export const REOPEN_WAIT_MS = 5 * 60 * 1000;
/** How long a close is shown as closing, until the place is gone. */
const CLOSING_MS = REOPEN_WAIT_MS;

export function placeLink(placeId: number, universeId: number): string {
	return `roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${placeId}+universeId:${universeId}`;
}

/** A running Studio and the place its command line names, if any (M5). */
export interface StudioProcess {
	pid: number;
	placeId: number | null;
}

/** The place ID in a Studio command line: the link's placeId:N, or -placeId N. */
export function placeInCommandLine(commandLine: string): number | null {
	const found = /placeId[:=\s]+(\d+)/i.exec(commandLine);
	return found ? Number(found[1]) : null;
}

/** What Places needs from the machine and from Roblox; replaced in tests, which never open Studio. */
export interface PlaceSystem {
	lookup(placeId: number): Promise<{ universeId: number; name: string | null }>;
	launch(link: string): void;
	processes(): Promise<StudioProcess[]>;
	/** Asks a Studio window to close, as its X does. False when it has no window to ask. */
	close(pid: number): Promise<boolean>;
	alive(pid: number): boolean;
}

function powershell(script: string, timeout = 20000): Promise<string> {
	return new Promise((done, fail) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout }, (error, stdout) => (error ? fail(error) : done(stdout)));
	});
}

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
	return response.json();
}

export const windowsSystem: PlaceSystem = {
	async lookup(placeId) {
		let universeId: unknown;
		try {
			universeId = ((await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)) as { universeId?: unknown }).universeId;
		} catch (error) {
			const reason = error instanceof Error ? (error.name === "TimeoutError" ? "the request timed out" : error.message) : String(error);
			throw new Error(`Could not look up the universe of place ${placeId}: ${reason}. Try again.`);
		}
		if (typeof universeId !== "number" || !universeId) throw new Error(`Roblox knows no universe for place ${placeId}; check the place ID in the project file.`);
		// The name is only for the panel; a place opens without it (M7).
		const name = await getJson(`https://economy.roblox.com/v2/assets/${placeId}/details`)
			.then((details) => (typeof (details as { Name?: unknown }).Name === "string" ? (details as { Name: string }).Name : null))
			.catch(() => null);
		return { universeId, name };
	},
	launch(link) {
		// explorer.exe hands the link to Studio's handler with no console window (M3); it exits 1 even when it worked.
		const child = spawn("explorer.exe", [link], { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => undefined);
		child.unref();
	},
	async processes() {
		const out = await powershell(`Get-CimInstance Win32_Process -Filter "Name='RobloxStudioBeta.exe'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`);
		return out
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => {
				const [pid, ...rest] = line.split("\t");
				return { pid: Number(pid), placeId: placeInCommandLine(rest.join("\t")) };
			})
			.filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
	},
	async close(pid) {
		const out = await powershell(`$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() } else { $false }`);
		return /true/i.test(out);
	},
	alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	},
};

interface Known {
	universeId: number;
	name: string | null;
}

type Busy = { kind: "opening" | "closing" | "reopening"; since: number };

export class Places {
	/** Universe IDs (and names) by place ID, kept in universes.json: a cache, safe to delete. */
	private known: Record<string, Known> = {};
	private readonly busy = new Map<number, Busy>();
	/** The last thing that went wrong per place, for the panel, until the next try. */
	private readonly errors = new Map<number, string>();
	/** Serializes what is done to one place, so two opens at once open it once. */
	private readonly queues = new Map<number, Promise<unknown>>();
	/** Places whose name lookup was already tried this service life. */
	private readonly warmed = new Set<number>();

	constructor(
		private readonly home: string,
		/** rojoHub.openPlaces. */
		private readonly enabled: () => boolean,
		/** The places whose Rojo-Hub plugin reports them open, with the name it reports. */
		private readonly reported: () => { placeId: number; placeName: string }[],
		private readonly system: PlaceSystem = windowsSystem,
		public log: (message: string) => void = () => undefined,
	) {
		try {
			this.known = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Known>;
		} catch {
			this.known = {};
		}
	}

	private get file(): string {
		return join(this.home, "universes.json");
	}

	private save(): void {
		try {
			writeFileSync(this.file + ".tmp", JSON.stringify(this.known, null, "\t") + "\n");
			renameSync(this.file + ".tmp", this.file);
		} catch {
			// A cache: the next open looks it up again.
		}
	}

	private check(): void {
		if (!this.enabled()) throw new Conflict(OFF_MESSAGE);
	}

	private serial<T>(placeId: number, work: () => Promise<T>): Promise<T> {
		const next = (this.queues.get(placeId) ?? Promise.resolve()).then(work, work);
		const tail = next.catch(() => undefined);
		this.queues.set(placeId, tail);
		void tail.then(() => {
			if (this.queues.get(placeId) === tail) this.queues.delete(placeId);
		});
		return next;
	}

	private reportedName(placeId: number): string | null {
		return this.reported().find((place) => place.placeId === placeId)?.placeName ?? null;
	}

	/** The name to show: what the plugin reports, else the lookup's, else null (the panel shows the ID). */
	name(placeId: number): string | null {
		return this.reportedName(placeId) ?? this.known[String(placeId)]?.name ?? null;
	}

	private label(placeId: number): string {
		const name = this.name(placeId);
		return name ? `${name} (place ${placeId})` : `place ${placeId}`;
	}

	private currentBusy(placeId: number): Busy | null {
		const busy = this.busy.get(placeId);
		if (!busy) return null;
		const open = this.reportedName(placeId) !== null;
		const over = busy.kind === "opening" ? open || Date.now() - busy.since > OPENING_MS : busy.kind === "closing" ? !open && Date.now() - busy.since > 3000 : false;
		if (over || Date.now() - busy.since > CLOSING_MS + OPENING_MS) {
			this.busy.delete(placeId);
			return null;
		}
		return busy;
	}

	/** A project's places for its card. */
	listed(placeIds: number[]): ListedPlace[] {
		return placeIds.map((placeId) => ({
			placeId,
			placeName: this.name(placeId),
			open: this.reportedName(placeId) !== null,
			busy: this.currentBusy(placeId)?.kind ?? null,
			error: this.errors.get(placeId) ?? null,
		}));
	}

	/** Looks up names for the panel in the background, once per place per service life, only while the feature is on. */
	warm(placeIds: number[]): void {
		if (!this.enabled()) return;
		for (const placeId of placeIds) {
			if (this.warmed.has(placeId) || this.known[String(placeId)]) continue;
			this.warmed.add(placeId);
			void this.universe(placeId, null).catch(() => undefined);
		}
	}

	private async universe(placeId: number, gameId: number | null): Promise<number> {
		if (gameId) return gameId;
		const saved = this.known[String(placeId)];
		if (saved) return saved.universeId;
		const found = await this.system.lookup(placeId);
		this.known[String(placeId)] = found;
		this.save();
		return found.universeId;
	}

	/** Whether the place is open: its plugin reports it, or a Studio's command line names it (M5). */
	private async openNow(placeId: number): Promise<"plugin" | "process" | null> {
		if (this.reportedName(placeId) !== null) return "plugin";
		const processes = await this.system.processes().catch(() => []);
		return processes.some((entry) => entry.placeId === placeId) ? "process" : null;
	}

	/** Opens a place in Studio unless it is open already. `gameId`: the project file's, when it sets one. */
	async open(placeId: number, gameId: number | null = null): Promise<PlaceOpened> {
		this.check();
		return this.serial(placeId, async () => {
			this.errors.delete(placeId);
			if (await this.openNow(placeId)) return { placeId, placeName: this.name(placeId), outcome: "already-open" as const };
			try {
				const universeId = await this.universe(placeId, gameId);
				this.system.launch(placeLink(placeId, universeId));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.errors.set(placeId, message);
				throw new Conflict(message);
			}
			this.busy.set(placeId, { kind: "opening", since: Date.now() });
			this.log(`places: opened ${this.label(placeId)} in Studio`);
			return { placeId, placeName: this.name(placeId), outcome: "opened" as const };
		});
	}

	/** The Studio processes whose command line names the place; refused when there are none. */
	private async processesOf(placeId: number): Promise<StudioProcess[]> {
		const mine = (await this.system.processes()).filter((entry) => entry.placeId === placeId);
		if (mine.length > 0) return mine;
		throw new Conflict(
			this.reportedName(placeId) !== null
				? `${this.label(placeId)} was not opened by Rojo-Hub or the website, so Rojo-Hub cannot tell which Studio window it is. Close it in Studio.`
				: `${this.label(placeId)} is not open.`,
		);
	}

	private async askToClose(placeId: number, processes: StudioProcess[]): Promise<void> {
		const asked = await Promise.all(processes.map((entry) => this.system.close(entry.pid).catch(() => false)));
		if (!asked.some(Boolean)) throw new Conflict(`Studio did not take the request to close ${this.label(placeId)}; close it in Studio.`);
	}

	/** Asks the place's Studio to close; Studio may ask about unsaved changes first. Never kills it. */
	async close(placeId: number): Promise<void> {
		this.check();
		return this.serial(placeId, async () => {
			this.errors.delete(placeId);
			await this.askToClose(placeId, await this.processesOf(placeId));
			this.busy.set(placeId, { kind: "closing", since: Date.now() });
			this.log(`places: asked Studio to close ${this.label(placeId)}`);
		});
	}

	/*
		Closes the place, waits for its Studio to exit, then opens it again: how an
		open place picks up a new plugin. Returns once the close was asked for; the
		rest goes on in the background, shown on the card.
	*/
	async reopen(placeId: number, gameId: number | null = null, waitMs = REOPEN_WAIT_MS): Promise<void> {
		this.check();
		const processes = await this.serial(placeId, async () => {
			this.errors.delete(placeId);
			const found = await this.processesOf(placeId);
			await this.askToClose(placeId, found);
			this.busy.set(placeId, { kind: "reopening", since: Date.now() });
			this.log(`places: reopening ${this.label(placeId)}`);
			return found;
		});
		void (async () => {
			const deadline = Date.now() + waitMs;
			while (processes.some((entry) => this.system.alive(entry.pid))) {
				if (Date.now() >= deadline) {
					this.busy.delete(placeId);
					this.errors.set(placeId, `${this.label(placeId)} did not close within ${Math.round(waitMs / 60000)} minutes, so it was not reopened.`);
					return;
				}
				await new Promise((done) => setTimeout(done, 500));
			}
			this.busy.delete(placeId);
			await this.open(placeId, gameId).catch((error) => this.errors.set(placeId, error instanceof Error ? error.message : String(error)));
		})();
	}
}
