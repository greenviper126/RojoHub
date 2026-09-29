import { randomUUID } from "node:crypto";

import {
	SERVICE_VERSION,
	STUDIO_PROTOCOL,
	type SlotState,
	type StudioHello,
	type StudioMatch,
	type StudioPlace,
	type StudioPlaceView,
	type StudioProject,
	type StudioToService,
} from "../common/api";
import type { WebSocketLink } from "./websocket";

/*
	Which project a Studio place syncs with, and the plugin sockets that ask
	(spec 007). Everything is decided here and in VS Code, never in Studio: a
	project assigned to the place in the panel, else the project files
	(servePlaceIds, then placeId), else the project the place last synced with.
	Only a serving project is connected to.
*/

/** What the matching needs to know about one registered project. */
export interface PlaceCandidate {
	slotId: string;
	projectName: string;
	port: number;
	state: SlotState;
	sessionId: string | null;
	branch: string | null;
	targetLabel: string;
	/** The rojo serving it, when known; older than 7.7 cannot be spoken to. */
	rojoVersion: string | null;
	servePlaceIds: number[] | null;
	blockedPlaceIds: number[] | null;
	placeId: number | null;
}

export type Place = Pick<StudioHello, "placeId" | "unsaved" | "remembered">;

type Reason = StudioProject["reason"];

const TIERS: { reason: Reason; claims: (project: PlaceCandidate, place: Place) => boolean }[] = [
	{ reason: "servePlaceIds", claims: (project, place) => project.servePlaceIds?.includes(place.placeId) ?? false },
	{ reason: "placeId", claims: (project, place) => project.placeId === place.placeId },
	{ reason: "remembered", claims: (project, place) => place.remembered !== null && project.projectName === place.remembered },
];

export function speaksProtocol5(version: string | null): boolean {
	if (!version) return true;
	const [major, minor] = version.split(".").map((part) => Number(part));
	return major > 7 || (major === 7 && minor >= 7);
}

const REASON_TEXT: Record<Reason, string> = {
	assigned: "assigned in VS Code",
	servePlaceIds: "its servePlaceIds",
	placeId: "its placeId",
	remembered: "it last synced here",
};

const IN_VS_CODE = "Assign one in Rojo-Hub's panel in VS Code (Studio places).";

const names = (projects: PlaceCandidate[]): string => projects.map((project) => project.projectName).join(", ");

export type PlaceAnswer = Omit<StudioMatch, "type" | "serviceVersion"> & { projectId: string | null };

/*
	The answer for one place. `assigned` is the slot picked for it in VS Code, if
	any; it wins over everything, for any place, saved or not.

	Among several claimants, the place keeps to the one it last synced with, and
	waits for it while its rojo restarts: it is never handed to another claimant
	that happens to be the only one serving at that moment (seen live, spec 007).
*/
export function matchPlace(place: Place, candidates: PlaceCandidate[], assigned: string | null): PlaceAnswer {
	const running = (project: PlaceCandidate) => project.state === "running" && project.sessionId !== null;

	const decide = (project: PlaceCandidate, reason: Reason): PlaceAnswer => {
		if (!running(project)) {
			return {
				status: "stopped",
				message: `Waiting for ${project.projectName}, this place's project (${REASON_TEXT[reason]}), to be started in Rojo-Hub.`,
				target: null,
				projectId: project.slotId,
			};
		}
		if (!speaksProtocol5(project.rojoVersion)) {
			return {
				status: "unsupported",
				message: `${project.projectName} is served by Rojo ${project.rojoVersion}. Rojo-Hub's plugin needs Rojo 7.7 or newer: pin rojo-rbx/rojo@7.7.0 in its rokit.toml.`,
				target: null,
				projectId: project.slotId,
			};
		}
		return {
			status: "connect",
			message: `${project.projectName} serves this place (${REASON_TEXT[reason]}).`,
			target: {
				slotId: project.slotId,
				projectName: project.projectName,
				port: project.port,
				sessionId: project.sessionId,
				branch: project.branch,
				targetLabel: project.targetLabel,
				reason,
			},
			projectId: project.slotId,
		};
	};

	const chosen = assigned ? candidates.find((project) => project.slotId === assigned) : undefined;
	if (chosen) return decide(chosen, "assigned");

	if (place.unsaved) {
		return {
			status: "unsaved",
			message: `This place is not saved to Roblox, so no project file can name it. ${IN_VS_CODE}`,
			target: null,
			projectId: null,
		};
	}

	const open = candidates.filter((project) => !project.blockedPlaceIds?.includes(place.placeId));
	for (const tier of TIERS) {
		const claiming = open.filter((project) => tier.claims(project, place));
		if (claiming.length === 0) continue;
		const own = claiming.length > 1 && place.remembered !== null ? claiming.find((project) => project.projectName === place.remembered) : undefined;
		if (own) return decide(own, tier.reason);
		const live = claiming.filter(running);
		if (live.length === 1) return decide(live[0], tier.reason);
		if (live.length > 1) {
			return {
				status: "choose",
				message: `Several serving projects claim this place: ${names(live)}. ${IN_VS_CODE}`,
				target: null,
				projectId: null,
			};
		}
		return claiming.length === 1
			? decide(claiming[0], tier.reason)
			: {
					status: "stopped",
					message: `Waiting for one of this place's projects (${names(claiming)}) to be started in Rojo-Hub.`,
					target: null,
					projectId: null,
				};
	}
	return {
		status: "none",
		message: `No project lists this place in servePlaceIds, and it has not synced with one. ${IN_VS_CODE}`,
		target: null,
		projectId: null,
	};
}

