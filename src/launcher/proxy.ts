import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";

import type { Health } from "../common/api";
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
		if (typeof method !== "string") return; // a response to a request we never send
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
		}
		const outcome = await this.forward(message);
		if (outcome.kind === "answer") {
			const answer = outcome.body;
			if (method === "initialize") this.noteInitialize(answer);
			if (method === "tools/list") this.noteTools(answer);
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
	private send(method: string, path: string, body: string | null, headers: Record<string, string>, timeout: number): Promise<{ status: number; text: string } | "refused" | "reset"> {
		return new Promise((done) => {
			const request = httpRequest(
				{ host: "127.0.0.1", port: this.options.port, method, path, headers, agent: false, signal: AbortSignal.timeout(timeout) },
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => done({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
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
		const body = JSON.stringify(message);
		headers["content-length"] = String(Buffer.byteLength(body));
		const answer = await this.send("POST", "/mcp", body, headers, 30 * 60_000); // above the longest tool (ensure can wait 600 s, run 300 s and start)
		if (typeof answer === "string") return { kind: answer };
		if (answer.status >= 500) return { kind: "http", status: answer.status, text: answer.text };
		if (answer.status === 202 || answer.text === "") return { kind: "ok", status: answer.status, body: null };
		try {
			return { kind: "ok", status: answer.status, body: JSON.parse(answer.text) as Json };
		} catch {
			return { kind: "http", status: answer.status, text: answer.text };
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
