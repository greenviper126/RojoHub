# 015: ensure brings everything to the current version

Status: built (0.22.11, branch `experimental/feedback-2026-10-24`). From Viper, 2026-10-27: "an mcp
command where the agent can run it and make sure everything is running on the same version it should
be on ... I'd just like to tell agents to run that command to fully set stuff up without telling them
the steps every time." Viper: "do what makes the most sense for the user" (defaults below taken).

## Problem

After an update, four parts can lag behind, and each needs a different step the user has to remember:
VS Code windows (now reload themselves, 0.22.9), open Studio places (keep the plugin they loaded; need
reopening), the agent's own chat connection (keeps its launcher's code until `/mcp` reconnect), and the
service itself (replaced by the first reloaded window). `version` only reports. The user wants one call
an agent can be told to make, "run ensure", that sets everything up and says plainly what is left.

## Design

`ensure` (spec 011) gets a `versions` step, after `serve` (so this agent holds the project's claim)
and before `open_place`.

1. **This project's places with an older plugin are reopened.** The places are the Studio places
   whose plugin reported a version older than `SERVICE_VERSION` (compareVersions) and that are synced
   with this project or assigned/connecting to it (`hub.studio.places()` with `projectId === slot.id`,
   or `syncedWith === slot.projectName`). Saved places only (an unsaved place has no place ID to open).
   - Only with `rojoHub.closePlaces` on. Off: not reopened; the step says which places are older and
     that the user can turn on `rojoHub.closePlaces` or reopen them in Studio. Not a failure: ensure
     goes on with the old plugin (it still syncs).
   - Never a place whose synced project another agent claims (the same guard as `reopen_place`,
     unless `force`). Such a place is listed, not reopened.
   - Reopened with `hub.reopenPlace` (asks Studio to close, as its X does; never kills or saves). Then
     ensure waits, within its `timeout`, until each reopened place says hello again with the current
     plugin. A place still open when the time is up is reported as "waiting on you in Studio (it may be
     asking about unsaved changes)" and ensure goes on; a reopen that failed reports the error. Neither
     is a failure of ensure: the place keeps syncing with its old plugin.
   - Audited like `reopen_place` (`action: "reopen_place"`, `by: "ensure"`), unless yolo.
2. **Other places with an older plugin** (not this project's) are only listed, never touched.
3. **A newer Rojo-Hub installed than the service running.** The service reads each VS Code profile's
   extension list (`%APPDATA%\Code\User\profiles\*\extensions.json` and
   `~\.vscode\extensions\extensions.json`, the shape `src/extension/reload.ts` reads). If any lists a
   version newer than `SERVICE_VERSION`, the step says "Rojo-Hub X is installed but Y is running;
   reload a VS Code window (Developer: Reload Window)". Read-only, best effort: unreadable files are
   skipped.
4. **This chat's connection.** When the connection is outdated (`staleConnection`), the step says the
   user must run `/mcp` and reconnect rojohub, or start a new chat: the one thing no tool can do.
5. Outcome of the step: `done` when something was reopened, `already` when every part is current,
   `skipped` when something needs the user (each item says what). It never makes `ensure` fail and
   never changes `ready`.

The answer's structured content gets `versions: { service, current: boolean, needsUser: string[],
reopened: [{ placeId, name, outcome: "reloaded" | "waiting" | "skipped" (another agent's claim) | "failed", detail }], outdatedElsewhere:
[{ placeId, name, pluginVersion }] }`. The text gets one line per item: ok, fixed, or "needs you: <exact
step>". The `ensure` description and the MCP instructions say ensure also brings Rojo-Hub's parts to the
current version, so "run ensure" is the whole instruction.

## Acceptance

1. With closePlaces on, an older-plugin place synced with this project is reopened, and ensure reports
   it reloaded once the place says hello with the current version.
2. With closePlaces off, it is listed with the step to take; nothing is closed.
3. A place whose project another agent claims is not reopened without force.
4. Another project's outdated place is listed only.
5. A newer version in a profile's extensions.json is reported with the reload step; an older or equal
   one is not; unreadable lists are skipped.
6. An outdated connection is reported with the /mcp step.
7. Everything current: `versions.current: true`, one "all on X" line, no extra wait.
8. The step never turns a ready ensure into a failure.

## Non-goals

- Reloading VS Code windows from the service (they reload themselves; 0.22.9).
- Fixing the agent's own connection (only the user can).
- Saving Studio places, or closing anything without `rojoHub.closePlaces`.