interface Studio {
	/** Names an unsaved place's window for an assignment (StudioPlaceView.key). */
	id: string;
	link: WebSocketLink;
	hello: StudioHello | null;
	connected: StudioStateConnected | null;
	/** The last answer, for the panel. */
	answer: PlaceAnswer | null;
	lastSent: string;
}
type StudioStateConnected = { port: number; projectName: string; sessionId: string };

/** How often answers are recomputed and resent when changed, like the panel's events. */
const TICK_MS = 250;
/** A message now and then so the plugin notices a dead link (M2: sockets otherwise idle). */
const HEARTBEAT_MS = 20000;

/** Stored per place: an assignment made in VS Code, and the project each place last synced with. */
export interface PlaceMemory {
	assigned(placeId: number): string | null;
	assign(placeId: number, slotId: string | null): void;
	/*
		The project each place last synced with. Kept by the service because the
		plugin's own record is one settings value shared by every Studio process,
		and each process writes back the whole table it loaded, so places open at
		once overwrite each other's entries (seen live, spec 007).
	*/
	synced(placeId: number): string | null;
	sync(placeId: number, projectName: string): void;
}

const noMemory: PlaceMemory = { assigned: () => null, assign: () => undefined, synced: () => null, sync: () => undefined };

/*
	The open plugin sockets. Each gets its place's answer after it says hello,
	and again whenever the answer changes: a project starts or stops, its rojo
	restarts with a new session, its project file changes, or the place is
	assigned in VS Code.
*/
export class StudioLinks {
	private readonly studios = new Set<Studio>();
	/** Assignments of unsaved places, by window: they share place ID 0, so they are kept only while the window is open. */
	private readonly unsavedAssigned = new Map<string, string>();

	constructor(
		private readonly candidates: () => PlaceCandidate[],
		private readonly memory: PlaceMemory = noMemory,
		/** service.log, set by main.ts once it has one. */
		public log: (message: string) => void = () => undefined,
	) {
		setInterval(() => this.tick(), TICK_MS).unref();
		setInterval(() => {
			for (const studio of this.studios) studio.link.send('{"type":"ping"}');
		}, HEARTBEAT_MS).unref();
	}

	get count(): number {
		return this.studios.size;
	}

	attach(link: WebSocketLink): void {
		const studio: Studio = { id: randomUUID(), link, hello: null, connected: null, answer: null, lastSent: "" };
		this.studios.add(studio);
		link.send(JSON.stringify({ type: "welcome", protocol: STUDIO_PROTOCOL, serviceVersion: SERVICE_VERSION }));
		link.onClose = () => {
			this.studios.delete(studio);
			this.unsavedAssigned.delete(studio.id);
		};
		link.onMessage = (text) => {
			let message: StudioToService;
			try {
				message = JSON.parse(text) as StudioToService;
			} catch {
				return;
			}
			if (message.type === "hello") {
				// Place IDs come as strings: Roblox's JSONEncode may round integers this large.
				const raw = message as unknown as Record<string, unknown>;
				studio.hello = {
					type: "hello",
					protocol: Number(raw.protocol),
					pluginVersion: String(raw.pluginVersion ?? "unknown"),
					placeId: Number(raw.placeId) || 0,
					gameId: Number(raw.gameId) || 0,
					placeName: String(raw.placeName ?? ""),
					unsaved: raw.unsaved === true,
					remembered: typeof raw.remembered === "string" ? raw.remembered : null,
				};
				this.log(`studio: ${studio.hello.placeName} (${studio.hello.placeId}${studio.hello.unsaved ? ", unsaved" : ""}) said hello, plugin ${studio.hello.pluginVersion}`);
			} else if (message.type === "state") {
				studio.connected = message.connected ?? null;
				const hello = studio.hello;
				if (studio.connected && hello && !hello.unsaved && this.memory.synced(hello.placeId) !== studio.connected.projectName) {
					this.memory.sync(hello.placeId, studio.connected.projectName);
				}
			}
			this.answer(studio, this.candidates());
		};
	}

