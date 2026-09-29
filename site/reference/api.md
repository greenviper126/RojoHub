# Local API

The background service speaks JSON over HTTP on `127.0.0.1:34870`. The extension is its only
client; the API is listed here for scripts and debugging. It is not a stable public interface and may
change between versions.

::: warning Local programs only
The service answers only requests addressed to `127.0.0.1:34870`, `localhost:34870` or
`[::1]:34870`, and not from a web page (no `Origin`, or VS Code's own `vscode-…://` one). Anything
else is refused with 403. See [Security](/guide/service#security).
:::

```sh
curl http://127.0.0.1:34870/health
```

## Service

| Method and path | Body | Does |
|---|---|---|
| `GET /health` | | Service version, pid, state folder |
| `GET /events` | | A stream (`text/event-stream`) of `{ slots, groups, order }`: once at once, then on every change, within 150 ms |
| `PUT /settings` | `{ portRange?, excludedPorts?, sourcemaps?, studioPlugin?, studioAutoConnect?, openPlaces? }` | Settings (sent by the extension). Replaces them all: a missing field goes back to its default. |
| `POST /shutdown` | `{ stopServing? }` | Stop the service, optionally its Rojo processes too |
| `POST /stop-all` | | Stop every serving project and mark every group stopped |
| `GET /order` | | The panel's display order: `{ projects, groups }` |
| `PUT /order` | `{ projects?, groups? }` | Save a new display order (never changes a port) |

## Projects

In the API a project is a *slot*.

| Method and path | Body | Does |
|---|---|---|
| `GET /slots` | | Every project with its state |
| `POST /slots` | `{ path, projectFile? }` | Register the repo containing `path`; without `projectFile`, its `default.project.json` or only `*.project.json` |
| `DELETE /slots/:id` | | Remove a project |
| `GET /slots/:id/port-moves-on-remove` | | Which projects would move back to their own port if this one were removed: `[{ id, projectName, from, to, serving }]` |
| `PUT /slots/:id/project-file` | `{ projectFile }` | Serve another `*.project.json` of the folder (a serving project is stopped and started again; the panel only offers it while stopped) |
| `POST /slots/:id/start` | | Start serving |
| `POST /slots/:id/stop` | | Stop serving |
| `GET /slots/:id/targets` | | Worktrees and branches it can serve, from the service's cache |
| `POST /slots/:id/fetch` | | `git fetch --all --prune`, then the fresh list |
| `POST /slots/:id/switch` | `{ target }` | `target` is `{ kind: "worktree", path }` or `{ kind: "branch", ref }`. Clears any agent claim. |
| `POST /slots/:id/places/:placeId/open` | | Open one of the project's places in Studio, unless it is open (`outcome`: `opened` or `already-open`). Refused (409) while `rojoHub.openPlaces` is off |
| `POST /slots/:id/places/:placeId/close` | | Ask that place's Studio window to close; Studio still asks about unsaved changes |
| `POST /slots/:id/places/:placeId/reopen` | | Close it, then open it again once that Studio has exited |
| `POST /slots/:id/places/open-all` | | Open each of the project's places that is not open |
| `POST /slots/:id/branch` | `{ name, base }` | A new branch in a worktree of its own (Orca's, else beside the repo), and switch to it |
| `POST /slots/:id/build` | `{ output }` | `rojo build` of what the project serves into `output`, an absolute `.rbxl` or `.rbxlx` path |
| `POST /slots/:id/sourcemap` | | Write the served worktree's `sourcemap.json` once |

## Groups

| Method and path | Body | Does |
|---|---|---|
| `GET /groups` | | Every group |
| `POST /groups` | `{ name, slotIds?, groupIds? }` | Create a group |
| `PUT /groups/:id` | `{ name?, slotIds?, groupIds? }` | Rename or change members; `groupIds` that would loop are refused (409) with the chain |
| `DELETE /groups/:id` | | Delete a group |
| `POST /groups/:id/start` | `{ only? }` | Start; `only` also stops projects outside it and marks other groups stopped (agents' `start_group only`; the panel no longer offers it) |
| `POST /groups/:id/stop` | | Stop the group; the result lists projects `kept` because another running group holds them |

## Agents

| Method and path | Body | Does |
|---|---|---|
| `GET /agents` | | Claude Code's and Codex's registration: installed, `connected` / `absent` / `other` / `unknown` (config can't be read), last error |
| `PUT /agents` | `{ claudeCode?, codex? }` | `true` adds Rojo-Hub to that agent's user config, `false` takes it out; an agent that is not installed, `other` or `unknown` is left alone |
| `POST /mcp` | JSON-RPC | The MCP server for agents (see [Agents](/guide/agents)): one request per POST, answered with plain JSON; a notification gets 202. Other HTTP methods get 405. |

## Errors

| Status | Meaning |
|---|---|
| 400 | A missing or wrong field in the body |
| 403 | Refused: not addressed to the loopback address and port, or sent from a web page |
| 404 | No such project, group or route, or a folder or file that does not exist |
| 409 | Conflict, for example a group loop, a duplicate name, a port problem or a missing Rojo |
| 500 | Anything else, such as a body that is not valid JSON |

Errors come back as `{ "error": "‹message›" }`.
