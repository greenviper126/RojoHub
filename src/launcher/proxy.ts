import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";

import { SERVICE_VERSION, type Health } from "../common/api";
import { pathKey } from "../common/paths";

/*
	The stdio launcher's proxy (spec 011, section 1). Newline-delimited JSON-RPC
	comes in on stdin; each request is POSTed to the service's /mcp and the
	answer goes out on stdout. The service keeps no MCP session, so neither does
	this: nothing here outlives a line except the cache of what the service last
	said, which answers while it is starting.

	It starts the service when nothing answers (never replaces or stops one that
	does), holds a call while that happens, and says plainly when it could not.
*/

export const HOLD_MS = 20_000;
/** How long the user is given to answer a question the launcher puts to them for the agent (MCP elicitation). */
export const ELICIT_MS = 10 * 60_000;

type Json = Record<string, unknown>;

/** Splits a stream of text into lines (newline-delimited JSON-RPC), keeping an unfinished line for the next chunk. */
export class LineBuffer {
	private text = "";

	push(chunk: string): string[] {
		this.text += chunk;
		const lines = this.text.split("\n");
		this.text = lines.pop() ?? "";
		return lines;
	}

	/** What is left when the stream ends. */
	rest(): string {
		const rest = this.text;
		this.text = "";
		return rest;
	}
}

export interface ProxyOptions {
	port: number;
	/** This Windows user's state folder; a service with another home is never used. */
	home: string;
	cachePath: string;
	/** Starts the service (detached); returns false when there is no service script to start. */
	startService: () => boolean;
	/** How long a call is held while the service starts (default 20 s). */
	holdMs?: number;
	/** How often /health is asked while the service starts. */
	pollMs?: number;
	/** This launcher's version, sent on every call (default: the bundle's own; tests set it). */
	version?: string;
	/** How long the user may take to answer an elicitation (default 10 minutes). */
	elicitMs?: number;
	/** Called with each JSON-RPC message for the agent. */
	write: (message: Json) => void;
}

interface Cache {
	instructions?: string;
	serverVersion?: string;
	protocolVersion?: string;
	tools?: unknown[];
}

type Down = "starting" | "noscript" | "otheruser";
type Post = { kind: "ok"; status: number; body: Json | null } | { kind: "refused" } | { kind: "reset" } | { kind: "http"; status: number; text: string };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The only tool offered while the service has never answered and nothing is cached. */
const STARTING_TOOL = {
	name: "rojohub_starting",
	description: "Rojo-Hub's service is starting. Call tools/list again in a few seconds; the real tools appear then.",
	inputSchema: { type: "object", properties: {} },
};

export class Proxy {
	private readonly holdMs: number;
	private readonly pollMs: number;
	private cache: Cache = {};
	/** The protocol version negotiated with the agent, sent to the service as MCP-Protocol-Version. */
	private protocol: string | undefined;
	private initialized = false;
	private verified = false;
	/** The service version the agent was told about (its serverInfo), to notice an upgrade. */
	private told: string | undefined;
	/** The agent was given a stand-in tools list (cache or placeholder) and must be told when the real one is there. */
	private toolsStale = false;
	private starting: Promise<Down | "up"> | null = null;
	private notifyAfter = false;
	/** The agent's client declared the elicitation capability in initialize: it can put a question to the user (spec 014). */
	private elicits = false;
	private elicitCount = 0;
	/** Questions put to the client and not yet answered, by JSON-RPC id. */
	private readonly waiting = new Map<string, (response: Json | null) => void>();
	private readonly pending = new Set<Promise<void>>();

	constructor(private readonly options: ProxyOptions) {
		this.holdMs = options.holdMs ?? HOLD_MS;
		this.pollMs = options.pollMs ?? 150;
		try {
			this.cache = JSON.parse(readFileSync(options.cachePath, "utf8")) as Cache;
		} catch {
			// no cache yet
		}
	}

