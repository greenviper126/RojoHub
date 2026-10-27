import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_CLIS, commandLine, setupCommands, setupPrompt } from "../common/agents";
import { MCP_URL, SERVICE_VERSION } from "../common/api";
import { findService, hintFile, installLauncher, launcherScript, launcherVersion, writeHint } from "../common/launcher";
import { LineBuffer, Proxy } from "../launcher/proxy";
import { AGENTS, AgentRegistrar, agentState } from "../service/agentConfig";

/* The stdio launcher (spec 011, section 1): discovery, the copy, the entry shapes and the proxy. */

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `rojo-hub-${prefix}-`));

function touch(file: string, text = ""): string {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return file;
}

test("launcher: the service script to start is the highest version found, a hint or override first", () => {
	const user = temp("scan-user");
	const home = temp("scan-home");
	const extension = (root: string, name: string, withService = true) => touch(join(user, root, "extensions", name, withService ? join("dist", "service.js") : "package.json"));
	extension(".vscode", "greenviper126.rojo-hub-0.21.0-win32-x64");
	const best = extension(".vscode", "greenviper126.rojo-hub-0.22.0");
	extension(".vscode", "greenviper126.rojo-hub-0.30.0", false); // no dist/service.js: skipped
	extension(".vscode", "someone.else-9.0.0");
	extension(".cursor", "greenviper126.rojo-hub-0.9.0");
	assert.equal(findService(home, {}, user)?.script, best, "0.22.0 beats 0.21.0 and 0.9.0; 0.30.0 has no service");
	assert.equal(findService(home, {}, user)?.version, "0.22.0");

	const shared = temp("scan-shared");
	const sharedBest = touch(join(shared, "greenviper126.rojo-hub-0.22.1", "dist", "service.js"));
	assert.equal(findService(home, { VSCODE_EXTENSIONS: shared }, user)?.script, sharedBest, "VSCODE_EXTENSIONS is scanned too");

	const dev = touch(join(temp("scan-dev"), "dist", "service.js"));
	writeHint(home, "0.23.0", dev);
	assert.deepEqual(JSON.parse(readFileSync(hintFile(home), "utf8")), { version: "0.23.0", script: dev });
	assert.equal(findService(home, {}, user)?.script, dev, "a hint with a higher version wins");
	writeHint(home, "0.22.0", dev);
	assert.equal(findService(home, {}, user)?.script, dev, "a tie goes to the hint (a development host)");
	writeHint(home, "0.99.0", join(user, "gone", "service.js"));
	assert.equal(findService(home, {}, user)?.script, best, "a hint whose script is gone is ignored");

	assert.equal(findService(home, { ROJO_HUB_SERVICE: "X:\\service.js" }, user)?.script, "X:\\service.js", "ROJO_HUB_SERVICE overrides");
	assert.equal(findService(temp("scan-home2"), {}, temp("scan-empty")), null, "nothing installed");
});

test("launcher: the service copies it with a versioned first line and never downgrades it", () => {
	const home = temp("copy");
	const bundle = touch(join(temp("copy-dist"), "mcp-stdio.js"), "console.log('launcher');\n");
	assert.equal(installLauncher(home, bundle, "0.22.0"), "installed");
	const copy = launcherScript(home);
	assert.equal(readFileSync(copy, "utf8"), "// rojo-hub-launcher 0.22.0\nconsole.log('launcher');\n");
	assert.equal(launcherVersion(copy), "0.22.0");
	assert.equal(installLauncher(home, bundle, "0.22.0"), "same");
	assert.equal(installLauncher(home, bundle, "0.21.0"), "newer", "an older service leaves a newer launcher alone");
	assert.equal(launcherVersion(copy), "0.22.0");
	writeFileSync(bundle, "console.log('newer');\n");
	assert.equal(installLauncher(home, bundle, "0.23.0"), "installed");
	assert.equal(launcherVersion(copy), "0.23.0");
	assert.equal(installLauncher(home, join(home, "missing.js"), "0.24.0"), "failed");
	assert.equal(launcherVersion(copy), "0.23.0", "a failed copy leaves the current one");
});

