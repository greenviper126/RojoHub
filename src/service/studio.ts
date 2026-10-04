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
	type StudioUnapplied,
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
	/** Coming back by itself (a crash restart, a port move): the plugin waits for it quietly (spec 010). */
	restarting?: boolean;
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

export type PlaceAnswer = Omit<StudioMatch, "type" | "serviceVersion"> & { projectId: string | null; reason?: Reason };

/*
	The answer for one place. `assigned` is the slot picked for it in VS Code, if
	any; it wins over everything, for any place, saved or not.

	Among several claimants, the place keeps to the one it last synced with, and
	waits for it while its rojo restarts: it is never handed to another claimant
	that happens to be the only one serving at that moment (seen live, spec 007).
*/
export function matchPlace(place: Place, candidates: PlaceCandidate[], assigned: string | null, remembered = true): PlaceAnswer {
	const running = (project: PlaceCandidate) => project.state === "running" && project.sessionId !== null;

	const decide = (project: PlaceCandidate, reason: Reason): PlaceAnswer => {
		if (!running(project)) {
			return {
				status: "stopped",
				message: project.restarting
					? `${project.projectName}, this place's project (${REASON_TEXT[reason]}), is restarting.`
					: `Waiting for ${project.projectName}, this place's project (${REASON_TEXT[reason]}), to be started in Rojo-Hub.`,
				target: null,
				projectId: project.slotId,
				reason,
				...(project.restarting ? { restarting: true } : {}),
			};
		}
		if (!speaksProtocol5(project.rojoVersion)) {
			return {
				status: "unsupported",
				message: `${project.projectName} is served by Rojo ${project.rojoVersion}. Rojo-Hub's plugin needs Rojo 7.7 or newer: pin rojo-rbx/rojo@7.7.0 in its rokit.toml.`,
				target: null,
				projectId: project.slotId,
			reason,
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
				// Filled in by StudioLinks, which knows what each place has synced with.
				accepted: false,
			},
			projectId: project.slotId,
			reason,
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
		// rojoHub.studioAutoConnect "listed": only what a project file names, or the panel assigned, connects by itself.
		if (tier.reason === "remembered" && !remembered) continue;
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
		message: remembered
			? `No project lists this place in servePlaceIds, and it has not synced with one. ${IN_VS_CODE}`
			: `No project lists this place in servePlaceIds, and only listed places connect by themselves (rojoHub.studioAutoConnect). Connect by hand, or ${IN_VS_CODE.charAt(0).toLowerCase()}${IN_VS_CODE.slice(1)}`,
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
	/** Rojo's first-sync confirmation is open in the place. */
	confirming: boolean;
	/** The last answer, for the panel. */
	answer: PlaceAnswer | null;
	lastSent: string;
	/** The plugin's last report of changes it could not apply (spec 010), with when it came. */
	unapplied: (Omit<StudioUnapplied, "type"> & { at: number }) | null;
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
	/*
		Whether a place has synced with a project before. The first sync of a place
		with a project is the one that can overwrite what was in the place, so
		Rojo's confirmation is asked for it, once; after that the plugin accepts
		by itself (spec 007).
	*/
	accepted(placeId: number, projectName: string): boolean;
	accept(placeId: number, projectName: string): void;
}

const noMemory: PlaceMemory = { assigned: () => null, assign: () => undefined, synced: () => null, sync: () => undefined, accepted: () => false, accept: () => undefined };

/*
	The open plugin sockets. Each gets its place's answer after it says hello,
	and again whenever the answer changes: a project starts or stops, its rojo
	restarts with a new session, its project file changes, or the place is
	assigned in VS Code.
*/
export class StudioLinks {
	private readonly studios = new Set<Studio>();
	/** rojoHub.studioAutoConnect: false ("listed") connects only places a project file names, or that are assigned. */
	rememberedAutoConnect = true;
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
		const studio: Studio = { id: randomUUID(), link, hello: null, connected: null, confirming: false, answer: null, lastSent: "", unapplied: null };
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
			} else if (message.type === "unapplied") {
				const raw = message as unknown as Record<string, unknown>;
				const items = Array.isArray(raw.items) ? raw.items.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
				studio.unapplied = { sessionId: String(raw.sessionId ?? ""), total: Number(raw.total) || items.length, items, at: Date.now() };
				if (studio.hello) this.log(`studio: ${studio.hello.placeName} (${studio.hello.placeId}) could not apply ${studio.unapplied.total} changes: ${items.slice(0, 3).join("; ")}`);
				return;
			} else if (message.type === "state") {
				studio.connected = message.connected ?? null;
				studio.confirming = message.confirming === true;
				const hello = studio.hello;
				if (studio.connected && hello && !hello.unsaved) {
					if (this.memory.synced(hello.placeId) !== studio.connected.projectName) this.memory.sync(hello.placeId, studio.connected.projectName);
					// Synced means the first-sync confirmation was accepted (or not needed): not asked again for this pair.
					if (!this.memory.accepted(hello.placeId, studio.connected.projectName)) this.memory.accept(hello.placeId, studio.connected.projectName);
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
				reason: studio.answer?.target?.reason ?? studio.answer?.reason ?? null,
				assigned: this.assignedFor(studio),
				syncedWith: studio.connected?.projectName ?? null,
				confirming: studio.confirming,
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

	/** What places synced to the project on `port` reported they could not apply since `since` (ms), for an agent's switch. */
	unappliedOn(port: number, since: number): { placeName: string; placeId: number; total: number; items: string[] }[] {
		const reports: { placeName: string; placeId: number; total: number; items: string[] }[] = [];
		for (const studio of this.studios) {
			const report = studio.unapplied;
			if (!studio.hello || !report || report.at < since) continue;
			if (studio.connected && (studio.connected.port !== port || studio.connected.sessionId !== report.sessionId)) continue;
			reports.push({ placeName: studio.hello.placeName, placeId: studio.hello.placeId, total: report.total, items: report.items });
		}
		return reports;
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
			studio.answer = matchPlace({ ...hello, remembered }, candidates, this.assignedFor(studio), this.rememberedAutoConnect);
			const target = studio.answer.target;
			if (target && !hello.unsaved) studio.answer.target = { ...target, accepted: this.memory.accepted(hello.placeId, target.projectName) };
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
