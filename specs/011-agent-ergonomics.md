# 011 — Agents that always connect, get ready in one call, and read the answer

Status: **draft** (review group B of `specs/feedback-2026-10-24.md`, items 1, 17, 2, 18, 20, 10, 7, 16).
Asked for by Viper's agents in the 2026-10-24 feedback session. Builds on 004 (agent access), 008
(agent control) and 009 (open places). Version bump on release: 0.22.0 (the service changes).

## Problem

1. **An agent session that starts while the service is down has no Rojo-Hub for its whole life.**
   Agents' configs point at `http://127.0.0.1:34870/mcp` (`AGENT_CLIS` in `src/common/agents.ts`,
   written by `agentConfig.ts`). The service is started only by an open VS Code window
   (`ensureService` in `src/extension/client.ts`) and exits after 15 minutes with nothing serving
   and no window subscribed (`IDLE_EXIT_MS`, `main.ts`). A Claude Code or Codex session begun in a
   terminal or Orca with VS Code closed, or just after an update replaced the service, connects to
   nothing, marks the server failed, and does not retry until the user runs `/mcp`.
2. **Getting ready takes four to six calls.** `start`, `serve_here`, `open_place`, `wait_for_studio`
   in the right order, each answer read to decide the next. Agents get the order wrong, or stop and
   ask the user.
3. **Answers are prose only.** An agent that wants the place ID, the claim's expiry or the served
   commit has to parse sentences written for reading (`health()`, `status()` in `mcp.ts`).

## Design

### 1. A stdio launcher (items 1, 17)

**Built** (open questions 1 to 3 at their defaults). Measured: a script run as
`Code.exe <script>` with `ELECTRON_RUN_AS_NODE=1` and `windowsHide`, spawned from node, speaks JSON
lines over stdin/stdout on Windows (it reported Electron 43.7 / Node 24.21). Changes from this text:
`claude mcp add -e` takes any number of values, so with the name right after it the CLI fails
("missing required argument"); the entry is added as `claude mcp add --transport stdio -e
ELECTRON_RUN_AS_NODE=1 --scope user rojohub -- <Code.exe> <launcher>` (measured against a throwaway
config; Codex as written). The shell that starts the agent CLIs on Windows quotes arguments with
spaces (`Microsoft VS Code`). The launcher opens a new connection per request (no keep-alive pool): a
pooled connection to a service that exited fails with a reset, which looks like a call that died
halfway, and killing the service between two calls must be retried. The service rewrites legacy and
stale entries at start except when `ROJO_HUB_HOME` is set (tests), so a test service never touches a
real agent config; the launcher announces `tools: { listChanged: true }` itself, whatever the service
says. The unit tests are in `src/test/launcher.test.ts`.

Agents point at a small program instead of the URL. It speaks MCP over stdio to the agent, and
forwards each message to the service's `/mcp`, starting the service first when nothing answers. The
service stays as it is (streamable HTTP, JSON answers, no sessions); `/mcp` is unchanged, so VS Code's
own provider (`registerMcpServerDefinitionProvider`, which already starts the service in `resolve`)
and hand-made URL entries keep working.

**Because the service keeps no MCP session, the launcher keeps none either.** It is a line reader
(newline-delimited JSON-RPC on stdin) that POSTs each request to `/mcp` and writes the answer to
stdout; a notification gets nothing back. Everything below follows from that.

**Where it lives.** A new bundle `dist/mcp-stdio.js` (`src/launcher/main.ts`, node20, cjs, no
dependencies beyond `src/common/*`; one more entry in `build.mjs`). Agent configs cannot point into
the extension's folder (it changes with every version, and the old one is deleted), so the service
copies the bundle on start to `%LOCALAPPDATA%\RojoHub\launcher\rojohub-mcp.cjs` (write to a
temporary name, rename; a failed rename because a session holds the file is retried on the next
start). The first line is `// rojo-hub-launcher <version>`; a service never replaces a newer
launcher with an older one. The launcher only uses `/health` and `/mcp`, whose shape later versions
keep, so an old launcher in an old session works with a new service.

**Runtime.** Node may not be installed. The entry's command is the service's own `process.execPath`
(Code.exe, or the editor the extension runs in) with `ELECTRON_RUN_AS_NODE=1` in the entry's env,
exactly how the service is started today. The service writes the entry, so the path is the one that
is known to work now.