test("launcher: agent entry shapes, in the JSON and TOML readers", () => {
	const home = temp("shapes");
	const hubHome = temp("shapes-hub");
	const keys = ["USERPROFILE", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ROJO_HUB_HOME"] as const;
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, { USERPROFILE: home, HOME: home, CODEX_HOME: home, ROJO_HUB_HOME: hubHome });
	delete process.env.CLAUDE_CONFIG_DIR;
	try {
		const [claude, codex] = AGENTS;
		const script = launcherScript(hubHome);
		const json = (entry: unknown) => writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { rojohub: entry } }));
		const toml = (body: string) => writeFileSync(join(home, "config.toml"), `[mcp_servers.rojohub]\n${body}\n`);

		touch(script, "// rojo-hub-launcher 0.22.0\n");
		json({ type: "stdio", command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } });
		assert.equal(agentState(claude), "connected", "the launcher, program and script present");
		json({ type: "stdio", command: "node", args: [script] });
		assert.equal(agentState(claude), "connected", "a bare command (node on PATH) is taken as present");
		json({ type: "stdio", command: join(home, "no-such", "Code.exe"), args: [script] });
		assert.equal(agentState(claude), "stale", "the program is gone");
		json({ type: "stdio", command: process.execPath, args: [join(home, "other", "launcher", "rojohub-mcp.cjs")] });
		assert.equal(agentState(claude), "other", "another script is the user's own");
		json({ type: "stdio", command: "python", args: ["server.py"] });
		assert.equal(agentState(claude), "other", "another command is the user's own");
		json({ type: "http", url: MCP_URL + "/" });
		assert.equal(agentState(claude), "legacy", "the old URL entry");
		json({ type: "http", url: "http://example.com/mcp" });
		assert.equal(agentState(claude), "other", "another URL");

		toml(`command = '${process.execPath}'\nargs = ['${script}']\n[mcp_servers.rojohub.env]\nELECTRON_RUN_AS_NODE = "1"`);
		assert.equal(agentState(codex), "connected");
		toml(`command = '${process.execPath}'\nargs = ['${script}x']`);
		assert.equal(agentState(codex), "other");
		toml(`url = "${MCP_URL}"`);
		assert.equal(agentState(codex), "legacy");
		toml(`command = '${join(home, "gone.exe")}'\nargs = ['${script}']`);
		assert.equal(agentState(codex), "stale");

		toml(`command = '${process.execPath}'\nargs = ['${script}']`);
		assert.equal(agentState(codex), "connected");
		rmSync(script);
		assert.equal(agentState(codex), "stale", "the script is gone");
		process.env.ROJO_HUB_HOME = temp("shapes-other");
		assert.equal(agentState(codex), "other", "an entry for another hub home is not ours");
	} finally {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
});

