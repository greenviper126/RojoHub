/*
	Place requests (spec 014). A Studio place syncs with one project at a time
	(spec 007), so when two projects list the same place, the one that does not
	hold it can ask for it: the user is asked in VS Code, and Move saves the same
	assignment the panel makes. An agent never takes a place by itself, except
	under yolo from a project no other agent has claimed.

	Requests live in memory only. A restart drops them and an agent asks again.
	What this file decides is kept apart from the hub (it is handed what it needs)
	so the lifecycle is tested without a service.
*/

/** How long an answer (moved, declined) is remembered for the asking agent's next status or wait. */
export const OUTCOME_MS = 15 * 60 * 1000;

export interface RequestProject {
	id: string;
	projectName: string;
	/** The places its project file names (servePlaceIds, placeId; never a blocked one). */
	listed: number[];
}

export interface RequestDeps {
	projects(): RequestProject[];
	/** The project an open place is synced with (or is connecting to), null when no project holds it. */
	holderOf(placeId: number): string | null;
	/** The project picked for the place in VS Code. */
	assigned(placeId: number): string | null;
	/** Saves the assignment, like the panel's dropdown (PlaceMemory.assign). */
	assign(placeId: number, slotId: string): void;
	/** The key of the claim an agent holds on the project, null when it has none. */
	claimKeyOf(slotId: string): string | null;
	now?: () => number;
}

export interface PlaceRequest {
	id: string;
	placeId: number;
	askerId: string;
	/** The asking agent's claim: the request ends when it lapses or changes hands. */
	askerKey: string;
	/** The project that held the place when it was last seen; the request ends if that project is removed. */
	holderId: string | null;
	since: number;
}

export type RequestOutcome = "moved" | "declined";

export type AskResult =
	| { kind: "already" }
	| { kind: "assigned" }
	| { kind: "moved"; from: string }
	| { kind: "pending"; request: PlaceRequest; fresh: boolean };

/** The projects, of those given, that list the place. */
export function listersOf(projects: RequestProject[], placeId: number): RequestProject[] {
	return projects.filter((project) => project.listed.includes(placeId));
}

export const requestId = (askerId: string, placeId: number): string => `${askerId}:${placeId}`;

export class PlaceRequests {
	private readonly requests = new Map<string, PlaceRequest>();
	private readonly outcomes = new Map<string, { outcome: RequestOutcome; at: number }>();

	constructor(private readonly deps: RequestDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/*
		Drops what no longer stands: the asker or the holder was removed, the asker
		stopped listing the place or lost its claim, or the place now syncs with
		the asker (or was assigned to it, in the panel) so there is nothing left
		to ask. Run before every read, so nothing stale is ever shown.
	*/
	private prune(): void {
		const projects = this.deps.projects();
		for (const [id, request] of [...this.requests]) {
			const asker = projects.find((project) => project.id === request.askerId);
			if (!asker || !asker.listed.includes(request.placeId)) {
				this.requests.delete(id);
				continue;
			}
			if (this.deps.claimKeyOf(request.askerId) !== request.askerKey) {
				this.requests.delete(id);
				continue;
			}
			if (request.holderId && !projects.some((project) => project.id === request.holderId)) {
				this.requests.delete(id);
				continue;
			}
			const holder = this.deps.holderOf(request.placeId);
			if (holder === request.askerId || this.deps.assigned(request.placeId) === request.askerId) {
				this.requests.delete(id);
				this.outcomes.set(id, { outcome: "moved", at: this.now() });
				continue;
			}
			if (holder) request.holderId = holder;
		}
		for (const [id, kept] of [...this.outcomes]) if (this.now() - kept.at > OUTCOME_MS) this.outcomes.delete(id);
	}

	/*
		An agent's ask for a place its project lists, from the asker's claim `askerKey`.
		The caller has checked that the claim is the asker's and that the place is
		listed.
	*/
	ask(askerId: string, placeId: number, askerKey: string, yolo: boolean): AskResult {
		this.prune();
		const id = requestId(askerId, placeId);
		const holder = this.deps.holderOf(placeId);
		if (holder === askerId) {
			this.requests.delete(id);
			return { kind: "already" };
		}
		this.outcomes.delete(id);
		// Already assigned to the asker (in the panel): it reconnects within a tick, and there is nobody to ask.
		if (!holder || this.deps.assigned(placeId) === askerId) {
			this.requests.delete(id);
			this.deps.assign(placeId, askerId);
			return { kind: "assigned" };
		}
		if (yolo && this.deps.claimKeyOf(holder) === null) {
			this.requests.delete(id);
			this.deps.assign(placeId, askerId);
			return { kind: "moved", from: holder };
		}
		const existing = this.requests.get(id);
		if (existing) {
			// A repeat call refreshes the request: the same one, so the user is not asked twice.
			existing.askerKey = askerKey;
			existing.holderId = holder;
			return { kind: "pending", request: existing, fresh: false };
		}
		const request: PlaceRequest = { id, placeId, askerId, askerKey, holderId: holder, since: this.now() };
		this.requests.set(id, request);
		return { kind: "pending", request, fresh: true };
	}

	/** Every pending request. */
	pending(): PlaceRequest[] {
		this.prune();
		return [...this.requests.values()];
	}

	/** The pending request of a project for a place, if it has one. */
	pendingFor(askerId: string, placeId: number): PlaceRequest | null {
		this.prune();
		return this.requests.get(requestId(askerId, placeId)) ?? null;
	}

	/** Requests from other projects for places `holderId` holds. */
	against(holderId: string): PlaceRequest[] {
		return this.pending().filter((request) => request.holderId === holderId);
	}

	/** How the asker's last request ended, until it asks again or releases. */
	outcomeFor(askerId: string, placeId: number): RequestOutcome | null {
		this.prune();
		return this.outcomes.get(requestId(askerId, placeId))?.outcome ?? null;
	}

	/*
		The user's answer. Move saves the assignment; both end the request. Returns
		null when there is no such request any more (answered in another window,
		or it ended meanwhile).
	*/
	answer(id: string, answer: "move" | "decline"): PlaceRequest | null {
		this.prune();
		const request = this.requests.get(id);
		if (!request) return null;
		this.requests.delete(id);
		if (answer === "move") this.deps.assign(request.placeId, request.askerId);
		this.outcomes.set(id, { outcome: answer === "move" ? "moved" : "declined", at: this.now() });
		return request;
	}

	/** The asker let go of its project (release): its requests and remembered answers end. */
	dropAsker(askerId: string): void {
		for (const [id, request] of [...this.requests]) if (request.askerId === askerId) this.requests.delete(id);
		for (const id of [...this.outcomes.keys()]) if (id.startsWith(`${askerId}:`)) this.outcomes.delete(id);
	}
}
