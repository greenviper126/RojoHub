import {
	SERVICE_VERSION,
	STUDIO_PROTOCOL,
	type SlotState,
	type StudioHello,
	type StudioMatch,
	type StudioPlace,
	type StudioProject,
	type StudioToService,
} from "../common/api";
import type { WebSocketLink } from "./websocket";

/*
	Which project a Studio place belongs to, and the plugin sockets that ask
	(spec 007). The place's project comes from the project files: servePlaceIds,
	then placeId, then the project the place last synced with. Only running
	projects are connected to, and only when exactly one claims the place, or the
	user picked one of several.
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

type Reason = NonNullable<StudioProject["reason"]>;

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
	servePlaceIds: "its servePlaceIds",
	placeId: "its placeId",
	remembered: "it last synced here",
};

const names = (projects: PlaceCandidate[]): string => projects.map((project) => project.projectName).join(", ");

/*
	The answer for one place. `choice` is the slot the user picked for it among
	several, if any.

	Among several claimants, the place keeps to its own: the one picked for it,
	else the one it last synced with. While that one is down (its rojo
	restarting), the place waits for it; it is never handed to another claimant
	that happens to be the only one serving at that moment (seen live, spec 007).
*/
export function matchPlace(place: Place, candidates: PlaceCandidate[], choice: string | null): Omit<StudioMatch, "type" | "serviceVersion"> {
	const running = (project: PlaceCandidate) => project.state === "running" && project.sessionId !== null;
	const reasons = new Map<string, Reason>();
	let answer: { status: StudioMatch["status"]; message: string } | null = null;
	let targetId: string | null = null;

	if (place.unsaved) {
		answer = {
			status: "unsaved",
			message: "This place is not saved to Roblox yet, so Rojo-Hub cannot tell which project it belongs to. Pick a project to sync it by hand.",
		};
	} else {
		const open = candidates.filter((project) => !project.blockedPlaceIds?.includes(place.placeId));
		for (const tier of TIERS) {
			const claiming = open.filter((project) => tier.claims(project, place));
			if (claiming.length === 0) continue;
			for (const project of claiming) reasons.set(project.slotId, tier.reason);
			const live = claiming.filter(running);
			const own =
				claiming.find((project) => project.slotId === choice) ??
				(claiming.length > 1 && place.remembered !== null ? claiming.find((project) => project.projectName === place.remembered) : undefined);
			if (own && !running(own)) {
				answer = {
					status: "stopped",
					message: `${own.projectName} is this place's project, and not serving. Start it in Rojo-Hub and this place syncs by itself.`,
				};
			} else if (live.length === 0) {
				answer = {
					status: "stopped",
					message: `${names(claiming)} ${claiming.length === 1 ? "is" : "are"} this place's project, and not serving. Start it in Rojo-Hub and this place syncs by itself.`,
				};
			} else {
				const picked = own ?? (live.length === 1 ? live[0] : undefined);
				if (!picked) {
					answer = {
						status: "choose",
						message: `Several serving projects claim this place: ${names(live)}. Pick one; Rojo-Hub remembers it for this place.`,
					};
				} else if (!speaksProtocol5(picked.rojoVersion)) {
					answer = {
						status: "unsupported",
						message: `${picked.projectName} is served by Rojo ${picked.rojoVersion}. Rojo-Hub's plugin needs Rojo 7.7 or newer: pin rojo-rbx/rojo@7.7.0 in its rokit.toml.`,
					};
				} else {
					answer = { status: "connect", message: `${picked.projectName} serves this place (${REASON_TEXT[tier.reason]}).` };
					targetId = picked.slotId;
				}
			}
			break;
		}
		answer ??= {
			status: "none",
			message: "No project lists this place in servePlaceIds, and it has not synced with one yet. Pick a project to sync it; next time it connects by itself.",
		};
	}

	const view = (project: PlaceCandidate): StudioProject => ({
		slotId: project.slotId,
		projectName: project.projectName,
		port: project.port,
		sessionId: project.sessionId,
		branch: project.branch,
		targetLabel: project.targetLabel,
		reason: reasons.get(project.slotId) ?? null,
		supported: speaksProtocol5(project.rojoVersion),
	});
	const projects = candidates
		.filter(running)
		.map(view)
		.sort((a, b) => Number(b.reason !== null) - Number(a.reason !== null));
	return { ...answer, target: projects.find((project) => project.slotId === targetId) ?? null, projects };
}

interface Studio {
	link: WebSocketLink;
	hello: StudioHello | null;
	connected: StudioStateConnected | null;
	lastSent: string;
}
type StudioStateConnected = { port: number; projectName: string; sessionId: string };

/** How often answers are recomputed and resent when changed, like the panel's events. */
const TICK_MS = 250;
/** A message now and then so the plugin notices a dead link (M2: sockets otherwise idle). */
const HEARTBEAT_MS = 20000;

/*
	The open plugin sockets. Each gets its place's answer after it says hello,
	and again whenever the answer changes: a project starts or stops, its rojo
	restarts with a new session, or its project file changes.
*/
export class StudioLinks {
	private readonly studios = new Set<Studio>();

	constructor(
		private readonly candidates: () => PlaceCandidate[],
		private readonly choices: {
			get(placeId: number): string | null;
			set(placeId: number, slotId: string | null): void;
		},
		/*
			The project each place last synced with. Kept by the service because the
			plugin's own record is one settings value shared by every Studio process,
			and each process writes back the whole table it loaded, so places open at
			once overwrite each other's entries (seen live, spec 007).
		*/
		private readonly synced: {
			get(placeId: number): string | null;
			set(placeId: number, projectName: string): void;
		} = { get: () => null, set: () => undefined },
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
		const studio: Studio = { link, hello: null, connected: null, lastSent: "" };
		this.studios.add(studio);
		link.send(JSON.stringify({ type: "welcome", protocol: STUDIO_PROTOCOL, serviceVersion: SERVICE_VERSION }));
		link.onClose = () => this.studios.delete(studio);
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
				message = studio.hello;
				this.log(`studio: ${studio.hello.placeName} (${studio.hello.placeId}${studio.hello.unsaved ? ", unsaved" : ""}) said hello, plugin ${studio.hello.pluginVersion}`);
			} else if (message.type === "state") {
				studio.connected = message.connected ?? null;
				const hello = studio.hello;
				if (studio.connected && hello && !hello.unsaved && this.synced.get(hello.placeId) !== studio.connected.projectName) {
					this.synced.set(hello.placeId, studio.connected.projectName);
				}
			} else if (message.type === "choose" && studio.hello && !studio.hello.unsaved) {
				this.choices.set(studio.hello.placeId, message.slotId);
			}
			this.answer(studio, this.candidates());
		};
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
			match = {
				type: "match",
				serviceVersion: SERVICE_VERSION,
				status: "incompatible",
				message: `This place runs Rojo-Hub's plugin ${hello.pluginVersion}, which Rojo-Hub ${SERVICE_VERSION} cannot talk to. Close and reopen the place to load the new plugin.`,
				target: null,
				projects: [],
			};
		} else {
			const choice = hello.unsaved ? null : this.choices.get(hello.placeId);
			const remembered = (hello.unsaved ? null : this.synced.get(hello.placeId)) ?? hello.remembered;
			match = { type: "match", serviceVersion: SERVICE_VERSION, ...matchPlace({ ...hello, remembered }, candidates, choice) };
		}
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