test("launcher: the registrar rewrites legacy and stale entries with remove then add, and leaves the user's own", async () => {
	const home = temp("registrar");
	const hubHome = temp("registrar-hub");
	const keys = ["USERPROFILE", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ROJO_HUB_HOME"] as const;
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, { USERPROFILE: home, HOME: home, CODEX_HOME: home, ROJO_HUB_HOME: hubHome });
	delete process.env.CLAUDE_CONFIG_DIR;
	try {
		const launch = { command: "C:\\Program Files\\Code\\Code.exe", script: launcherScript(hubHome) };
		const calls: string[] = [];
		const registrar = () => new AgentRegistrar(async (cli, args) => void calls.push(`${cli} ${args.join(" ")}`), () => launch, async () => true);
		const claudeJson = (entry: unknown) => writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { rojohub: entry } }));
		const claudeAdd = `claude ${AGENT_CLIS.claudeCode.add(launch).join(" ")}`;
		const claudeRemove = `claude ${AGENT_CLIS.claudeCode.remove.join(" ")}`;

		claudeJson({ type: "http", url: MCP_URL });
		await registrar().reconcile();
		assert.deepEqual(calls.splice(0), [claudeRemove, claudeAdd], "legacy is rewritten");

		claudeJson({ type: "stdio", command: join(home, "gone.exe"), args: [launcherScript(hubHome)] });
		await registrar().reconcile();
		assert.deepEqual(calls.splice(0), [claudeRemove, claudeAdd], "stale is rewritten");

		claudeJson({ type: "http", url: "http://example.com/mcp" });
		await registrar().reconcile();
		assert.deepEqual(calls.splice(0), [], "another URL is never touched");
		await registrar().apply({ claudeCode: false });
		assert.deepEqual(calls.splice(0), [], "nor removed");
		await registrar().apply({ claudeCode: true });
		assert.deepEqual(calls.splice(0), [], "nor added over");

		claudeJson({ type: "http", url: MCP_URL });
		await registrar().apply({ claudeCode: false });
		assert.deepEqual(calls.splice(0), [claudeRemove], "turning it off removes a legacy entry without adding");

		writeFileSync(join(home, ".claude.json"), "{}");
		await registrar().apply({ claudeCode: true });
		assert.deepEqual(calls.splice(0), [claudeAdd], "turning it on adds the launcher entry");

		// A rewrite whose add fails (twice) loses the entry; the next reconcile adds it again.
		claudeJson({ type: "http", url: MCP_URL });
		let failAdds = 2;
		const flaky = new AgentRegistrar(
			async (cli, args) => {
				calls.push(`${cli} ${args.join(" ")}`);
				if (args[1] === "add" && failAdds-- > 0) throw new Error("add failed");
			},
			() => launch,
			async () => true,
		);
		const failed = await flaky.reconcile();
		assert.deepEqual(calls.splice(0), [claudeRemove, claudeAdd, claudeAdd], "the add is tried twice");
		assert.match(failed.find((agent) => agent.id === "claudeCode")!.error ?? "", /add failed/);
		writeFileSync(join(home, ".claude.json"), "{}"); // what the remove left behind
		await registrar().reconcile();
		assert.deepEqual(calls.splice(0), [claudeAdd], "the next reconcile adds the removed entry back");
		await registrar().reconcile();
		assert.deepEqual(calls.splice(0), [], "and only once");
	} finally {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
});

test("launcher: the agent CLIs' argument lists and the setup text", () => {
	const launch = { command: "C:\\Program Files\\Microsoft VS Code\\Code.exe", script: "C:\\Users\\a\\AppData\\Local\\RojoHub\\launcher\\rojohub-mcp.cjs" };
	const claude = AGENT_CLIS.claudeCode.add(launch);
	// claude's -e takes any number of values, so an option must end it before the server name.
	assert.deepEqual(claude, ["mcp", "add", "--transport", "stdio", "-e", "ELECTRON_RUN_AS_NODE=1", "--scope", "user", "rojohub", "--", launch.command, launch.script]);
	assert.deepEqual(AGENT_CLIS.codex.add(launch), ["mcp", "add", "rojohub", "--env", "ELECTRON_RUN_AS_NODE=1", "--", launch.command, launch.script]);
	assert.deepEqual(AGENT_CLIS.claudeCode.remove, ["mcp", "remove", "rojohub", "--scope", "user"]);
	assert.deepEqual(AGENT_CLIS.codex.remove, ["mcp", "remove", "rojohub"]);
	assert.equal(commandLine("claude", ["a b", "c"]), 'claude "a b" c');
	const text = setupCommands(launch);
	assert.ok(text.indexOf("--transport stdio") < text.indexOf("--transport http"), "the stdio form comes first, the URL form after");
	assert.match(text, /"command": "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code\.exe"/);
	assert.ok(text.includes(MCP_URL));
	assert.match(setupPrompt(launch), /stdio transport[^]*ELECTRON_RUN_AS_NODE=1[^]*streamable HTTP at http:\/\/127\.0\.0\.1:34870\/mcp/);
});