	/** Handles one line from the agent. Resolves when its answer (if any) has been written. */
	handleLine(line: string): Promise<void> {
		const work = this.process(line).catch(() => undefined);
		this.pending.add(work);
		void work.finally(() => this.pending.delete(work));
		return work;
	}

	/** The agent went away: questions waiting for the user end unanswered, so nothing is held open. */
	abandon(): void {
		for (const done of [...this.waiting.values()]) done(null);
	}

	/** Resolves when every request in flight has been answered. */
	async idle(): Promise<void> {
		while (this.pending.size > 0) await Promise.all([...this.pending]);
	}

	private async process(line: string): Promise<void> {
		const text = line.trim();
		if (!text) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.options.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}
		for (const message of Array.isArray(parsed) ? parsed : [parsed]) await this.message(message as Json);
	}

	private async message(message: Json): Promise<void> {
		if (!message || typeof message !== "object") {
			this.options.write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			return;
		}
		const id = message.id as string | number | null | undefined;
		const method = message.method;
		if (typeof method !== "string") {
			// The client's answer to a question put to it (elicitation/create), or nothing we sent.
			if (typeof id === "string") this.waiting.get(id)?.(message);
			return;
		}
		if (id === undefined || id === null) {
			// A notification gets nothing back. It is passed on best-effort, without starting the service for it.
			if (method === "notifications/initialized") this.initialized = true;
			if (this.verified) void this.post(message).catch(() => undefined);
			return;
		}
		if (method === "ping") return this.reply(id, {});
		if (method === "initialize") {
			const asked = (message.params as Json | undefined)?.protocolVersion;
			if (typeof asked === "string") this.protocol = asked;
			// Form elicitation: the capability is present and either empty (the 2025-06-18 shape) or names "form".
			const elicitation = ((message.params as Json | undefined)?.capabilities as Json | undefined)?.elicitation;
			this.elicits = !!elicitation && typeof elicitation === "object" && (Object.keys(elicitation).length === 0 || "form" in elicitation);
		}
		const outcome = await this.forward(message);
		if (outcome.kind === "answer") {
			let answer = outcome.body;
			if (method === "initialize") this.noteInitialize(answer);
			if (method === "tools/list") this.noteTools(answer);
			if (method === "tools/call") answer = await this.elicit(answer);
			this.options.write(answer);
		} else if (method === "initialize") {
			this.localInitialize(id);
		} else if (method === "tools/list") {
			this.localTools(id);
		} else {
			const text = this.failure(outcome);
			if (method === "tools/call") this.options.write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
			else this.options.write({ jsonrpc: "2.0", id, error: { code: -32603, message: text } });
		}
		this.flushNotification();
	}

	/*
		request_place, when the place is held by another project, comes back with
		`_meta["rojo-hub/elicit"]`: a yes/no for the user. It is put to the user as
		an MCP elicitation request through the client, so the answer comes from the
		user and never through the model's arguments (spec 014). Move or decline is
		sent to the service as the user's answer, marked as given in chat for the
		audit log; a cancelled or unanswered question leaves the request pending.
		The agent gets the outcome as the call's result, in the service's wording.
	*/
	private async elicit(answer: Json): Promise<Json> {
		const result = answer.result as Json | undefined;
		const meta = result?._meta as Json | undefined;
		const ask = meta?.["rojo-hub/elicit"] as Json | undefined;
		if (!result || !ask || typeof ask.requestId !== "string" || typeof ask.message !== "string") return answer;
		const { _meta: _dropped, ...rest } = result;
		const finish = (chosen: { text?: unknown; data?: unknown } | undefined, prefix = ""): Json => {
			const content = Array.isArray(rest.content) ? (rest.content as Json[]) : [];
			const text = typeof chosen?.text === "string" ? chosen.text : typeof content[0]?.text === "string" ? content[0].text : "";
			const next: Json = { ...rest, content: [{ type: "text", text: prefix + text }, ...content.slice(1)] };
			if (chosen?.data && rest.structuredContent) next.structuredContent = chosen.data;
			return { ...answer, result: next };
		};
		const { choice, raw } = await this.askUser(ask.message);
		if (choice === "leave") return finish(undefined, "The user did not answer the question put to them here (cancelled or timed out); the request stays pending, and they can still answer in VS Code. ");
		const posted = await this.send(
			"POST",
			`/studio/requests/${encodeURIComponent(ask.requestId)}/${choice}`,
			"{}",
			// The client's own answer, for the log: a wrong reading of it shows there.
			{ "content-type": "application/json", "content-length": "2", "x-rojo-hub-answered-in": "chat", "x-rojo-hub-elicit-result": raw },
			15_000,
		);
		if (typeof posted === "string") return finish(undefined, "The user answered, but Rojo-Hub's service could not be reached to record it; the request stays pending. ");
		if (posted.status === 409) return finish(ask.answered as Json | undefined);
		if (posted.status !== 200) return finish(undefined, `The user answered, but Rojo-Hub's service refused it (HTTP ${posted.status}); the request stays pending. `);
		return finish((choice === "move" ? ask.moved : ask.declined) as Json | undefined);
	}

	/*
		Puts the yes/no to the user through the client. The buttons are the answer:
		accept is Move, decline is decline, whatever the form's field says. 0.22.5-
		0.22.9 read the field, which started unticked, and the user could not tick
		it in their client, so every accept declined. The field is there only
		because a form needs one. "leave" when they cancel, the client errors, or no
		answer comes. `raw` is the client's answer as sent, for the log.
	*/
	private async askUser(message: string): Promise<{ choice: "move" | "decline" | "leave"; raw: string }> {
		const id = `rojohub-elicit-${++this.elicitCount}`;
		const response = new Promise<Json | null>((done) => {
			const timer = setTimeout(() => finishWith(null), this.options.elicitMs ?? ELICIT_MS);
			const finishWith = (value: Json | null) => {
				clearTimeout(timer);
				this.waiting.delete(id);
				done(value);
			};
			this.waiting.set(id, finishWith);
		});
		this.options.write({
			jsonrpc: "2.0",
			id,
			method: "elicitation/create",
			params: {
				message,
				requestedSchema: {
					type: "object",
					properties: { move: { type: "boolean", title: "Move the place", description: "Accept moves it now; Decline refuses the request.", default: true } },
				},
			},
		});
		const reply = await response;
		const outcome = reply?.result as { action?: unknown } | undefined;
		// Header-safe: ASCII only, and short.
		const raw = (reply === null ? "no answer" : JSON.stringify(reply.error ?? reply.result ?? null)).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
		if (!outcome || reply?.error) return { choice: "leave", raw };
		return { choice: outcome.action === "accept" ? "move" : outcome.action === "decline" ? "decline" : "leave", raw };
	}

	private reply(id: string | number, result: Json): void {
		this.options.write({ jsonrpc: "2.0", id, result });
	}

	private failure(outcome: { kind: "down"; why: Down } | { kind: "reset" } | { kind: "http"; status: number; text: string }): string {
		if (outcome.kind === "http") return `Rojo-Hub's service answered HTTP ${outcome.status}: ${outcome.text.trim().split(/[\r\n]/)[0].slice(0, 300)}`;
		if (outcome.kind === "reset") return "Rojo-Hub's service restarted while this call ran; call status to see whether it took effect.";
		if (outcome.why === "noscript") return "Rojo-Hub is not installed in VS Code (no dist/service.js found). Install or reinstall the extension.";
		if (outcome.why === "otheruser") return `Port ${this.options.port} is used by another Windows user's Rojo-Hub. Only one signed-in user can run Rojo-Hub at a time.`;
		return `Rojo-Hub's service is not running and is still starting (see service.log in ${this.options.home}). Call this again in a few seconds.`;
	}

	/*
		Sends one request, starting the service first when nothing answers and
		holding up to holdMs for it. A refused connection never reached the
		service, so that request is sent once more; a connection that dies
		after it was sent is not, since the call may have happened.
	*/
	private async forward(message: Json): Promise<{ kind: "answer"; body: Json } | { kind: "down"; why: Down } | { kind: "reset" } | { kind: "http"; status: number; text: string }> {
		const deadline = Date.now() + this.holdMs;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!this.verified) {
				const state = await this.bringUp(deadline);
				if (state !== "up") return { kind: "down", why: state };
			}
			const posted = await this.post(message);
			if (posted.kind === "ok") {
				if (posted.body) return { kind: "answer", body: posted.body };
				return { kind: "down", why: "starting" };
			}
			this.verified = false;
			if (posted.kind === "reset") return { kind: "reset" };
			if (posted.kind === "http") return posted;
		}
		return { kind: "down", why: "starting" };
	}

	/** Waits until this user's service answers /health, starting it if nothing does, or until the deadline. */
	private async bringUp(deadline: number): Promise<Down | "up"> {
		const first = await this.health();
		if (first === "up") return this.up();
		if (first === "otheruser") return "otheruser";
		this.starting ??= this.start().finally(() => (this.starting = null));
		const result = await Promise.race([this.starting, sleep(Math.max(0, deadline - Date.now())).then(() => "starting" as const)]);
		return result === "up" ? this.up() : result;
	}

	private async start(): Promise<Down | "up"> {
		// Looked for on every attempt, so installing the extension mid-session works.
		if (!this.options.startService()) return "noscript";
		// Polled for as long as a start can take; every call waiting on it gives up at its own deadline.
		for (let i = 0; i < 400; i++) {
			const state = await this.health();
			if (state === "up") return "up";
			if (state === "otheruser") return "otheruser";
			await sleep(this.pollMs);
		}
		return "starting";
	}

	private up(): "up" {
		this.verified = true;
		return "up";
	}

	private async health(): Promise<"up" | "down" | "otheruser"> {
		let health: Health;
		const answer = await this.send("GET", "/health", null, {}, 1500);
		if (typeof answer === "string" || answer.status !== 200) return "down";
		try {
			health = JSON.parse(answer.text) as Health;
		} catch {
			return "down";
		}
		if (!health || typeof health.home !== "string" || pathKey(health.home) !== pathKey(this.options.home)) return "otheruser";
		// A different service from the one the agent was told about: its tools may have changed.
		if (this.initialized && this.told !== undefined && health.version !== this.told) {
			this.told = health.version;
			this.notifyAfter = true;
		} else if (this.told === undefined) this.told = health.version;
		if (this.toolsStale && this.initialized) this.notifyAfter = true;
		return "up";
	}

	private flushNotification(): void {
		if (!this.notifyAfter) return;
		this.notifyAfter = false;
		this.toolsStale = false;
		this.options.write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	}

	/*
		A fresh connection per request (agent: false), never a pooled one: a pooled
		connection to a service that has since exited fails with a reset, which
		cannot be told from a call that died halfway. A refused connection is
		the one failure that proves the request never reached the service.
	*/
	private send(method: string, path: string, body: string | null, headers: Record<string, string>, timeout: number): Promise<{ status: number; text: string; headers: IncomingHttpHeaders } | "refused" | "reset"> {
		return new Promise((done) => {
			const request = httpRequest(
				{ host: "127.0.0.1", port: this.options.port, method, path, headers, agent: false, signal: AbortSignal.timeout(timeout) },
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => done({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
					response.on("error", () => done("reset"));
					response.on("close", () => done("reset")); // after "end" this is a no-op
				},
			);
			request.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "refused" : "reset"));
			request.end(body ?? undefined);
		});
	}

	private async post(message: Json): Promise<Post> {
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
		// What the service uses to tell which clients understand outputSchema (spec 011, section 3).
		if (this.protocol && message.method !== "initialize") headers["mcp-protocol-version"] = this.protocol;
		// Tells the service the user can be asked here, so request_place hands the question back (spec 014).
		if (this.elicits && message.method === "tools/call" && (message.params as { name?: unknown } | undefined)?.name === "request_place") headers["x-rojo-hub-elicit"] = "1";
		const body = JSON.stringify(message);
		headers["content-length"] = String(Buffer.byteLength(body));
		// Which launcher this is, so the service can tell a chat that still runs an older one (it keeps its code until the chat reconnects).
		headers["x-rojo-hub-launcher"] = this.options.version ?? SERVICE_VERSION;
		const answer = await this.send("POST", "/mcp", body, headers, 30 * 60_000); // above the longest tool (ensure can wait 600 s, run 300 s and start)
		if (typeof answer === "string") return { kind: answer };
		await this.noteService(answer.headers["x-rojo-hub-version"]);
		if (answer.status >= 500) return { kind: "http", status: answer.status, text: answer.text };
		if (answer.status === 202 || answer.text === "") return { kind: "ok", status: answer.status, body: null };
		try {
			return { kind: "ok", status: answer.status, body: JSON.parse(answer.text) as Json };
		} catch {
			return { kind: "http", status: answer.status, text: answer.text };
		}
	}

	/*
		Compares the service that just answered with the one the agent was told
		about, so a new service that took over the port between two calls is
		noticed even though no call failed. An older service sends no header;
		/health tells then. Nothing runs on a timer: this is only ever called with
		an answer.
	*/
	private async noteService(version: string | string[] | undefined): Promise<void> {
		if (!this.initialized || this.told === undefined) return;
		if (typeof version !== "string") {
			await this.health();
			return;
		}
		if (version !== this.told) {
			this.told = version;
			this.notifyAfter = true;
		}
	}

	private noteInitialize(answer: Json): void {
		const result = answer.result as Json | undefined;
		if (!result) return;
		const info = result.serverInfo as { version?: unknown } | undefined;
		if (typeof info?.version === "string") this.told = info.version;
		if (typeof result.protocolVersion === "string") this.protocol = result.protocolVersion;
		// The launcher can tell the agent when the tools change (an upgrade, or the service coming up), whatever the service says.
		const capabilities = ((result.capabilities as Json | undefined) ??= {});
		capabilities.tools = { ...(capabilities.tools as Json | undefined), listChanged: true };
		this.cache = {
			...this.cache,
			instructions: typeof result.instructions === "string" ? result.instructions : this.cache.instructions,
			serverVersion: this.told,
			protocolVersion: this.protocol,
		};
		this.save();
	}

	private noteTools(answer: Json): void {
		const tools = (answer.result as { tools?: unknown } | undefined)?.tools;
		if (!Array.isArray(tools)) return;
		// The agent now has the real list, so a change noticed on the way needs no announcement.
		this.toolsStale = false;
		this.notifyAfter = false;
		this.cache = { ...this.cache, tools };
		this.save();
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.options.cachePath), { recursive: true });
			const temporary = `${this.options.cachePath}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(this.cache));
			renameSync(temporary, this.options.cachePath);
		} catch {
			// the cache only improves the answers while the service starts
		}
	}

	private localInitialize(id: string | number): void {
		this.told = this.cache.serverVersion;
		this.reply(id, {
			protocolVersion: this.protocol ?? this.cache.protocolVersion ?? "2025-06-18",
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: "rojo-hub", title: "Rojo-Hub", version: this.cache.serverVersion ?? "0.0.0" },
			instructions: this.cache.instructions ?? "Rojo-Hub serves Roblox Rojo projects to Studio. Its service is starting; its tools appear in a moment.",
		});
		this.toolsStale = true;
	}

	private localTools(id: string | number): void {
		this.toolsStale = true;
		this.reply(id, { tools: this.cache.tools?.length ? this.cache.tools : [STARTING_TOOL] });
	}
}