	/*
		Assigns a project to a place from VS Code (null: back to the project
		files). `key` is StudioPlaceView.key: a place ID, stored for good, or
		"studio:<id>" for an unsaved place's window, kept while it is open.
	*/
	assign(key: string, slotId: string | null): void {
		if (key.startsWith("studio:")) {
			const id = key.slice("studio:".length);
			if (slotId) this.unsavedAssigned.set(id, slotId);
			else this.unsavedAssigned.delete(id);
		} else {
			const placeId = Number(key);
			if (!Number.isSafeInteger(placeId) || placeId <= 0) throw new Error(`"${key}" is not a place ID`);
			this.memory.assign(placeId, slotId);
		}
		this.tick();
	}

	/** Every open place with the plugin, for the panel. */
	places(): StudioPlaceView[] {
		const views: StudioPlaceView[] = [];
		for (const studio of this.studios) {
			const hello = studio.hello;
			if (!hello) continue;
			views.push({
				key: hello.unsaved ? `studio:${studio.id}` : String(hello.placeId),
				placeId: hello.placeId,
				placeName: hello.placeName,
				unsaved: hello.unsaved,
				pluginVersion: hello.pluginVersion,
				status: studio.answer?.status ?? "none",
				message: studio.answer?.message ?? "",
				projectId: studio.answer?.projectId ?? null,
				assigned: this.assignedFor(studio),
				syncedWith: studio.connected?.projectName ?? null,
			});
		}
		return views.sort((a, b) => a.placeName.localeCompare(b.placeName) || a.key.localeCompare(b.key));
	}

	/** The places synced to the project on `port` with `sessionId`, for its card. */
	placesOn(port: number, sessionId: string | null): StudioPlace[] {
		const places: StudioPlace[] = [];
		for (const studio of this.studios) {
			if (!studio.hello || !studio.connected) continue;
			if (studio.connected.port !== port || (sessionId && studio.connected.sessionId !== sessionId)) continue;
			places.push({ placeId: studio.hello.placeId, placeName: studio.hello.placeName, pluginVersion: studio.hello.pluginVersion });
		}
		return places;
	}

	private assignedFor(studio: Studio): string | null {
		const hello = studio.hello;
		if (!hello) return null;
		return hello.unsaved ? (this.unsavedAssigned.get(studio.id) ?? null) : this.memory.assigned(hello.placeId);
	}

	private tick(): void {
		if (this.studios.size === 0) return;
		const candidates = this.candidates();
		for (const studio of this.studios) this.answer(studio, candidates);
	}

	private answer(studio: Studio, candidates: PlaceCandidate[]): void {
		const hello = studio.hello;
		if (!hello) return;
		let match: StudioMatch;
		if (hello.protocol !== STUDIO_PROTOCOL) {
			studio.answer = {
				status: "incompatible",
				message: `This place runs Rojo-Hub's plugin ${hello.pluginVersion}, which Rojo-Hub ${SERVICE_VERSION} cannot talk to. Close and reopen the place to load the new plugin.`,
				target: null,
				projectId: null,
			};
		} else {
			const remembered = (hello.unsaved ? null : this.memory.synced(hello.placeId)) ?? hello.remembered;
			studio.answer = matchPlace({ ...hello, remembered }, candidates, this.assignedFor(studio));
		}
		const { projectId: _projectId, ...answer } = studio.answer;
		match = { type: "match", serviceVersion: SERVICE_VERSION, ...answer };
		const text = JSON.stringify(match);
		if (text === studio.lastSent) return;
		const was = studio.lastSent ? (JSON.parse(studio.lastSent) as StudioMatch) : null;
		if (was?.status !== match.status || was?.target?.sessionId !== match.target?.sessionId) {
			this.log(`studio: ${hello.placeName} (${hello.placeId}): ${match.status}${match.target ? ` ${match.target.projectName}:${match.target.port}` : ""}`);
		}
		studio.lastSent = text;
		studio.link.send(text);
	}

	closeAll(): void {
		for (const studio of this.studios) studio.link.close();
	}
}