test("launcher: line framing", () => {
	const lines = new LineBuffer();
	assert.deepEqual(lines.push('{"a":1}\n{"b"'), ['{"a":1}']);
	assert.deepEqual(lines.push(':2}\r\n\n'), ['{"b":2}\r', ""]);
	assert.deepEqual(lines.push("tail"), []);
	assert.equal(lines.rest(), "tail");
	assert.equal(lines.rest(), "");
});

/* ---- the proxy against a fake service ---- */

interface Seen {
	body: { id?: number; method?: string; params?: { name?: string } };
	protocol: string | undefined;
	elicit: string | undefined;
	path: string;
	answeredIn: string | undefined;
	elicitResult?: string;
	launcher: string | undefined;
}

class Fake {
	version = "0.22.0";
	home: string;
	seen: Seen[] = [];
	/** What to do with a tools/call: answer, or drop the connection after reading it. */
	onCall: "answer" | "reset" | "http500" = "answer";
	/** Whether /mcp answers carry x-rojo-hub-version (an older service sends none). */
	sendHeader = true;
	/** The HTTP status the service gives the user's Move or Decline (409: already answered). */
	answerStatus = 200;
	private server: Server | null = null;

	constructor(
		readonly port: number,
		home: string,
	) {
		this.home = home;
	}