- Claude Code: `claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 rojohub -- <Code.exe> <launcher>`.
- Codex: `codex mcp add rojohub --env ELECTRON_RUN_AS_NODE=1 -- <Code.exe> <launcher>`.
- The `Copy setup commands` text and the setup prompt show the stdio form first, the URL form as the
  alternative for agents that only take a URL. `AGENT_CLIS` gains the launcher path and command, so
  the panel, the service and the uninstall hook still share one definition.

**State.** `agentState` today compares the entry's `url` with `MCP_URL`. It now knows three shapes
of an entry named `rojohub`: the launcher (stdio, args end in `launcher/rojohub-mcp.cjs` under this
Windows user's hub home) is `connected`; the old URL entry that equals `MCP_URL` is `legacy`; anything
else is `other` and never touched, as now. A launcher entry whose command or script no longer exists
(VS Code moved, folder deleted) is `stale`. When the service starts, and on the panel's reconcile,
`legacy` and `stale` entries are rewritten to the current launcher entry (remove, then add, through
the agent's own CLI, in the registrar's queue). Readers: `~/.claude.json` `mcpServers.rojohub`
(`command`, `args`, `env`) and `config.toml` `mcp_servers.rojohub`, both already parsed.

**Finding the service to start.** Only when `/health` gets no answer. It looks for
`dist/service.js` in, newest version first: the hint file `launcher\service.json` (`{ version,
script }`, written by `ensureService` every time the extension starts a service, which covers
development hosts and portable installs); then `<ext dir>\greenviper126.rojo-hub-<semver>[-<platform>]`
in `~\.vscode\extensions`, `~\.vscode-insiders\extensions`, `~\.vscode-oss\extensions`,
`~\.cursor\extensions`, `~\.windsurf\extensions`, and `VSCODE_EXTENSIONS`. Extensions are shared by
every profile (profiles only choose which are enabled), so the profile does not matter. The highest
version with an existing `dist/service.js` wins (`compareVersions`, `src/common/version.ts`);
`ROJO_HUB_SERVICE` overrides it, for tests. None found: the launcher says so (below).

**Never an older service.** The launcher only starts a service when nothing answers, never replaces
or shuts down a running one (upgrading a service stays the extension's job, `ensureService`), and
starts the newest one it finds. Two launchers or a window racing to start are harmless: the second
service gets `EADDRINUSE` and exits quietly (`main.ts`). A service of another Windows user on the
port (`/health` home differs, as `ours()` checks in `client.ts`) is never started over or used; the
answer says so.

**What it answers while the service is starting.** It never fails the connection.
- `initialize`: forwarded; if the service is not up within 20 s, answered locally with the
  protocol version asked for, `tools: { listChanged: true }`, the last `instructions` seen
  (cached in `launcher\cache.json`, or a one-line text), and `serverInfo` version from the cache.
- `tools/list`: forwarded; if not up within 20 s, the cached list, else a single tool
  `rojohub_starting` that says the hub is starting and to retry. When the service answers later and
  its list differs from what the agent was given, the launcher sends `notifications/tools/list_changed`.
- `tools/call`: held up to 20 s while the service starts (agents' own timeouts are 30 to 60 s); then
  an `isError` result: "Rojo-Hub's service is not running and is still starting (see service.log in
  %LOCALAPPDATA%\RojoHub). Call this again in a few seconds." No service script found: "Rojo-Hub is
  not installed in VS Code (no dist/service.js found). Install or reinstall the extension."
- `ping`: answered locally.

**A restart in mid-session** (idle exit, version upgrade by a window, a crash). The next `/mcp` call
is refused at the socket. A refused connection means the request never reached the service, so the
launcher starts the service again if still nothing answers and sends the same request once more. A
connection that dies after the request was sent (the service shut down during a `switch`) is not
retried, since the call may have happened: the result is `isError` "Rojo-Hub's service restarted
while this call ran; call status to see whether it took effect." After any reconnect, the service's
`serverInfo.version` from `/health` is compared with the last seen; if it changed, `tools/list_changed`
is sent. The launcher also sends the `MCP-Protocol-Version` header it negotiated, so the service can
tell which clients understand `outputSchema` (design 3).

**End of the agent.** stdin closing ends the launcher. It never stops the service.

**Uninstall.** The hook (`src/extension/uninstall.ts`) already removes any `connected` entry through
the agent's CLI; it now does the same for `connected`, `legacy` and `stale`, in that order before
stopping the service, then deletes `%LOCALAPPDATA%\RojoHub\launcher\` (a running session's open file
does not block deleting on Windows; one that does is left, harmlessly). An entry named `rojohub` of
another shape stays. If the agent's CLI is gone the existing message about removing it by hand
applies, with the stdio entry described.

### 2. `ensure`: get me ready in one call (items 2, 18, 20, 10)

One new tool, `ensure`, for an agent about to check its worktree in Studio. Arguments: `path`
(required, the working directory), `project`, `place` (a place ID, for projects with several),
`timeout` (seconds to wait for Studio, default 60, 5 to 300), `wait` and `force` (as `serve_here`).
It runs these steps in order, each only if its condition holds, so a second call does nothing it
need not and only renews the claim. It composes the existing code, adding no new hub operation:

1. **Pick** the project: `Mcp.pick` (by `project`, else the repo `path` is in). Fails as every tool does.
2. **start**: when the project is `stopped` or `error`, `hub.start(id)` (as the `start` tool), then
   `settled`. Skipped when running or starting.
3. **claim and serve**: `Mcp.take` with the worktree target (as `serve_here`): `waitTurn`, `checkClaim`,
   `setClaim`, `hub.switch`. No change when it already serves this worktree; the claim is renewed.
   Then `settled`, `problems` and `unapplied` as `serve_here` reports them.
4. **open_place**: only when no Studio place is synced (`slot.places` empty) and none is already
   connecting or waiting for the user to accept (`hub.studio.places()` with this `projectId`), and
   `hub.openPlacesOn`. The place is `place`, or the only one in `slot.listedPlaces`; `hub.openPlace`
   (never a second copy of an open place). If `openPlacesOn` is off the step is skipped and the answer
   says the user must open the place, quoting `OFF_MESSAGE`; the call then returns at once rather
   than wait for a human.
5. **wait_for_studio**: the loop of `waitForStudio`, moved into a private method both tools use:
   returns when a place is synced, when a place waits for the user to accept the first sync, when the
   project stopped, or at `timeout`.
6. **Answer**: the synced places (name, place ID, why, plugin version) and the project state.

Nothing is rolled back on a failure: the steps done stay done (a later call finds them done), and
the answer lists them. Failures, each with a `failure.reason` and a message that says what to do:

| reason | when | answer says |
| --- | --- | --- |
| `no_project` | pick failed (repo not registered, several projects) | the `add_project` or `project` hint (isError, no steps ran) |
| `start_failed` | `hub.start` threw or the project is `error` after settling | Rojo's error lines; nothing was served |
| `claimed` | another worktree holds the claim, `wait` (if any) ran out | holder, expiry, the `wait`/`force` hint; project not switched |
| `rojo_error` | after the switch Rojo reports an error | the lines of `problems`; the switch was made |
| `open_places_off` | no place synced and `rojoHub.openPlaces` off | ask the user to open a listed place; lists them |
| `no_listed_places` | no place synced, project file names none | ask the user to open the place |
| `several_places` | several listed, `place` not given | the list; call again with `place` |
| `open_failed` | `hub.openPlace` threw | the error; places that are open already |
| `studio_confirming` | a place waits for the user to accept the first sync | ask the user to accept it in Studio |
| `timeout` | nothing synced in `timeout` seconds | what is connecting; call `wait_for_studio` |
| `stopped` | the project stopped during the wait | someone stopped it; the files were switched |

`ready` is true only with the project running, serving this worktree and at least one place synced.
Install and dependency checks (item 10's Packages, node_modules) are not part of it (group D).

### 3. Structured answers (items 7, 16)

The repo has no MCP SDK (`package.json` lists none, and `node_modules` has none): `mcp.ts` is a
hand-written JSON-RPC handler. So `structuredContent` and `outputSchema` are written by hand, which
the protocol allows from 2025-06-18; `PROTOCOL_VERSIONS` already includes it. The text stays exactly
as it is, in `content[0]`, for every client (the spec asks for it).

- `Mcp.call` returns `{ text, data? }` instead of a string; `handle` puts `data` in `structuredContent`.
- `status`, `serve_here`, `switch` and `ensure` declare an `outputSchema` (JSON Schema, below). Other
  tools stay text.
- Older clients: a client that sent the `MCP-Protocol-Version` header with 2025-06-18 or later gets
  `outputSchema` in `tools/list` and `structuredContent` in results; any other gets neither (the
  stdio launcher sends the header; a client with no header is 2025-03-26 or older). Text is always there.
- An `isError` result of `ensure` also carries `structuredContent` (the spec permits it), so the
  failure reason is machine-readable.

**ProjectState** (the shared piece), one per project:

```
{
  id: string, name: string, port: integer, repoPath: string, projectFile: string,
  rojo: { state: "running"|"starting"|"stopped"|"error", error: string|null, sessionId: string|null, connections: integer },
  served: { kind: "worktree"|"branch", label: string, path: string|null, branch: string|null, commit: string|null },
  claim: { holder: string, until: string /* ISO 8601 UTC */, secondsLeft: integer, yours: boolean|null }|null,
  places: [{ placeId: integer, name: string, pluginVersion: string, reason: string|null, saved: boolean }],
  connecting: [{ placeId: integer, name: string, confirming: boolean }],
  listedPlaces: [{ placeId: integer, name: string|null, open: boolean }],
  sourcemap: { state: "watching"|"off"|"error", detail: string },
  warnings: string[],
  yourWorktreeServed: boolean|null      // null when no path was given
}
```

`served.commit` is the full commit hash of the served worktree's HEAD, or of the branch's ref for a
read-only copy; read with `git rev-parse` (parallel for all projects, 2 s timeout each, `null` on
failure). `places` are the synced places (`slot.places`); a place with no Roblox ID has `placeId` 0
and `saved: false`. `claim.yours` is true when the caller's `path` holds it. Required: every field
except as marked nullable; `additionalProperties` allowed so later versions may add fields.

**Per tool** (`data` of):
- `status`: `{ projects: ProjectState[], groups: [{ id, name, active, projectIds: string[] }], studioPlaces: [{ placeId, name, saved, syncedWith: string|null, pluginVersion }], yourProject: string|null }`
- `serve_here` and `switch`: `{ project: ProjectState, switched: boolean, problems: string[], unapplied: [{ placeId, placeName, total, items: string[] }] }`
  (`switched` is false when the project already served the target; `problems` are Rojo's error lines and the card's warnings.)
- `ensure`: `{ ready: boolean, steps: [{ step: "start"|"serve"|"open_place"|"wait_for_studio", outcome: "done"|"already"|"skipped"|"failed", detail: string }], project: ProjectState, placeIds: integer[], failure: null | { reason: <the table's codes>, message: string } }`

## Acceptance criteria

1. With the service stopped, starting a Claude Code session (user-scope `rojohub` entry from this
   spec) lists Rojo-Hub as connected, and `status` answers once the service is up, within 30 s of the call.
2. The entry's command works with no Node on PATH (Code.exe with `ELECTRON_RUN_AS_NODE=1`), for Claude
   Code and Codex; both CLIs' `remove` takes it out.
3. With several extension versions installed, the launcher starts the one with the highest version; with
   a service of any version already answering, it starts nothing and sends no `/shutdown`.
4. With the service down, `initialize` and `tools/list` are answered (live, or from the cache) and
   never close the connection; a `tools/call` is held up to 20 s, then returns an `isError` text that says
   to retry, not a transport error.
5. Killing the service between two calls: the second call succeeds (the launcher restarts it); a service
   shut down during a call yields the "restarted while this call ran" result, never a silent repeat.
6. After the service is replaced by another version, the agent receives `tools/list_changed`.
7. Entries: a `legacy` (URL) entry of Rojo-Hub is rewritten to the launcher; an entry named `rojohub`
   with another URL or command is never changed or removed; a `stale` one is rewritten.
8. Uninstalling removes the launcher entry from both agents and deletes the `launcher` folder.
9. `ensure` on a stopped project with the worktree unserved and a listed place closed (openPlaces on)
   starts it, serves the worktree, opens the place, waits, and returns `ready: true` with the place ID
   in `placeIds`; a second call returns `ready: true` with every step `already`.
10. Each row of the failure table is returned with its `reason`, and the steps done before it.
11. With `openPlaces` off and no place synced, `ensure` returns at once with `open_places_off`, having
    started and served; it never calls `hub.openPlace`.
12. `status`, `serve_here`, `switch` and `ensure` return `structuredContent` that validates against
    their `outputSchema`, with the unchanged text beside it, to a client that sent protocol 2025-06-18;
    a client without that header gets the old shape exactly.
13. `status.projects[].served` has path, branch and a commit hash for a worktree; `claim` has holder,
    expiry and `secondsLeft`; `places` the synced place IDs.

## Non-goals

- Install and dependency checks in `ensure` (Packages, node_modules, Wally): group D, item 10.
- Closing Studio places, choosing which project a place syncs with, or opening a place when
  `rojoHub.openPlaces` is off.
- Changing VS Code's own provider to stdio, an MCP session, event streams or server-sent
  notifications beyond `tools/list_changed`.
- Structured output for the other tools; `yolo` state in `status` (spec for the toggles).
- Starting the service from anywhere else (login item, scheduled task), or restarting it for an upgrade.
- Supporting agents other than Claude Code and Codex in the registrar; others use the copied snippet.

## Open questions for Viper

1. Rewrite existing URL entries to the launcher automatically (own entries only)? Default: yes, at
   service start and reconcile; the URL form stays documented as the manual alternative.
2. Launcher runtime: Code.exe from the service's `process.execPath` (default), or `node` when it is
   on PATH at registration time? Default: Code.exe; a stale path is rewritten on the next service start.
3. How long a call is held while the service starts? Default: 20 s, then a retry message.
4. `ensure` with several listed places and no `place`: open none and list them (default), or open all
   of them (as the panel's open-all)?
5. `ensure` when `openPlaces` is off and no place is open: return at once (default), or wait the full
   `timeout` in case the user opens it?
6. Add a `dirty` flag to `served` (uncommitted changes in the served worktree)? Default: no.
7. Claim expiry in `structuredContent` is the hold of the day (15 min from feedback item 11, on this
   branch). Default: the schema carries `until` and `secondsLeft`, whatever the hold is.

## Test plan

**Unit** (`src/test/unit.test.ts`, node:test):
- Version scan of the launcher against a temporary extensions folder (several versions, a platform
  suffix, one without `dist/service.js`, the hint file, `ROJO_HUB_SERVICE`), and "never older than the
  one running".
- `agentState` for each entry shape (launcher, legacy URL, other URL, other command, stale), in the
  JSON and TOML readers; `AGENT_CLIS` add/remove argument lists; setup text.
- The launcher's proxy against a fake HTTP `/mcp` and `/health` server: line framing, notifications,
  hold-then-answer while the fake starts, refused-connection retry once, reset mid-call not retried,
  `tools/list_changed` on a version change, cache fallback.
- `outputSchema` per tool is valid JSON Schema, and a built answer matches it (a small checker for
  `type`, `required`, `enum`, nullable; no new dependency). `handle` gives text only without the header.
- `served.commit` on a temp git repo (worktree and branch ref, failure gives null).
- `ensure` against the real `Hub` with a stub rojo/places as the existing `mcp` tests do: each table
  row, idempotence, `openPlacesOn` off never opens.

**End-to-end** (real rojo 7.7 and a temp repo, as `npm test` does): `ensure` on a stopped project then a
second call; claim refusal; the structured `status` of a served worktree (path, branch, commit, claim).

**Smoke** (`tools/smoke-bundle.cjs`, throwaway home and port): run `dist/mcp-stdio.js` with
`ROJO_HUB_SERVICE=dist/service.js` and no service up; send `initialize`, `tools/list`, `tools/call
status` over stdin; check the service came up and answered; kill it and call again; run
`dist/uninstall.js` against the throwaway home and check the launcher folder is gone.

**Needs a real Studio and real agents (to be reported plainly if not done):** a Claude Code session and
a Codex session started with VS Code closed, using the registered entry (Code.exe as Node, `claude mcp
list` shows connected); `ensure` with `openPlaces` on opening a real place and returning its ID; the
confirm-first-sync case; a service upgrade by a second window during a session.