	listen(): Promise<void> {
		return new Promise((done) => {
			this.server = createServer(async (request, response) => {
				if (request.url === "/health") {
					response.writeHead(200, { "content-type": "application/json" });
					return response.end(JSON.stringify({ ok: true, version: this.version, pid: 1, home: this.home }));
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(chunk as Buffer);
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen["body"];
				this.seen.push({ body, protocol: header(request, "mcp-protocol-version"), elicit: header(request, "x-rojo-hub-elicit"), path: request.url ?? "", answeredIn: header(request, "x-rojo-hub-answered-in"), elicitResult: header(request, "x-rojo-hub-elicit-result"), launcher: header(request, "x-rojo-hub-launcher") });
				if (request.url?.startsWith("/studio/requests/")) {
					response.writeHead(this.answerStatus, { "content-type": "application/json" });
					return response.end(this.answerStatus === 200 ? "[]" : JSON.stringify({ error: "That request was already answered, or it ended." }));
				}
				const versioned: Record<string, string> = this.sendHeader ? { "x-rojo-hub-version": this.version } : {};
				if (body.id === undefined) {
					response.writeHead(202, versioned);
					return response.end();
				}
				if (body.method === "tools/call" && this.onCall === "reset") return request.socket.destroy();
				if (body.method === "tools/call" && this.onCall === "http500") {
					response.writeHead(500, { "content-type": "text/plain" });
					return response.end("boom");
				}
				// request_place for a held place: the question for the user comes back only when the launcher said it can ask
				const asking = body.method === "tools/call" && body.params?.name === "request_place" && header(request, "x-rojo-hub-elicit") === "1";
				const result = asking
					? {
							content: [{ type: "text", text: "being asked" }],
							structuredContent: { outcome: "pending" },
							_meta: {
								"rojo-hub/elicit": {
									requestId: "game:111",
									message: "Move Lobby from Other to Game?",
									moved: { text: "The user moved Lobby.", data: { outcome: "moved" } },
									declined: { text: "The user declined.", data: { outcome: "declined" } },
									answered: { text: "Already answered.", data: { outcome: "ended" } },
								},
							},
						}
					: body.method === "initialize"
						? { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rojo-hub", version: this.version }, instructions: "Use serve_here." }
						: body.method === "tools/list"
							? { tools: [{ name: `status-${this.version}`, inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: `ok ${body.params?.name}` }] };
				response.writeHead(200, { "content-type": "application/json", ...versioned });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
			});
			this.server.listen(this.port, "127.0.0.1", () => done());
		});
	}

	close(): Promise<void> {
		return new Promise((done) => {
			const server = this.server;
			this.server = null;
			if (!server) return done();
			server.close(() => done());
			server.closeAllConnections();
		});
	}
}

const header = (request: IncomingMessage, name: string): string | undefined => {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
};

function freePort(): Promise<number> {
	return new Promise((done) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});
}

async function rig(options: { holdMs?: number; startService?: (fake: Fake) => unknown; onWrite?: (message: Record<string, unknown>) => void; elicitMs?: number } = {}) {
	const port = await freePort();
	const home = temp("proxy");
	const fake = new Fake(port, home);
	const out: Record<string, unknown>[] = [];
	let starts = 0;
	const proxy = new Proxy({
		port,
		home,
		cachePath: join(home, "launcher", "cache.json"),
		holdMs: options.holdMs ?? 3000,
		pollMs: 20,
		elicitMs: options.elicitMs,
		startService: () => {
			starts++;
			if (!options.startService) return false;
			// A start takes a moment: the fake comes up shortly after.
			setTimeout(() => void Promise.resolve(options.startService!(fake)), 150);
			return true;
		},
		write: (message) => {
			out.push(message);
			options.onWrite?.(message);
		},
	});
	const send = (message: object) => proxy.handleLine(JSON.stringify(message));
	return { fake, proxy, out, send, starts: () => starts, home };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const call = (id: number, name = "status") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
const textOf = (message: Record<string, unknown>): string => ((message.result as { content: { text: string }[] }).content[0].text);

test("launcher proxy: forwards requests, sends the negotiated protocol version, answers nothing to a notification", async () => {
	const { fake, out, send, proxy } = await rig();
	await fake.listen();
	try {
		await send(initialize);
		assert.equal((out[0].result as { serverInfo: { version: string } }).serverInfo.version, "0.22.0");
		assert.deepEqual((out[0].result as { capabilities: object }).capabilities, { tools: { listChanged: true } }, "the launcher can announce changes whatever the service says");
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send({ jsonrpc: "2.0", id: 2, method: "ping" });
		await send(call(3));
		assert.equal(out.length, 3, "a notification gets nothing back");
		assert.deepEqual(out[1], { jsonrpc: "2.0", id: 2, result: {} }, "ping is answered locally");
		assert.equal(textOf(out[2]), "ok status");
		const methods = fake.seen.map((seen) => seen.body.method);
		assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
		assert.equal(fake.seen[0].protocol, undefined, "initialize carries no version header");
		assert.equal(fake.seen[2].protocol, "2025-06-18", "later calls carry the negotiated version");
		await proxy.handleLine("{not json");
		assert.equal((out[3].error as { code: number }).code, -32700);
	} finally {
		await fake.close();
	}
});

test("launcher proxy: holds a call while the service starts, starting it once", async () => {
	const { fake, out, send, starts } = await rig({ startService: (f) => f.listen() });
	try {
		await Promise.all([send(call(1)), send(call(2, "start"))]);
		assert.equal(starts(), 1, "two calls, one start");
		const texts = out.map(textOf).sort();
		assert.deepEqual(texts, ["ok start", "ok status"]);
	} finally {
		await fake.close();
	}
});

test("launcher proxy: while the service is not up, initialize and tools/list are answered and a call says to retry", async () => {
	const { out, send, home } = await rig({ holdMs: 300, startService: () => true });
	// Nothing cached: a stand-in, never a transport error.
	await send(initialize);
	assert.equal((out[0].result as { protocolVersion: string }).protocolVersion, "2025-06-18");
	assert.match((out[0].result as { instructions: string }).instructions, /starting/);
	await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal((out[1].result as { tools: { name: string }[] }).tools[0].name, "rojohub_starting");
	await send(call(3));
	const failed = out[2].result as { isError: boolean; content: { text: string }[] };
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /still starting[^]*service\.log[^]*Call this again/);
	assert.ok(home);
});

test("launcher proxy: the cache answers while the service starts, and the agent is told when the real list is there", async () => {
	const first = await rig();
	await first.fake.listen();
	await first.send(initialize);
	await first.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	await first.fake.close();

	// A new session (a new launcher, the same home) with the service down and never starting.
	const second = new Proxy({
		port: first.fake.port,
		home: first.home,
		cachePath: join(first.home, "launcher", "cache.json"),
		holdMs: 200,
		pollMs: 20,
		startService: () => true,
		write: (message) => out.push(message),
	});
	const out: Record<string, unknown>[] = [];
	await second.handleLine(JSON.stringify(initialize));
	assert.equal((out[0].result as { instructions: string }).instructions, "Use serve_here.", "the cached instructions");
	assert.equal((out[0].result as { serverInfo: { version: string } }).serverInfo.version, "0.22.0");
	await second.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
	await second.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
	assert.equal((out[1].result as { tools: { name: string }[] }).tools[0].name, "status-0.22.0", "the cached tools");

	// The service comes up with another version; the next call is answered and the agent is told to look again.
	first.fake.version = "0.23.0";
	await first.fake.listen();
	try {
		await second.handleLine(JSON.stringify(call(3)));
		assert.equal(textOf(out[2]), "ok status");
		assert.deepEqual(out[3], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await second.handleLine(JSON.stringify(call(4)));
		assert.equal(out.length, 5, "told once");
	} finally {
		await first.fake.close();
	}
});

test("launcher proxy: no service script found, or another user's service on the port", async () => {
	const none = await rig({ holdMs: 300 });
	await none.send(call(1));
	assert.match(textOf(none.out[0]), /not installed in VS Code \(no dist\/service\.js found\)/);
	assert.equal((none.out[0].result as { isError: boolean }).isError, true);

	const other = await rig({ holdMs: 300, startService: () => true });
	other.fake.home = join(tmpdir(), "someone-else", "RojoHub");
	await other.fake.listen();
	try {
		await other.send(call(1));
		assert.match(textOf(other.out[0]), /another Windows user/);
		assert.equal(other.starts(), 0, "never started over");
		assert.equal(other.fake.seen.length, 0, "and never used");
	} finally {
		await other.fake.close();
	}
});

test("launcher proxy: a refused connection restarts the service and sends the request once more", async () => {
	const { fake, out, send, starts } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	try {
		await send(initialize);
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send(call(2));
		await fake.close(); // killed between two calls
		const before = fake.seen.length;
		await send(call(3));
		assert.equal(textOf(out[out.length - 1]), "ok status", "the second call succeeds");
		assert.equal(starts(), 1);
		assert.equal(fake.seen.length - before, 1, "sent once to the new service");
	} finally {
		await fake.close();
	}
});

test("launcher proxy: a connection that dies after the request was sent is not repeated", async () => {
	const { fake, out, send, starts } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	try {
		await send(initialize);
		fake.onCall = "reset";
		await send(call(2, "switch"));
		const result = out[out.length - 1].result as { isError: boolean; content: { text: string }[] };
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /restarted while this call ran; call status to see whether it took effect/);
		assert.equal(fake.seen.filter((seen) => seen.body.method === "tools/call").length, 1, "the call was not sent again");
		assert.equal(starts(), 0);
	} finally {
		await fake.close();
	}
});

test("launcher proxy: a non-JSON or 5xx answer is an error naming the status, not a restart", async () => {
	const { fake, out, send } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	try {
		await send(initialize);
		fake.onCall = "http500";
		await send(call(2, "switch"));
		const result = out[out.length - 1].result as { isError: boolean; content: { text: string }[] };
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /HTTP 500: boom/);
		assert.doesNotMatch(result.content[0].text, /restarted/);
	} finally {
		await fake.close();
	}
});

test("launcher proxy: tools/list_changed after the service is replaced by another version", async () => {
	const { fake, out, send } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	try {
		await send(initialize);
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		assert.equal((out[1].result as { tools: { name: string }[] }).tools[0].name, "status-0.22.0");
		await fake.close();
		fake.version = "0.23.0"; // the replacement
		await send(call(3));
		assert.equal(textOf(out[2]), "ok status");
		assert.deepEqual(out[3], { jsonrpc: "2.0", method: "notifications/tools/list_changed" }, "sent after the answer");
	} finally {
		await fake.close();
	}
});

test("launcher proxy: a new service version in the answer header is announced without any call failing", async () => {
	const { fake, out, send } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	try {
		await send(initialize);
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const before = out.length;
		await send(call(3));
		assert.equal(out.length, before + 1, "the same version announces nothing");
		fake.version = "0.23.0"; // a new service took the port; the connection never failed
		await send(call(4));
		assert.equal(textOf(out[before + 1]), "ok status");
		assert.deepEqual(out[before + 2], { jsonrpc: "2.0", method: "notifications/tools/list_changed" }, "sent after the answer");
		await send(call(5));
		assert.equal(out.length, before + 4, "and only once");
	} finally {
		await fake.close();
	}
});

test("launcher proxy: an older service without the header is checked through /health", async () => {
	const { fake, out, send } = await rig({ startService: (f) => f.listen() });
	await fake.listen();
	fake.sendHeader = false;
	try {
		await send(initialize);
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const before = out.length;
		await send(call(3));
		assert.equal(out.length, before + 1);
		fake.version = "0.23.0";
		await send(call(4));
		assert.deepEqual(out[before + 2], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	} finally {
		await fake.close();
	}
});

/* ---- request_place asks the user through MCP elicitation (spec 014) ---- */

const placeCall = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "request_place", arguments: { path: "C:\Repo", place_id: 111 } } });
const withElicitation = { ...initialize, params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } } };

/** A client that answers each elicitation/create the way the user would: `answer` is the JSON-RPC result, or "error". */
async function elicitingRig(answer: object | "error" | "never", options: { elicitMs?: number } = {}) {
	const asked: Record<string, unknown>[] = [];
	const holder: { send: (message: object) => Promise<void> } = { send: async () => undefined };
	const made = await rig({
		elicitMs: options.elicitMs,
		onWrite: (message) => {
			if (message.method !== "elicitation/create") return;
			asked.push(message);
			if (answer === "never") return;
			// the user answers later, on another line, while the tool call is still open
			setTimeout(() => void holder.send(answer === "error" ? { jsonrpc: "2.0", id: message.id, error: { code: -1, message: "no" } } : { jsonrpc: "2.0", id: message.id, result: answer }), 10);
		},
	});
	holder.send = made.send;
	await made.fake.listen();
	return { ...made, asked };
}

const resultOf = (message: Record<string, unknown>) => message.result as { content: { text: string }[]; structuredContent?: { outcome: string }; _meta?: unknown };

test("launcher proxy: a client that can be asked gets the question; Move reaches the service marked as given in chat, and the agent hears the outcome", async () => {
	const { fake, out, send, asked } = await elicitingRig({ action: "accept", content: { move: true } });
	try {
		await send(withElicitation);
		await send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await send(placeCall(2));
		assert.equal(fake.seen.find((entry) => entry.body.method === "tools/call")?.elicit, "1", "the service is told the user can be asked");
		assert.equal(asked.length, 1);
		const params = asked[0].params as { message: string; requestedSchema: { properties: { move: { type: string; default: boolean } } } };
		assert.equal(params.message, "Move Lobby from Other to Game?");
		assert.equal(params.requestedSchema.properties.move.type, "boolean");
		assert.equal(params.requestedSchema.properties.move.default, true, "ticked to start with: accepting is Move");
		const answered = fake.seen.find((entry) => entry.path.startsWith("/studio/requests/"));
		assert.equal(answered?.path, "/studio/requests/game%3A111/move");
		assert.equal(answered?.answeredIn, "chat");
		assert.equal(answered?.elicitResult, '{"action":"accept","content":{"move":true}}', "the client's own answer goes to the log");
		const reply = out.find((message) => message.id === 2)!;
		assert.equal(resultOf(reply).content[0].text, "The user moved Lobby.");
		assert.equal(resultOf(reply).structuredContent?.outcome, "moved");
		assert.equal(resultOf(reply)._meta, undefined, "the internal question is not passed on");
	} finally {
		await fake.close();
	}
});

test("launcher proxy: accept is Move whatever the field says, decline declines; cancel, an error and no answer leave the request pending", async () => {
	for (const [answer, path, text] of [
		// field report 2026-10-27: the box started unticked and could not be ticked, so every accept declined
		[{ action: "accept" }, "/studio/requests/game%3A111/move", "The user moved Lobby."],
		[{ action: "accept", content: {} }, "/studio/requests/game%3A111/move", "The user moved Lobby."],
		[{ action: "accept", content: { move: false } }, "/studio/requests/game%3A111/move", "The user moved Lobby."],
		[{ action: "decline" }, "/studio/requests/game%3A111/decline", "The user declined."],
		[{ action: "decline", content: { move: true } }, "/studio/requests/game%3A111/decline", "The user declined."],
	] as const) {
		const { fake, out, send } = await elicitingRig(answer);
		try {
			await send(withElicitation);
			await send(placeCall(2));
			assert.equal(fake.seen.find((entry) => entry.path.startsWith("/studio/requests/"))?.path, path);
			assert.equal(resultOf(out.find((message) => message.id === 2)!).content[0].text, text);
		} finally {
			await fake.close();
		}
	}
	for (const answer of [{ action: "cancel" }, "error", "never"] as const) {
		const { fake, out, send } = await elicitingRig(answer, { elicitMs: 150 });
		try {
			await send(withElicitation);
			await send(placeCall(2));
			assert.equal(fake.seen.filter((entry) => entry.path.startsWith("/studio/requests/")).length, 0, `${JSON.stringify(answer)}: nothing is sent to the service`);
			const reply = resultOf(out.find((message) => message.id === 2)!);
			assert.match(reply.content[0].text, /did not answer the question/);
			assert.match(reply.content[0].text, /being asked/, "the service's own text follows");
			assert.equal(reply.structuredContent?.outcome, "pending");
		} finally {
			await fake.close();
		}
	}
});

test("launcher proxy: a request already answered elsewhere (409) is said so", async () => {
	const { fake, out, send } = await elicitingRig({ action: "accept", content: { move: true } });
	fake.answerStatus = 409;
	try {
		await send(withElicitation);
		await send(placeCall(2));
		const reply = resultOf(out.find((message) => message.id === 2)!);
		assert.equal(reply.content[0].text, "Already answered.");
		assert.equal(reply.structuredContent?.outcome, "ended");
	} finally {
		await fake.close();
	}
});

test("launcher proxy: a client that does not declare elicitation gets no header and no question; other tools never carry it", async () => {
	const asked: unknown[] = [];
	const { fake, out, send } = await rig({ onWrite: (message) => message.method === "elicitation/create" && asked.push(message) });
	await fake.listen();
	try {
		await send(initialize);
		await send(placeCall(2));
		await send({ ...call(3, "status") });
		assert.ok(fake.seen.filter((entry) => entry.body.method === "tools/call").every((entry) => entry.elicit === undefined), "no x-rojo-hub-elicit");
		assert.ok(fake.seen.filter((entry) => entry.path === "/mcp").every((entry) => entry.launcher === SERVICE_VERSION), "every /mcp POST names the launcher's version");
		assert.deepEqual(asked, []);
		assert.equal(resultOf(out.find((message) => message.id === 2)!).content[0].text, "ok request_place");
		// declaring only url elicitation is not form elicitation either
		await send({ ...initialize, id: 9, params: { protocolVersion: "2025-06-18", capabilities: { elicitation: { url: {} } } } });
		await send(placeCall(4));
		assert.equal(fake.seen.filter((entry) => entry.body.id === 4)[0].elicit, undefined);
	} finally {
		await fake.close();
	}
	// and a client that does declare it sends the header for request_place only
	const declared = await rig();
	await declared.fake.listen();
	try {
		await declared.send(withElicitation);
		await declared.send(call(3, "status"));
		assert.equal(declared.fake.seen.find((entry) => entry.body.id === 3)?.elicit, undefined);
	} finally {
		await declared.fake.close();
	}
});
